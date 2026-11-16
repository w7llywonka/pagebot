import assert from 'node:assert/strict';
import test from 'node:test';
import { readRouterStream } from '../lib/router-stream.js';

const event = value => `data: ${JSON.stringify(value)}\n\n`;
const text = value => ({ choices: [{ delta: { content: value } }] });
const finish = reason => ({ choices: [{ delta: {}, finish_reason: reason }] });
async function* chunks(...parts) { for (const part of parts) yield typeof part === 'string' ? Buffer.from(part) : part; }
const state = () => ({ usage: null, sources: [] });

test('SSE fragments, split UTF-8, CRLF, comments, and a final event without a newline preserve text and accounting', async () => {
  const citation = { url: 'https://example.test/article', title: 'Article' };
  const usage = { prompt_tokens: 42, completion_tokens: 12, cost: .0001 };
  const wire = Buffer.from(': OPENROUTER PROCESSING\r\n\r\n' + event(text('Hello 🐸')).replaceAll('\n', '\r\n') +
    event({ choices: [{ delta: { annotations: [{ type: 'url_citation', url_citation: citation }] } }] }) +
    event(finish('stop')) + `data: ${JSON.stringify({ usage })}`);
  const pieces = []; for (let i = 0; i < wire.length; i += 3) pieces.push(wire.subarray(i, i + 3));
  const s = state(), output = [];
  assert.equal(await readRouterStream(chunks(...pieces), s, v => output.push(v)), 'end_turn');
  assert.equal(output.join(''), 'Hello 🐸');
  assert.deepEqual(s.usage, usage); assert.deepEqual(s.sources, [citation]);
});

test('one SSE event may contain multiple data lines and use bare CR line endings', async () => {
  const output = [];
  const wire = 'event: message\rdata: {"choices":\rdata: [{"delta":{"content":"All parts"}}]}\r\rdata: [DONE]';
  assert.equal(await readRouterStream(chunks(wire), state(), v => output.push(v)), 'end_turn');
  assert.deepEqual(output, ['All parts']);
});

test('the provider terminal event finalizes a response even without a trailing newline', async () => {
  for (const [reason, stop] of [['stop', 'end_turn'], ['length', 'max_tokens'], ['content_filter', 'refusal'], ['custom_stop', 'custom_stop']]) {
    assert.equal(await readRouterStream(chunks(`data: ${JSON.stringify(finish(reason))}`), state(), () => {}), stop);
  }
});

test('[DONE] ends reading immediately so an open transport cannot hold a completed answer', async () => {
  let returned = false;
  async function* transport() {
    try { yield Buffer.from(event(text('Done')) + 'data: [DONE]\n\n'); throw new Error('must not read after completion'); }
    finally { returned = true; }
  }
  assert.equal(await readRouterStream(transport(), state(), () => {}), 'end_turn');
  assert.equal(returned, true);
});

test('premature EOF is an interruption and preserves text, usage, and sources already received', async () => {
  const s = state(), output = [], usage = { prompt_tokens: 100, completion_tokens: 2 };
  await assert.rejects(readRouterStream(chunks(event(text('A partial answer')), event({ usage })), s, v => output.push(v)), /interrupted before the answer finished/);
  assert.deepEqual(output, ['A partial answer']); assert.deepEqual(s.usage, usage);
  await assert.rejects(readRouterStream(chunks(), state(), () => {}), /interrupted/);
  await assert.rejects(readRouterStream(null, state(), () => {}), /interrupted/);
});

test('malformed events are reported instead of silently dropping part of an answer', async () => {
  const output = [];
  await assert.rejects(readRouterStream(chunks(event(text('Before')), 'data: {broken}\n\n', event(finish('stop'))), state(), v => output.push(v)), /unreadable response/);
  assert.deepEqual(output, ['Before']);
});

test('provider errors after streaming retain their status for the existing friendly error handling', async () => {
  const output = [], s = state(), usage = { prompt_tokens: 50, completion_tokens: 1 };
  await assert.rejects(readRouterStream(chunks(event(text('Before')), event({ usage, error: { code: 429, message: 'Provider rate limited' } })), s, v => output.push(v)),
    e => e.router === true && e.status === 429 && e.message === 'Provider rate limited');
  assert.deepEqual(output, ['Before']); assert.deepEqual(s.usage, usage);
});

test('transport failures retain partial output while user cancellation remains cancellation', async () => {
  const output = [];
  const failure = new TypeError('terminated');
  async function* broken(error) { yield Buffer.from(event(text('Before'))); throw error; }
  await assert.rejects(readRouterStream(broken(failure), state(), v => output.push(v)), e => e.router && e.cause === failure && /interrupted/.test(e.message));
  assert.deepEqual(output, ['Before']);
  const abort = new DOMException('Cancelled', 'AbortError');
  await assert.rejects(readRouterStream(broken(abort), state(), () => {}), e => e === abort);
});

// Real fetch() responses expose a Web ReadableStream rather than the async generators above.
test('the reader consumes and cancels a Web ReadableStream response', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(event(text('Web stream')) + 'data: [DONE]\n\n')); },
    cancel() { cancelled = true; },
  }));
  const output = [];
  assert.equal(await readRouterStream(response.body, state(), value => output.push(value)), 'end_turn');
  assert.deepEqual(output, ['Web stream']); assert.equal(cancelled, true);
});

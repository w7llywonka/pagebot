import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAI, responseInput, responseParams } from '../lib/openai.js';

const params = { model: 'gpt-6-luna', system: 'Help with the page.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } }] }],
  max_tokens: 1024, output_config: { effort: 'low' } };
const textItem = (text = '', annotations = []) => ({ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations }] });
const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 15, output_tokens_details: { reasoning_tokens: 5 } };
const completed = (output = [textItem('Hello 🌙')], extra = {}) => ({ type: 'response.completed', response: { id: 'resp_1', model: params.model, status: 'completed', output, usage, ...extra } });
const opening = [
  { type: 'response.created', response: { id: 'resp_1', model: params.model, status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { ...textItem(), content: [] } },
  { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
];
const delta = text => ({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text });
function fixture(events, { chunk = 7, status = 200 } = {}) {
  const calls = [];
  const bytes = new TextEncoder().encode(events.map(e => `: keepalive\r\nevent: ${e.type}\r\ndata:${JSON.stringify(e)}`).join('\r\n\r\n'));
  const fetch = async (url, init) => {
    calls.push({ url, ...init, body: JSON.parse(init.body) });
    const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk)); c.close(); } });
    return new Response(body, { status });
  };
  return { client: createOpenAI({ apiKey: 'fixture-key', fetch }), calls };
}

test('Responses uses OPENAI auth and streams split UTF-8/SSE through the existing panel protocol', async () => {
  const { client, calls } = fixture([...opening, delta('Hello '), delta('🌙'), completed()]);
  const stream = client.stream(params), chunks = [];
  stream.on('text', t => chunks.push(t));
  const final = await stream.finalMessage();
  assert.equal(chunks.join(''), 'Hello 🌙');
  assert.equal(final.stop_reason, 'end_turn');
  assert.equal(final.usage.input_tokens, 60);
  assert.equal(final.usage.cache_read_input_tokens, 40);
  assert.equal(final.usage.output_tokens, 15); // includes reasoning; don't count it twice
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].headers.Authorization, 'Bearer fixture-key');
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.max_output_tokens, 1024);
  assert.deepEqual(calls[0].body.reasoning, { effort: 'low' });
  assert.ok(!JSON.stringify(calls[0].body).includes('cache_control'));
});

test('page text, screenshot annotations, PDF files and past messages become valid Responses inputs', () => {
  const input = responseInput([
    { role: 'assistant', content: 'Past reply' },
    { role: 'user', content: [{ type: 'text', text: '<page>Page text</page>\n<annotated_screenshot>Marked</annotated_screenshot>' },
      { type: 'image', source: { media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'document', title: 'notes.pdf', source: { media_type: 'application/pdf', data: 'JVBERi0=' } }] },
  ]);
  assert.equal(input[0].content, 'Past reply');
  assert.deepEqual(input[1].content.map(b => b.type), ['input_text', 'input_image', 'input_file']);
  assert.equal(input[1].content[1].image_url, 'data:image/png;base64,aGVsbG8=');
  assert.equal(input[1].content[2].file_data, 'data:application/pdf;base64,JVBERi0=');
  assert.equal(input[1].content[2].filename, 'notes.pdf');
});

test('page actions map only supported tools and preserve reasoning, call ids and screenshots across rounds', async () => {
  const tools = [{ type: 'browser_toolset_20260801' }, { name: 'highlight', description: 'Highlight quotes', input_schema: { type: 'object' } }];
  const raw = [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-only' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'left_click', arguments: '{"target":{"type":"ref","ref":"ref_12"}}', status: 'completed' }];
  const { client, calls } = fixture([completed(raw)]);
  const stream = client.stream({ ...params, tools });
  const final = await stream.finalMessage();
  assert.equal(final.stop_reason, 'tool_use');
  assert.deepEqual(final.content[0], { type: 'tool_use', id: 'call_1', name: 'left_click', toolset_name: 'browser', input: { target: { type: 'ref', ref: 'ref_12' } } });
  const offered = calls[0].body.tools.map(t => t.name);
  assert.ok(offered.includes('screenshot') && offered.includes('read_page') && offered.includes('form_input') && offered.includes('highlight'));
  assert.ok(!offered.includes('javascript_exec') && !offered.includes('navigate') && !offered.includes('key'));
  assert.equal(calls[0].body.parallel_tool_calls, false);
  assert.deepEqual(calls[0].body.include, ['reasoning.encrypted_content']);
  const input = responseInput([{ role: 'assistant', content: final.content, openaiOutput: final.openaiOutput },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', is_error: true, content: [{ type: 'text', text: 'User skipped this.' }, { type: 'image', source: { media_type: 'image/jpeg', data: 'aQ==' } }] }] }]);
  assert.deepEqual(input.slice(0, 2), raw);
  assert.equal(input[2].call_id, 'call_1');
  assert.equal(input[2].output[0].text, 'User skipped this.');
  assert.equal(input[2].output[1].type, 'input_image');
  assert.equal(responseParams({ ...params, tools, tool_choice: { type: 'none' } }).tool_choice, 'none');
});

test('web search keeps its cap, usage, progress and clickable source metadata', async () => {
  const item = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'current price' } };
  const { client, calls } = fixture([{ type: 'response.web_search_call.in_progress' }, completed([item, textItem('A cited answer.', [{ type: 'url_citation', url: 'https://example.com/source', title: 'A source', start_index: 2, end_index: 8 }])])]);
  const stream = client.stream({ ...params, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] });
  let searching = 0; stream.on('streamEvent', () => searching++);
  const final = await stream.finalMessage();
  assert.equal(searching, 1);
  assert.equal(final.usage.server_tool_use.web_search_requests, 1);
  assert.equal(final.content[1].citations[0].url, 'https://example.com/source');
  assert.equal(calls[0].body.max_tool_calls, 3);
  assert.equal(calls[0].body.tools[0].type, 'web_search');
});

test('refusals and output limits map to the panel stop reasons', async () => {
  const refused = fixture([completed([{ type: 'message', content: [{ type: 'refusal', refusal: 'Unable to help.' }] }])]);
  assert.equal((await refused.client.stream(params).finalMessage()).stop_reason, 'refusal');
  const limited = fixture([{ type: 'response.incomplete', response: { ...completed().response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }]);
  assert.equal((await limited.client.stream(params).finalMessage()).stop_reason, 'max_tokens');
});

test('EOF and provider errors preserve partial output/usage, reject completion and never retry', async () => {
  const { client, calls } = fixture([...opening, delta('Part of an answer')]);
  const stream = client.stream(params, { promptTokens: 123 });
  let text = ''; stream.on('text', t => { text += t; });
  await assert.rejects(stream.finalMessage(), /interrupted/);
  assert.equal(text, 'Part of an answer');
  assert.equal(stream.currentMessage.content[0].text, text);
  assert.equal(stream.currentMessage.usage.input_tokens, 123);
  assert.equal(stream.currentMessage.stop_reason, null);
  assert.equal(calls.length, 1);
  const failed = fixture([{ type: 'response.failed', response: { model: params.model, status: 'failed', output: [], usage, error: { message: 'Provider failure' } } }]);
  const other = failed.client.stream(params);
  await assert.rejects(other.finalMessage(), /Provider failure/);
  assert.equal(other.currentMessage.usage.output_tokens, 15);
  const badJSON = createOpenAI({ apiKey: 'fixture', fetch: async () => new Response('data: {oops}\n\n') });
  await assert.rejects(badJSON.stream(params).finalMessage(), /unreadable/);
});

test('HTTP failures identify OpenAI and cancellation aborts the provider request', async () => {
  const client = createOpenAI({ apiKey: 'fixture', fetch: async () => new Response('{"error":{"message":"Bad key"}}', { status: 401 }) });
  await assert.rejects(client.stream(params).finalMessage(), e => e.openai && e.status === 401 && e.message === 'Bad key');
  let signal;
  const abortable = createOpenAI({ apiKey: 'fixture', fetch: async (_, init) => { signal = init.signal; return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
  }); } });
  const stream = abortable.stream(params), waiting = stream.finalMessage();
  stream.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
});

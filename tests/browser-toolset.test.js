import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Page actions with the browser toolset (bookmarklet v12, part A: seeing and reading the page): the request's toolset
// entry, screenshots as image blocks, coordinates checked against the latest screenshot, the toolset's name on every
// result, and Sonnet's progress notes. The mock model server plays a script; nothing reaches a real provider.
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const ADMIN = 'browser-test-admin-token-0123456789';
const SCALE = 0.1; // waits: 2s for the page, 30s for a person; keepalives every 1.5s
let db, adminDb, app, mock, origin, owner, alice, bob, carol, dave, erin;
const ids = {};
const calls = [];
let script = null, logs = '';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sse(res, body, spec = {}) {
  const usage = spec.usage || { input_tokens: 20, output_tokens: 5 };
  const ev = [{ type: 'message_start', message: { id: 'msg_' + randomBytes(4).toString('hex'), type: 'message', role: 'assistant', content: [], model: body.model,
    stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } }];
  let i = 0;
  for (const note of spec.notes || []) { // Sonnet's progress notes: thinking blocks (display "updates")
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: note } },
      { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: 'sig-' + i } },
      { type: 'content_block_stop', index: i });
    i++;
  }
  if (spec.text || !spec.tools?.length) {
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: spec.text || 'A local fixture answer.' } },
      { type: 'content_block_stop', index: i });
    i++;
  }
  for (const t of spec.tools || []) {
    // the browser toolset's members come back tagged with the toolset's name; pagebot's own highlight tool doesn't
    const toolset = t.toolset ?? (t.name === 'highlight' ? undefined : 'browser');
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: t.id || 'toolu_' + randomBytes(6).toString('hex'), name: t.name, input: {}, ...(toolset && { toolset_name: toolset }) } },
      { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input || {}) } },
      { type: 'content_block_stop', index: i });
    i++;
  }
  ev.push({ type: 'message_delta', delta: { stop_reason: spec.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
    { type: 'message_stop' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of ev) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

async function api(route, { token = owner, method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }), ...headers },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, data: r.headers.get('content-type')?.includes('ndjson')
    ? text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(text || '{}') };
}
const act = (id, body, token = owner) => api('/api/chat/act', { method: 'POST', token, body: { id, ...body } });
// a chat with page actions on, reading the stream as it comes so the test can answer each {t:'act'}
async function chat(body = {}, { token = owner, onAct, signal } = {}) {
  const r = await fetch(origin + '/api/chat', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Please help.', actions: true, ...body }),
  });
  const events = [];
  if (!r.headers.get('content-type')?.includes('ndjson')) return { status: r.status, events, error: await r.json() };
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        events.push(ev);
        if (ev.t === 'act' && onAct) await onAct(ev, events);
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  return { status: r.status, events, done: events.find(e => e.t === 'done'), acts: events.filter(e => e.t === 'act') };
}
const lastAnswer = async conv => (await db.query("SELECT * FROM messages WHERE conversation_id=$1 AND role='assistant' ORDER BY id DESC LIMIT 1", [conv])).rows[0];
async function session(userId = null) {
  const token = randomBytes(24).toString('hex');
  await db.query('INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), userId]);
  return token;
}
const toolResults = body => body.messages.at(-1).content.filter(b => b.type === 'tool_result');
const said = r => r.content.filter(b => b.type === 'text').map(b => b.text).join('\n'); // a tool_result's words
const ref = r => ({ type: 'ref', ref: r });

before(async () => {
  if (!database) return;
  adminDb = new pg.Pool({ connectionString: database });
  await adminDb.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(database);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  db = new pg.Pool({ connectionString: url.href });
  mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const n = calls.push({ provider: req.url === '/router' ? 'router' : 'anthropic', body, beta: String(req.headers['anthropic-beta'] || '') }) - 1;
    if (req.url === '/router') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A router answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.00001 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    sse(res, body, script ? script(body, n) : {});
  }).listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
  const portServer = createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['--import', './tests/helpers/local-model.mjs', 'server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: url.href, PGSSL: 'false', PORT: String(port),
      INITIAL_PASSWORD: '', ADMIN_TOKEN: ADMIN, ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: mockOrigin,
      OPENROUTER_API_KEY: 'local-fixture-only', OPENROUTER_MODEL: 'meta/muse-spark-1.3-contributor',
      PAGEBOT_MOCK_MODEL_ORIGIN: mockOrigin, SYSTEM_PROMPT: 'You are a test helper.', TIMEZONE: 'UTC',
      PAGEBOT_TEST_ACT_WAIT_SCALE: String(SCALE) },
  });
  app.stdout.on('data', chunk => { logs += chunk; });
  app.stderr.on('data', chunk => { logs += chunk; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (app.exitCode != null) throw new Error(`Test server exited: ${logs}`);
    try { if ((await fetch(origin + '/health')).ok) { ready = true; break; } } catch { /* starting */ }
    await sleep(100);
  }
  assert.ok(ready, `Server failed to start: ${logs}`);
  const users = await db.query(`INSERT INTO users(username,password_hash,status) VALUES
    ('alice','x','trusted'),('bob','x','trusted'),('carol','x','trusted'),('dave','x','trusted'),('erin','x','trusted'),('frank','x','pending') RETURNING id, username`);
  for (const u of users.rows) ids[u.username] = Number(u.id);
  await db.query('UPDATE users SET allow_actions=false WHERE id=$1', [ids.carol]);
  [owner, alice, bob, carol, dave, erin] = await Promise.all([session(), ...['alice', 'bob', 'carol', 'dave', 'erin'].map(n => session(ids[n]))]);
});

after(async () => {
  if (app && app.exitCode == null) { app.kill(); await once(app, 'exit'); }
  if (mock) await new Promise(resolve => mock.close(resolve));
  await db?.end();
  if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
});


// a small PNG (1×1), sent as the panel would send a screenshot it scaled to w×h
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const coord = (x, y) => ({ type: 'coordinate', x, y });

test('browser toolset (part A)', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  t.afterEach(() => { script = null; });

  await t.test('the request carries the toolset entry, with no name and the members pagebot can’t offer turned off, and the highlight tool', async () => {
    const base = calls.length;
    script = () => ({ text: 'Nothing to do.' });
    const r = await chat({ page: { url: 'https://x.example/', title: 'X', text: 'A page.' } });
    assert.ok(r.done, JSON.stringify(r.events));
    const [toolset, highlight, ...rest] = calls[base].body.tools;
    assert.deepEqual(rest, []);
    assert.deepEqual(toolset, { type: 'browser_toolset_20260801', configs: Object.fromEntries(
      ['navigate', 'new_tab', 'list_tabs', 'switch_tab', 'close_tab', 'file_upload', 'read_console', 'read_network', 'javascript_exec'].map(n => [n, { enabled: false }])) });
    assert.equal('name' in toolset, false, 'the toolset entry takes no name');
    assert.equal(highlight.name, 'highlight');
    assert.ok(highlight.input_schema.properties.quotes);
    assert.match(calls[base].body.system, /screenshot and coordinates for what the tree doesn't show/);
    assert.match(calls[base].body.system, /untrusted content from the web page/);
    assert.equal(calls[base].body.thinking, undefined, 'Haiku gets no progress notes');
    assert.doesNotMatch(calls[base].beta, /thinking-display-updates/);
  });

  await t.test('a screenshot goes back as an image block of its size; later points must fall inside it, and zoom regions too', async () => {
    const base = calls.length;
    script = (body, n) => [
      { tools: [{ name: 'hover', input: { target: coord(10, 10) } }] }, // before any screenshot
      { tools: [{ name: 'screenshot', input: {} }, { name: 'zoom', input: { region: [0, 0, 400, 300] } }] },
      { tools: [{ name: 'mouse_move', input: { target: coord(1279.4, 799.2) } }, { name: 'scroll', input: { target: coord(640, 400), scroll_direction: 'down' } }] },
      { tools: [{ name: 'hover', input: { target: coord(1280, 10) } }] },
      { tools: [{ name: 'zoom', input: { region: [100, 100, 1400, 300] } }] },
      { text: 'Seen it.' },
    ][n - base] || {};
    const r = await chat({}, { onAct: async ev => {
      if (ev.name === 'screenshot') await act(ev.id, { note: 'Took a screenshot', result: { image: PNG, w: 1280, h: 800, scale: 0.8 } });
      else if (ev.name === 'zoom') await act(ev.id, { note: 'Zoomed in on part of the page', result: { image: PNG, w: 600, h: 450 } });
      else if (ev.name === 'scroll') await act(ev.id, { result: { moved: true } });
      else await act(ev.id, { result: { role: 'button', label: 'Menu' } });
    } });
    assert.ok(r.done, JSON.stringify(r.events));
    assert.deepEqual(r.acts.map(a => [a.name, a.input]), [['screenshot', {}], ['zoom', { region: [0, 0, 400, 300] }],
      ['mouse_move', { target: coord(1279, 799) }], ['scroll', { target: coord(640, 400), scroll_direction: 'down', scroll_amount: 3 }]]);
    assert.ok(r.acts[0].wait >= 30000, 'the first screenshot may wait for the person to share the tab');
    const [early] = toolResults(calls[base + 1].body);
    assert.equal(early.is_error, true);
    assert.match(said(early), /Take a screenshot first/);
    const [shot, zoom] = toolResults(calls[base + 2].body);
    assert.equal(shot.toolset_name, 'browser');
    assert.equal(shot.is_error, undefined);
    assert.match(said(shot), /1280×800 pixels/);
    assert.deepEqual(shot.content.find(b => b.type === 'image'), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.split(',')[1] } });
    assert.match(said(zoom), /Zoomed in on \[0, 0, 400, 300\]/);
    assert.ok(zoom.content.some(b => b.type === 'image'));
    const [moved, scrolled] = toolResults(calls[base + 3].body);
    assert.match(said(moved), /The mouse is over \(1279, 799\) \(button "Menu"\)/);
    assert.equal(said(scrolled), 'Scrolled down.');
    const [outside] = toolResults(calls[base + 4].body);
    assert.equal(outside.is_error, true);
    assert.match(said(outside), /outside the screenshot\. Use a point inside the latest screenshot \(0–1279 across, 0–799 down\)/);
    const [wide] = toolResults(calls[base + 5].body);
    assert.equal(wide.is_error, true);
    assert.match(said(wide), /The region has to be inside the latest screenshot/);
    const steps = JSON.parse((await lastAnswer(r.done.conversationId)).steps);
    assert.deepEqual(steps.map(s => [s.tool, s.outcome]), [['hover', 'failed'], ['screenshot', 'done'], ['zoom', 'done'], ['mouse_move', 'done'], ['scroll', 'done'], ['hover', 'failed'], ['zoom', 'failed']]);
  });

  await t.test('a screenshot that isn’t a usable image is an error, and only browser members and highlight are known', async () => {
    const base = calls.length;
    script = (body, n) => [
      { tools: [{ name: 'screenshot', input: {} }] },
      { tools: [{ name: 'navigate', input: { url: 'https://evil.example/' } }] },
      { tools: [{ name: 'read_page', input: {}, toolset: 'other' }] },
      { tools: [{ name: 'highlight', input: { quotes: ['A passage'] } }] },
      { text: 'Done.' },
    ][n - base] || {};
    const r = await chat({}, { onAct: async ev => {
      if (ev.name === 'screenshot') await act(ev.id, { result: { image: 'data:image/gif;base64,R0lGOD', w: 5000, h: 10 } });
      else await act(ev.id, { result: { found: [1] } });
    } });
    assert.ok(r.done, JSON.stringify(r.events));
    assert.deepEqual(r.acts.map(a => a.name), ['screenshot', 'highlight'], 'navigate and a stranger toolset never reach the panel');
    const [bad] = toolResults(calls[base + 1].body);
    assert.equal(bad.is_error, true);
    assert.match(said(bad), /The screenshot didn’t come through/);
    assert.ok(!bad.content.some(b => b.type === 'image'));
    const [nav] = toolResults(calls[base + 2].body);
    assert.equal(nav.is_error, true);
    assert.match(said(nav), /There's no tool called navigate here/);
    const [stranger] = toolResults(calls[base + 3].body);
    assert.equal(stranger.toolset_name, undefined);
    assert.match(said(stranger), /no tool called read_page/);
    const [hl] = toolResults(calls[base + 4].body);
    assert.equal(hl.toolset_name, undefined, 'pagebot’s own highlight tool isn’t part of the toolset');
    assert.equal(said(hl), 'Highlighted 1 of 1.');
  });

  await t.test('read_page and find results are cut at 50,000 characters, and say so', async () => {
    const base = calls.length;
    script = (body, n) => n === base ? { tools: [{ name: 'read_page', input: { filter: 'all', depth: 5 } }, { name: 'read_page', input: { ref: 'ref_7' } }] } : { text: 'Long page.' };
    const r = await chat({}, { onAct: ev => act(ev.id, { result: ev.input.ref ? { text: 'x'.repeat(10), cut: true } : { text: 'y'.repeat(60000) } }) });
    assert.ok(r.done);
    assert.deepEqual(r.acts.map(a => a.input), [{ filter: 'all', depth: 5 }, { depth: 15, ref: 'ref_7' }]);
    const [big, part] = toolResults(calls[base + 1].body);
    assert.equal(said(big).length < 50200, true);
    assert.match(said(big), /\[Cut off at 50,000 characters\. Read part of it with ref, or a smaller depth\.\]$/);
    assert.match(said(part), /^x{10}\n\[Cut off at 50,000 characters/);
  });

  await t.test('on Sonnet, progress notes between page steps stream as {t:"note"} and the thinking blocks go back unchanged', async () => {
    const base = calls.length;
    script = (body, n) => n === base ? { notes: ['Looking at the form first.'], tools: [{ name: 'read_page', input: {} }] }
      : n === base + 1 ? { notes: ['This part of the response was interrupted before it finished.', ''], text: 'The form has one field.' } : {};
    const r = await chat({ model: 'sonnet' }, { onAct: ev => act(ev.id, { result: { text: 'textbox "Email" [ref_1] value=""' } }) });
    assert.ok(r.done, JSON.stringify(r.events));
    const first = calls[base];
    assert.deepEqual(first.body.thinking, { type: 'adaptive', display: 'updates' });
    assert.match(first.beta, /thinking-display-updates-2026-08-18/);
    assert.deepEqual(r.events.filter(e => e.t === 'note'), [{ t: 'note', v: 'Looking at the form first.' }], 'the interrupted-work sentinel and empty notes are not shown');
    assert.ok(r.events.findIndex(e => e.t === 'note') < r.events.findIndex(e => e.t === 'act'), 'the note comes before the step it explains');
    const back = calls[base + 1].body.messages.at(-2).content;
    assert.deepEqual(back[0], { type: 'thinking', thinking: 'Looking at the form first.', signature: 'sig-0' });
    assert.match(r.done.model, /Sonnet/);
  });
});

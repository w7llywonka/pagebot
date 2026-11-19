import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// A real Pagebot server and PostgreSQL, with OPENAI_API_KEY as its only model credential.
// The subprocess intercepts every provider request; no AI credits or real secrets are used.
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const ADMIN = 'openai-test-admin-token-0123456789';
let db, adminDb, app, mock, origin, owner, user, userId, script, logs = '';
const calls = [];
const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 15 };
const tool = (name, input) => ({ type: 'function_call', id: 'fc_' + calls.length, call_id: 'call_' + calls.length, name, arguments: JSON.stringify(input), status: 'completed' });
const text = value => ({ type: 'message', id: 'msg_' + calls.length, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value, annotations: [] }] });
async function api(route, { token = owner, method = 'GET', body, admin = false } = {}) {
  const r = await fetch(origin + route, { method, headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(admin && { 'x-admin-token': ADMIN }), ...(body && { 'Content-Type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) });
  const raw = await r.text();
  return { status: r.status, data: r.headers.get('content-type')?.includes('ndjson') ? raw.trim().split('\n').filter(Boolean).map(JSON.parse) : JSON.parse(raw || '{}') };
}
async function chat(body, { token = owner, onAct } = {}) {
  const r = await fetch(origin + '/api/chat', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Help with this page.', ...body }) });
  if (!r.headers.get('content-type')?.includes('ndjson')) return { status: r.status, error: await r.json() };
  const events = [], decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of r.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line) continue;
      const e = JSON.parse(line); events.push(e);
      if (e.t === 'act' && onAct) await onAct(e);
    }
  }
  return { status: r.status, events, done: events.find(e => e.t === 'done'), error: events.find(e => e.t === 'err') };
}
async function session(id = null) {
  const token = randomBytes(24).toString('hex');
  await db.query('INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), id]);
  return token;
}

before(async () => {
  if (!database) return;
  adminDb = new pg.Pool({ connectionString: database }); await adminDb.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(database); url.searchParams.set('options', `-csearch_path=${schema}`);
  db = new pg.Pool({ connectionString: url.href });
  mock = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls.push({ body, url: req.url, auth: req.headers.authorization });
    const spec = script?.(body) || {};
    if (spec.status) { res.writeHead(spec.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Fixture error' } })); }
    const output = spec.output || [text('A Luna answer.')];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    send({ type: 'response.created', response: { id: 'resp_' + calls.length, model: body.model, status: 'in_progress', output: [] } });
    for (const [index, item] of output.entries()) {
      send({ type: 'response.output_item.added', output_index: index, item: item.type === 'message' ? { ...item, content: [] } : item });
      if (item.type === 'message') for (const [i, part] of item.content.entries()) {
        send({ type: 'response.content_part.added', output_index: index, content_index: i, part: { ...part, text: '' } });
        send({ type: 'response.output_text.delta', output_index: index, content_index: i, delta: part.text });
      }
      send({ type: 'response.output_item.done', output_index: index, item });
    }
    if (!spec.cut) send({ type: 'response.completed', response: { id: 'resp_' + calls.length, model: body.model, status: 'completed', output, usage } });
    res.end();
  }).listen(0, '127.0.0.1'); await once(mock, 'listening');
  const portServer = createServer().listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const port = portServer.address().port; await new Promise(r => portServer.close(r));
  origin = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['--import', './tests/helpers/local-model.mjs', 'server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: url.href, PGSSL: 'false', PORT: String(port), INITIAL_PASSWORD: '', ADMIN_TOKEN: ADMIN,
      ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', OPENAI_API_KEY: 'local-fixture-only', OPENAI_MODEL: '',
      PAGEBOT_MOCK_MODEL_ORIGIN: `http://127.0.0.1:${mock.address().port}`, SYSTEM_PROMPT: 'Test helper.', TIMEZONE: 'UTC' },
  });
  app.stdout.on('data', c => { logs += c; }); app.stderr.on('data', c => { logs += c; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (app.exitCode != null) throw new Error(logs);
    try { if ((await fetch(origin + '/health')).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, logs);
  userId = Number((await db.query("INSERT INTO users(username,password_hash,status,allow_sonnet) VALUES('luna-user','x','trusted',false) RETURNING id")).rows[0].id);
  owner = await session(); user = await session(userId);
});
after(async () => {
  if (app && app.exitCode == null) { app.kill(); await once(app, 'exit'); }
  if (mock) await new Promise(r => mock.close(r));
  await db?.end(); if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
});

test('OpenAI end-to-end integration', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  t.afterEach(() => { script = null; });
  await t.test('OpenAI-only boot, preferences and existing Claude preferences select Luna without exposing the key', async () => {
    const boot = (await api('/api/boot')).data;
    assert.deepEqual(boot.models, [{ key: 'openai', label: 'GPT-6 Luna' }]);
    assert.equal(boot.prefs.model, 'openai');
    assert.ok(!JSON.stringify(boot).includes('local-fixture-only'));
    await api('/api/prefs', { method: 'POST', body: { model: 'openai' } });
    assert.equal((await api('/api/boot')).data.prefs.model, 'openai');
    await db.query("UPDATE settings SET value=$1 WHERE key='prefs'", [JSON.stringify({ model: 'haiku' })]);
    assert.equal((await api('/api/boot')).data.prefs.model, 'openai');
    assert.equal((await api('/api/boot', { token: user })).data.prefs.model, 'openai');
    assert.equal((await chat({ model: 'haiku' })).done.model, 'GPT-6 Luna');
    assert.equal(calls.at(-1).url, '/openai');
    assert.equal(calls.at(-1).auth, 'Bearer local-fixture-only');
  });
  await t.test('page text, selected text, annotated screenshot, site memory and history reach OpenAI', async () => {
    await api('/api/site-memory', { method: 'PUT', body: { site: 'example.com', instructions: 'Use short explanations.' } });
    const first = await chat({ page: { url: 'https://example.com/page', title: 'A page', text: 'Important page content.' }, selection: 'A highlighted passage.',
      image: 'data:image/png;base64,aGVsbG8=', annotated: true, model: 'openai' });
    assert.equal(first.done.model, 'GPT-6 Luna');
    const body = calls.at(-1).body;
    assert.match(body.instructions, /Use short explanations/);
    assert.match(JSON.stringify(body.input), /Important page content/);
    assert.match(JSON.stringify(body.input), /highlighted_text/);
    assert.match(JSON.stringify(body.input), /annotated_screenshot/);
    assert.ok(body.input.at(-1).content.some(b => b.type === 'input_image'));
    await chat({ conversationId: first.done.conversationId, message: 'Tell me more.' });
    assert.match(JSON.stringify(calls.at(-1).body.input), /Important page content/);
    assert.match(JSON.stringify(calls.at(-1).body.input), /no longer available/);
    assert.ok(!JSON.stringify(calls.at(-1).body.input).includes('aGVsbG8='));
    assert.ok((await api(`/api/chats/${first.done.conversationId}`)).data.messages.some(m => m.model === 'GPT-6 Luna'));
  });
  await t.test('PDF upload and follow-ups work without an Anthropic credential', async () => {
    const upload = await fetch(origin + '/api/pdf?name=notes.pdf', { method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/pdf' },
      body: '%PDF-1.4\n1 0 obj <</Type /Page>> endobj\n%%EOF' });
    assert.equal(upload.status, 200); const pdf = await upload.json();
    const first = await chat({ pdf: pdf.id, model: 'openai' });
    assert.ok(first.done, JSON.stringify(first));
    assert.ok(calls.at(-1).body.input.at(-1).content.some(b => b.type === 'input_file' && b.filename === 'notes.pdf'));
    await chat({ conversationId: first.done.conversationId, message: 'More about the PDF.' });
    assert.ok(calls.at(-1).body.input.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'input_file')));
  });
  await t.test('web search uses OpenAI tools and keeps sources and search usage in the answer', async () => {
    const answer = text('See [the source](https://example.com/source).');
    answer.content[0].annotations = [{ type: 'url_citation', url: 'https://example.com/source', title: 'The source', start_index: 4, end_index: 42 }];
    script = () => ({ output: [{ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'Current information' } }, answer] });
    const result = await chat({ model: 'openai', web: true });
    assert.equal(result.done.searches, 1);
    assert.deepEqual(result.done.sources, [{ url: 'https://example.com/source', title: 'The source' }]);
    assert.equal(calls.at(-1).body.tools[0].type, 'web_search');
    assert.equal(calls.at(-1).body.max_tool_calls, 3);
  });
  await t.test('browser steps reuse approval checks and return text/images with the original reasoning and call ids', async () => {
    const start = calls.length;
    script = () => ({ output: calls.length === start + 1 ? [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' }, tool('read_page', {})]
      : calls.length === start + 2 ? [tool('left_click', { target: { type: 'ref', ref: 'ref_1' } })]
      : calls.length === start + 3 ? [tool('screenshot', {})] : [text('Done.')] });
    const result = await chat({ actions: true }, { onAct: async e => {
      assert.equal(e.ask, e.name === 'left_click');
      const r = await api('/api/chat/act', { method: 'POST', body: { id: e.id,
        result: e.name === 'screenshot' ? { image: 'data:image/png;base64,aGVsbG8=', w: 800, h: 600 } : e.name === 'read_page' ? { text: '[ref_1] button "More"' } : {}, note: 'Verified a step' } });
      assert.equal(r.status, 200);
    } });
    assert.ok(result.done, JSON.stringify(result));
    assert.equal(result.events.filter(e => e.t === 'act').length, 3);
    assert.equal(calls[start + 1].body.input.find(x => x.type === 'reasoning').encrypted_content, 'opaque');
    assert.equal(calls[start + 1].body.input.at(-1).type, 'function_call_output');
    assert.equal(calls.at(-1).body.input.at(-1).output[1].type, 'input_image');
    const saved = (await db.query("SELECT steps FROM messages WHERE conversation_id=$1 AND role='assistant'", [result.done.conversationId])).rows[0];
    assert.equal(JSON.parse(saved.steps).length, 3);
  });
  await t.test('the web-search allowance is shared across page-action rounds', async () => {
    const start = calls.length;
    script = () => ({ output: calls.length === start + 1 ? [1, 2, 3].map(n => ({ type: 'web_search_call', id: 'ws_' + n, status: 'completed', action: { type: 'search', query: 'A query' } }))
      .concat(tool('read_page', {})) : [text('Finished searching.')] });
    const result = await chat({ actions: true, web: true }, { onAct: e => api('/api/chat/act', { method: 'POST', body: { id: e.id, result: { text: 'Page content' } } }) });
    assert.equal(result.done.searches, 3);
    assert.equal(calls[start].body.max_tool_calls, 3);
    assert.ok(calls[start + 1].body.tools.every(t => t.type !== 'web_search'));
    assert.ok(!('max_tool_calls' in calls[start + 1].body));
  });
  // The browser extension (README "Browser extension") with Luna: the panel says it runs in the extension and lists what it
  // runs, the way public/widget.html does; it answers tab steps with the window's tabs, the way extension/sidepanel.js does.
  await t.test('in the extension, Luna is offered the members the panel lists and reads the tabs it sends back; a bookmark panel keeps the 12', async () => {
    const BOOKMARK = ['screenshot', 'zoom', 'read_page', 'find', 'get_page_text', 'scroll', 'scroll_to', 'hover', 'mouse_move', 'wait', 'left_click', 'form_input'];
    const LISTED = ['navigate', 'list_tabs', 'new_tab', 'type', 'key'];
    const ALL = ['navigate', 'new_tab', 'list_tabs', 'switch_tab', 'close_tab', 'read_console', 'read_network', 'javascript_exec',
      'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'type', 'key', 'hold_key'];
    const TABS = [{ tab_id: 'tab-1', title: 'News', url: 'https://news.example.test/a?session=secret', active: true }, { tab_id: 'tab-2', title: 'Shop', url: 'https://shop.example.test/' }];
    const NEW_TABS = [{ ...TABS[0], active: undefined }, TABS[1], { tab_id: 'tab-3', title: '', url: 'about:blank', active: true }].map(x => JSON.parse(JSON.stringify(x)));
    const fns = body => (body.tools || []).filter(x => x.type === 'function' && x.name !== 'highlight');
    const names = body => fns(body).map(x => x.name).sort();
    const listed = { host: 'ext', ext: 1, tools: [...LISTED, 'file_upload', 'bogus'] };

    const start = calls.length;
    script = () => ({ output: calls.length === start + 1 ? [tool('list_tabs', {})]
      : calls.length === start + 2 ? [tool('navigate', { url: 'https://shop.example.test/', tab_id: 'tab-2' })]
      : calls.length === start + 3 ? [tool('new_tab', {})]
      : calls.length === start + 4 ? [tool('javascript_exec', { text: 'document.cookie' })] : [text('Done.')] });
    const results = {
      list_tabs: { tabs: TABS },
      navigate: { url: 'https://shop.example.test/', title: 'Shop', tabs: [{ ...TABS[0], active: undefined }, { ...TABS[1], active: true }] },
      new_tab: { tabs: NEW_TABS, opened: ['tab-3'] },
    };
    const result = await chat({ model: 'openai', actions: true, web: true, ...listed }, { onAct: async e => {
      assert.ok(results[e.name], `no step called ${e.name} should reach the panel`);
      const r = await api('/api/chat/act', { method: 'POST', body: { id: e.id, result: results[e.name] } });
      assert.equal(r.status, 200);
    } });
    assert.ok(result.done, JSON.stringify(result.events.slice(-3)));
    assert.equal(result.error, undefined);
    assert.equal(result.done.model, 'GPT-6 Luna');
    assert.doesNotMatch(logs, /Unsupported OpenAI input/);
    // what Luna was offered: the bookmark's members and the ones the panel listed, each able to name a tab; never file_upload
    const first = calls[start].body;
    assert.equal(calls[start].url, '/openai');
    assert.deepEqual(names(first), [...BOOKMARK, ...LISTED].sort());
    assert.ok(!first.tools.some(x => x.name === 'file_upload' || x.name === 'read_console' || x.name === 'javascript_exec'));
    assert.ok(first.tools.some(x => x.name === 'highlight'));
    assert.equal(first.tools[0].type, 'web_search');
    for (const f of fns(first)) {
      assert.deepEqual(f.parameters.properties.tab_id, { type: 'string', description: 'A tab from list_tabs, like "tab-12". Leave it out for the current tab.' }, f.name);
      assert.ok(!f.parameters.required.includes('tab_id'), f.name);
    }
    assert.deepEqual(fns(first).find(f => f.name === 'navigate').parameters.required, ['url']);
    assert.ok(fns(first).find(f => f.name === 'left_click').parameters.properties.target.anyOf, 'in the extension left_click takes a point too');
    // the system prompt: the extension's page-action note and Luna's citation line, together
    assert.match(first.instructions, /through the pagebot extension/);
    assert.match(first.instructions, /Cite web sources with Markdown links in your answer/);
    assert.doesNotMatch(first.instructions, /there are no other tabs/);
    // each step reached the panel tagged as the browser toolset's (no "no tool called" refusal), and its result came back as text
    assert.deepEqual(result.events.filter(e => e.t === 'act').map(e => [e.name, e.input, e.ask]),
      [['list_tabs', {}, false], ['navigate', { url: 'https://shop.example.test/', tab_id: 'tab-2' }, true], ['new_tab', {}, false]]);
    const output = n => { const i = calls[start + n].body.input, o = i.at(-1);
      assert.equal(o.type, 'function_call_output');
      assert.equal(i.at(-2).type, 'function_call', 'the call goes back exactly as Luna returned it');
      assert.equal(o.call_id, i.at(-2).call_id);
      return o.output; };
    assert.deepEqual(output(1), [{ type: 'input_text', text: 'Open tabs:\ntab-1 (current): News <https://news.example.test/a>\ntab-2: Shop <https://shop.example.test/>' }]);
    assert.deepEqual(output(2), [{ type: 'input_text', text: 'Went to https://shop.example.test/.' },
      { type: 'input_text', text: 'Open tabs:\ntab-1: News <https://news.example.test/a>\ntab-2 (current): Shop <https://shop.example.test/>' }]);
    assert.deepEqual(output(3), [{ type: 'input_text', text: 'Open tabs:\ntab-1: News <https://news.example.test/a>\ntab-2: Shop <https://shop.example.test/>\ntab-3 (current):  <about:blank>\nJust opened: tab-3' }]);
    assert.deepEqual(output(4), [{ type: 'input_text', text: "There's no tool called javascript_exec here." }], 'a member the panel didn’t list is refused, not run');
    assert.equal(calls.length, start + 5);
    const saved = JSON.parse((await db.query("SELECT steps FROM messages WHERE conversation_id=$1 AND role='assistant'", [result.done.conversationId])).rows[0].steps);
    assert.deepEqual(saved.map(s => [s.tool, s.outcome]), [['list_tabs', 'done'], ['navigate', 'done'], ['new_tab', 'done']], 'a refused unknown member isn’t a step');

    // the whole extension: all of its members (the optional ones switched on), still no file_upload
    script = () => ({ output: [text('Nothing to do.')] });
    assert.ok((await chat({ model: 'openai', actions: true, host: 'ext', ext: 1, tools: [...ALL, 'file_upload'] })).done);
    assert.deepEqual(names(calls.at(-1).body), [...new Set([...BOOKMARK, ...ALL])].sort());
    assert.ok(!calls.at(-1).body.tools.some(x => x.name === 'file_upload'));
    // a bookmark panel (no host, or a host that isn't the extension) gets exactly the bookmark's 12, with no tab_id
    for (const body of [{}, { host: 'ext', ext: 0, tools: ALL }, { host: 'bookmark', ext: 1, tools: ALL }]) {
      assert.ok((await chat({ model: 'openai', actions: true, ...body })).done, JSON.stringify(body));
      const sent = calls.at(-1).body;
      assert.deepEqual(names(sent), [...BOOKMARK].sort(), JSON.stringify(body));
      assert.ok(fns(sent).every(f => !('tab_id' in f.parameters.properties)), JSON.stringify(body));
      assert.deepEqual(fns(sent).find(f => f.name === 'left_click').parameters.properties.target.required, ['type', 'ref'], 'a bookmark clicks refs only');
      assert.match(sent.instructions, /there are no other tabs, and you can't navigate/);
      assert.doesNotMatch(sent.instructions, /pagebot extension/);
    }
  });
  await t.test('account permissions, percentages, cached-token pricing and admin model breakdowns stay correct', async () => {
    await db.query('UPDATE users SET allow_actions=false, limit_kind=$1, limit_value=100000 WHERE id=$2', ['tokens', userId]);
    const result = await chat({ model: 'openai', actions: true }, { token: user });
    assert.ok(result.done, JSON.stringify(result));
    assert.equal(result.done.model, 'GPT-6 Luna');
    assert.equal(result.done.usage.pct, 0.12);
    assert.ok(!('in' in result.done.usage) && !('usd' in result.done.usage));
    assert.ok(!calls.at(-1).body.tools);
    const saved = (await db.query("SELECT input_tokens, output_tokens, cost_usd FROM messages WHERE conversation_id=$1 AND role='assistant'", [result.done.conversationId])).rows[0];
    assert.equal(saved.input_tokens, 100); assert.equal(saved.output_tokens, 15);
    assert.equal(Number(saved.cost_usd), 0.000014); // database stores dollars to six decimal places
    const headers = { admin: true };
    const stats = (await api('/api/admin/usage', headers)).data;
    assert.ok(stats.days.some(d => d.openai > 0 && d.openaiUsd > 0));
    const activity = (await api('/api/admin/activity?model=openai', headers)).data;
    assert.ok(activity.rows.length && activity.rows.every(r => r.family === 'openai'));
  });
  await t.test('invalid-key errors name OPENAI_API_KEY and interrupted answers retain their text and usage', async () => {
    script = () => ({ status: 401 });
    const bad = await chat({ model: 'openai' }); assert.match(bad.error.v, /OPENAI_API_KEY/);
    script = () => ({ cut: true, output: [text('Partial Luna answer.')] });
    const result = await chat({ model: 'openai' }); assert.match(result.error.v, /interrupted/);
    const saved = (await db.query("SELECT content, incomplete, input_tokens FROM messages WHERE conversation_id=$1 AND role='assistant'", [result.events[0].conversationId])).rows[0];
    assert.equal(saved.content, 'Partial Luna answer.'); assert.equal(saved.incomplete, true); assert.ok(saved.input_tokens > 0);
  });
});

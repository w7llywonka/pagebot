import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readZip } from './helpers/unzip.mjs';

// The server's side of the browser extension (README "Browser extension"): the zip route, /widget's frame policy, and the
// browser toolset's extra members, offered only when the panel says it runs in the extension and only to people allowed page
// actions, with every new member's input checked and its results carrying the tabs (browser_state). The mock model server
// plays a script; nothing reaches a real provider.
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const SCALE = 0.1;
const EXT_ID = 'inknjdpepdgianddhnnpkdbpkjbbiomg';
const ALL = ['navigate', 'new_tab', 'list_tabs', 'switch_tab', 'close_tab', 'read_console', 'read_network', 'javascript_exec',
  'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'type', 'key', 'hold_key'];
const BOOKMARK_OFF = ['navigate', 'new_tab', 'list_tabs', 'switch_tab', 'close_tab', 'file_upload', 'read_console', 'read_network', 'javascript_exec',
  'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'type', 'key', 'hold_key'];
let db, adminDb, app, mock, origin, port, owner, carol, alice;
const ids = {};
const calls = [];
let script = null, logs = '';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sse(res, body, spec = {}) {
  const ev = [{ type: 'message_start', message: { id: 'msg_' + randomBytes(4).toString('hex'), type: 'message', role: 'assistant', content: [], model: body.model,
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }];
  let i = 0;
  if (spec.text || !spec.tools?.length) {
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: spec.text || 'A local fixture answer.' } },
      { type: 'content_block_stop', index: i });
    i++;
  }
  for (const t of spec.tools || []) {
    const toolset = t.name === 'highlight' ? undefined : 'browser';
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'toolu_' + randomBytes(6).toString('hex'), name: t.name, input: {}, ...(toolset && { toolset_name: toolset }) } },
      { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input || {}) } },
      { type: 'content_block_stop', index: i });
    i++;
  }
  ev.push({ type: 'message_delta', delta: { stop_reason: spec.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of ev) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}
async function api(route, { token = owner, method = 'GET', body } = {}) {
  const r = await fetch(origin + route, { method, headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) });
  const text = await r.text();
  return { status: r.status, headers: Object.fromEntries(r.headers), data: text ? JSON.parse(text) : {} };
}
// a raw GET, so the Host header can be anything
const raw = (path, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject); req.end();
});
const act = (id, body, token = owner) => api('/api/chat/act', { method: 'POST', token, body: { id, ...body } });
const EXT = { host: 'ext', ext: 1, tools: ALL };
async function chat(body = {}, { token = owner, onAct } = {}) {
  const r = await fetch(origin + '/api/chat', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Please help.', actions: true, ...body }) });
  const events = [];
  if (!r.headers.get('content-type')?.includes('ndjson')) return { status: r.status, events, error: await r.json() };
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
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
  return { status: r.status, events, done: events.find(e => e.t === 'done'), acts: events.filter(e => e.t === 'act') };
}
async function session(userId = null) {
  const token = randomBytes(24).toString('hex');
  await db.query('INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), userId]);
  return token;
}
const toolResults = body => body.messages.at(-1).content.filter(b => b.type === 'tool_result');
const said = r => r.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
const coord = (x, y) => ({ type: 'coordinate', x, y });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TABS = [{ tab_id: 'tab-1', title: 'News', url: 'https://news.example.test/a', active: true }, { tab_id: 'tab-2', title: 'Shop', url: 'https://shop.example.test/' }];
// one scripted round per call, then a closing answer
const rounds = list => { let base = null; return (body, n) => { if (base == null) base = n; return list[n - base] || { text: 'Done.' }; }; };

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
    const n = calls.push({ provider: req.url === '/router' ? 'router' : 'anthropic', body }) - 1;
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
  port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['--import', './tests/helpers/local-model.mjs', 'server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: url.href, PGSSL: 'false', PORT: String(port), INITIAL_PASSWORD: '', ADMIN_TOKEN: 'ext-test-admin-token-0123456789',
      ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: mockOrigin, OPENROUTER_API_KEY: 'local-fixture-only', OPENROUTER_MODEL: 'meta/muse-spark-1.3-contributor',
      PAGEBOT_MOCK_MODEL_ORIGIN: mockOrigin, SYSTEM_PROMPT: 'You are a test helper.', TIMEZONE: 'UTC', PAGEBOT_TEST_ACT_WAIT_SCALE: String(SCALE), RAILWAY_PUBLIC_DOMAIN: '' },
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
  const users = await db.query(`INSERT INTO users(username,password_hash,status) VALUES ('alice','x','trusted'),('carol','x','trusted') RETURNING id, username`);
  for (const u of users.rows) ids[u.username] = Number(u.id);
  await db.query('UPDATE users SET allow_actions=false WHERE id=$1', [ids.carol]);
  [owner, alice, carol] = await Promise.all([session(), session(ids.alice), session(ids.carol)]);
});
after(async () => {
  if (app && app.exitCode == null) { app.kill(); await once(app, 'exit'); }
  if (mock) await new Promise(resolve => mock.close(resolve));
  await db?.end();
  if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
});

test('browser extension: the server side', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  t.afterEach(() => { script = null; });

  await t.test('the zip comes from the address the page was opened from, for anyone, never cached', async () => {
    const r = await raw('/pagebot-extension.zip', { Host: 'pagebot.example.test' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/zip');
    assert.equal(r.headers['content-disposition'], 'attachment; filename="pagebot-extension.zip"');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.headers.vary, /\bHost\b/);
    assert.match(r.headers['x-robots-tag'], /noindex/);
    assert.equal(Number(r.headers['content-length']), r.body.length);
    const files = Object.fromEntries(readZip(r.body).map(f => [f.name, f.data.toString()]));
    assert.match(files['sidepanel.js'], /const ORIGIN = "http:\/\/pagebot\.example\.test"/);
    assert.match(JSON.parse(files['manifest.json']).content_security_policy.extension_pages, /frame-src http:\/\/pagebot\.example\.test;/);
    // behind a proxy that says https (trust proxy 1), and a forged host that isn't a plain name falls back like the homepage
    const https = await raw('/pagebot-extension.zip', { Host: 'pagebot.example.test', 'X-Forwarded-Proto': 'https' });
    assert.match(readZip(https.body).find(f => f.name === 'sidepanel.js').data.toString(), /const ORIGIN = "https:\/\/pagebot\.example\.test"/);
    const bad = await raw('/pagebot-extension.zip', { Host: 'evil.test"><script>' });
    assert.equal(bad.status, 200);
    const js = readZip(bad.body).find(f => f.name === 'sidepanel.js').data.toString();
    assert.match(js, /const ORIGIN = "http:\/\/localhost"/);
    assert.doesNotMatch(js, /evil/);
    assert.equal((await raw('/pagebot-extension.zip', { Host: `127.0.0.1:${port}` })).status, 200);
  });

  await t.test('the homepage links the /extension guide, and its download link and /extension.zip both serve the real zip', async () => {
    const H = { Host: 'pagebot.example.test' };
    assert.match((await raw('/', H)).body.toString(), /<a class="extension-link" href="\/extension">Get the extension<\/a>/);
    const guide = await raw('/extension', H);
    assert.equal(guide.status, 200);
    assert.match(guide.headers['content-type'], /^text\/html/);
    assert.match(guide.headers['content-security-policy'], /frame-ancestors 'none'$/);
    const href = guide.body.toString().match(/<a class="download" id="downloadExtension" href="([^"]+)" download="pagebot-extension\.zip">/)?.[1];
    assert.equal(href, '/pagebot-extension.zip');
    const zips = [];
    for (const path of [href, '/extension.zip']) {
      const r = await raw(path, H);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers['content-type'], 'application/zip', path);
      assert.equal(r.headers['content-disposition'], 'attachment; filename="pagebot-extension.zip"', path);
      assert.equal(r.headers['cache-control'], 'no-store', path);
      assert.equal(Number(r.headers['content-length']), r.body.length, path);
      const files = Object.fromEntries(readZip(r.body).map(f => [f.name, f.data.toString()]));
      assert.deepEqual(Object.keys(files).filter(n => !n.endsWith('/') && !n.startsWith('icons/')).sort(),
        ['README.txt', 'content.js', 'manifest.json', 'sidepanel.html', 'sidepanel.js', 'worker.js'], path);
      assert.match(files['sidepanel.js'], /const ORIGIN = "http:\/\/pagebot\.example\.test"/, path);
      assert.ok(JSON.parse(files['manifest.json']).permissions.includes('contextMenus'), path);
      assert.match(files['worker.js'], /title: 'Ask pagebot', contexts: \['selection'\]/, path);
      zips.push(r.body);
    }
    assert.ok(zips[0].equals(zips[1]), 'the same zip at both addresses');
  });

  await t.test('/widget may be framed by any site and by pagebot’s own extension (by its id); /chat, /admin and the homepage by nobody', async () => {
    const w = await raw('/widget');
    assert.match(w.headers['content-security-policy'], new RegExp(`frame-ancestors \\* chrome-extension://${EXT_ID}$`));
    for (const p of ['/chat', '/admin', '/']) assert.match((await raw(p)).headers['content-security-policy'], /frame-ancestors 'none'$/, p);
    const boot = await api('/api/boot', { token: null });
    assert.equal(boot.data.extVersion, 1);
    assert.equal(boot.data.version, 14);
  });

  await t.test('a bookmark panel gets exactly today’s toolset; the extension gets the members it lists; nobody else gets any', async () => {
    script = () => ({ text: 'Nothing to do.' });
    const toolset = async (body, token = owner) => { const base = calls.length; const r = await chat(body, { token }); assert.ok(r.done, JSON.stringify(r)); return calls[base].body; };
    const today = Object.fromEntries(BOOKMARK_OFF.map(n => [n, { enabled: false }]));
    const plain = await toolset({});
    assert.deepEqual(plain.tools[0], { type: 'browser_toolset_20260801', configs: today });
    assert.match(plain.system, /there are no other tabs, and you can't navigate/);
    assert.doesNotMatch(plain.system, /pagebot extension/);
    const full = await toolset(EXT);
    assert.deepEqual(full.tools[0], { type: 'browser_toolset_20260801', configs: { file_upload: { enabled: false }, read_console: { enabled: true }, read_network: { enabled: true }, javascript_exec: { enabled: true } } });
    assert.equal(full.tools[1].name, 'highlight');
    assert.match(full.system, /through the pagebot extension/);
    assert.match(full.system, /going to another site, switching to or closing a tab you didn't open, and running JavaScript always ask them/);
    assert.match(full.system, /untrusted content from the web/);
    const some = await toolset({ ...EXT, tools: ['navigate', 'type', 'bogus', 'file_upload', 7] });
    assert.deepEqual(BOOKMARK_OFF.filter(n => !some.tools[0].configs[n]), ['navigate', 'type'], 'only what it listed, and never file_upload');
    for (const body of [{ ...EXT, ext: 0 }, { ...EXT, ext: '1' }, { ...EXT, host: 'bookmark' }]) assert.deepEqual((await toolset(body)).tools[0].configs, today, JSON.stringify(body));
    const c = await toolset(EXT, carol);
    assert.equal(c.tools, undefined, 'an account without page actions gets no tools, extension or not');
    const base = calls.length;
    const r = await chat({ ...EXT, model: 'openrouter' });
    assert.ok(r.done);
    assert.equal(calls[base].provider, 'router');
    assert.equal(calls[base].body.tools, undefined);
    const al = await toolset(EXT, alice);
    assert.equal(al.tools[0].configs.navigate, undefined, 'an account allowed page actions gets them in the extension');
  });

  await t.test('every new member’s input is checked before it reaches the panel', async () => {
    const tools = [
      ['navigate', { url: 'javascript:alert(1)' }], ['navigate', { url: 'example.com' }], ['navigate', { url: 'back' }], ['navigate', { url: origin + '/chat' }],
      ['navigate', { url: 'https://a.test/' + 'x'.repeat(2000) }], ['navigate', { url: 'https://user:pw@a.test/' }], ['navigate', { url: 'localhost:8080/x' }],
      ['switch_tab', {}], ['switch_tab', { tab_id: 'x' }], ['close_tab', { tab_id: 'tab-2' }],
      ['type', { text: 'x'.repeat(5001) }], ['type', { text: 'hello' }],
      ['key', { text: 'Enter', repeat: 0 }], ['key', { text: 'Enter', repeat: 101 }], ['key', { text: 'ctrl+a Backspace', repeat: 2 }],
      ['hold_key', { text: 'shift', duration: 31 }], ['hold_key', { text: 'shift a', duration: 1 }],
      ['right_click', { target: coord(5, 5), modifiers: 'ctrl+banana' }], ['left_click', { target: coord(5, 5), modifiers: 'Shift' }],
      ['left_click_drag', { from: coord(1, 1), target: coord(2000, 1) }], ['left_click_drag', { from: coord(1, 1), target: coord(20, 30) }],
      ['javascript_exec', { text: '' }], ['javascript_exec', { text: 'document.title' }], ['file_upload', { target: { type: 'ref', ref: 'ref_1' }, paths: ['/etc/passwd'] }],
      ['list_tabs', { tab_id: 7 }],
    ];
    script = rounds([{ tools: [{ name: 'screenshot', input: {} }] }, ...tools.map(([name, input]) => ({ tools: [{ name, input }] }))]);
    const base = calls.length;
    const r = await chat(EXT, { onAct: async ev => {
      if (ev.name === 'screenshot') await act(ev.id, { result: { image: PNG, w: 800, h: 600, scale: 1 } });
      else if (ev.name === 'close_tab') await act(ev.id, { result: { tabs: TABS } });
      else await act(ev.id, { result: { tabs: TABS } });
    } });
    assert.ok(r.done, JSON.stringify(r.events.slice(-3)));
    const reached = r.acts.map(a => [a.name, a.input]);
    const out = i => toolResults(calls[base + 2 + i].body)[0];
    const err = (i, re) => { assert.equal(out(i).is_error, true, `${tools[i][0]} ${JSON.stringify(tools[i][1])}: ${said(out(i))}`); assert.match(said(out(i)), re); };
    err(0, /^Couldn’t do it|^Navigation refused\. Only http and https URLs are allowed\.$/);
    assert.equal(said(out(0)), 'Navigation refused. Only http and https URLs are allowed.');
    assert.deepEqual(reached.find(a => a[0] === 'navigate'), ['navigate', { url: 'https://example.com/' }], 'no scheme means https://, and javascript: never reached the panel');
    assert.ok(reached.some(a => a[0] === 'navigate' && a[1].url === 'back'));
    err(3, /pagebot doesn’t open its own pages/);
    err(4, /up to 2,000 characters/);
    err(5, /user name or password/);
    assert.ok(reached.some(a => a[0] === 'navigate' && a[1].url === 'https://localhost:8080/x'));
    err(7, /tab_id looks like "tab-12"/); err(8, /tab_id looks like "tab-12"/);
    assert.ok(reached.some(a => a[0] === 'close_tab' && a[1].tab_id === 'tab-2'));
    err(10, /up to 5,000 characters/);
    err(12, /repeat is a whole number from 1 to 100/); err(13, /repeat is a whole number from 1 to 100/);
    assert.ok(reached.some(a => a[0] === 'key' && a[1].text === 'ctrl+a Backspace' && a[1].repeat === 2));
    err(15, /duration is in seconds, from 0 to 30/); err(16, /one key or chord/);
    err(17, /modifiers is a chord/);
    assert.ok(reached.some(a => a[0] === 'left_click' && a[1].modifiers === 'shift' && a[1].target.x === 5), 'a point is fine in the extension');
    err(19, /outside the screenshot/);
    assert.ok(reached.some(a => a[0] === 'left_click_drag' && a[1].target.y === 30));
    err(21, /JavaScript to run/);
    assert.ok(reached.some(a => a[0] === 'javascript_exec' && a[1].text === 'document.title'));
    err(23, /There's no tool called file_upload here/);
    err(24, /tab_id looks like "tab-12"/);
    for (const a of r.acts) if (a.name !== 'screenshot' && a.name !== 'list_tabs') assert.equal(a.ask, true, `${a.name} may wait for a person`);
  });

  await t.test('a bookmark panel can’t click at a point, and none of the extension’s members are known to it', async () => {
    script = rounds([{ tools: [{ name: 'screenshot', input: {} }] }, { tools: [{ name: 'left_click', input: { target: coord(5, 5) } }] }, { tools: [{ name: 'type', input: { text: 'hi' } }] }]);
    const base = calls.length;
    const r = await chat({}, { onAct: ev => act(ev.id, { result: { image: PNG, w: 800, h: 600, scale: 1 } }) });
    assert.ok(r.done);
    assert.deepEqual(r.acts.map(a => a.name), ['screenshot']);
    assert.match(said(toolResults(calls[base + 2].body)[0]), /Clicking at a point isn’t available here/);
    assert.match(said(toolResults(calls[base + 3].body)[0]), /There's no tool called type here/);
  });

  await t.test('tab members answer with exactly one browser_state; other results carry it after their text; never on errors or highlight', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ tab_id: `tab-${i + 1}`, title: `T${i}`, url: `https://s${i}.test/p?q=${i}`, ...(i === 140 && { active: true }) }));
    const steps = [
      ['list_tabs', {}, { tabs: [{ tab_id: 'tab-1', title: 'Inbox\n(3) ', url: 'https://mail.test/inbox?token=abc#x', active: true }, { tab_id: 'tab-1', title: 'dup', url: 'https://x.test' }, { tab_id: 'bad', title: 'x', url: 'y' }, { tab_id: 'tab-9', title: 'blank', url: 'about:blank' }] }],
      ['new_tab', {}, { tabs: [...TABS.map(t => ({ ...t, active: false })), { tab_id: 'tab-3', title: '', url: 'about:blank', active: true }], opened: ['tab-3'] }],
      ['new_tab', {}, { tabs: TABS, opened: [] }],
      ['left_click', { target: coord(5, 5) }, { role: 'link', label: 'Deals', tab: 'https://shop.example.test/deals', tabs: [...TABS, { tab_id: 'tab-4', title: 'Deals', url: 'https://shop.example.test/deals' }], opened: ['tab-4'] }],
      ['list_tabs', {}, { tabs: many }],
      ['list_tabs', {}, { tabs: [{ ...TABS[0] }, { ...TABS[1], active: true }] }],
      ['type', { text: 'hi' }, { error: 'pagebot never reads or types into password fields.', tabs: TABS }],
      ['highlight', { quotes: ['x'] }, { found: [1], tabs: TABS }],
      ['navigate', { url: 'https://shop.example.test/' }, { url: 'https://shop.example.test/?ref=1', title: 'Shop', loading: true, tabs: TABS }],
      ['read_console', {}, { text: '', n: 0, tabs: TABS }],
      ['javascript_exec', { text: '1+1' }, { value: '2' }],
    ];
    script = rounds([{ tools: [{ name: 'screenshot', input: {} }] }, ...steps.map(([name, input]) => ({ tools: [{ name, input }] }))]);
    const base = calls.length;
    let i = 0;
    const r = await chat(EXT, { onAct: async ev => {
      if (ev.name === 'screenshot') return act(ev.id, { result: { image: PNG, w: 800, h: 600, scale: 1 } });
      await act(ev.id, { result: steps[i++][2] });
    } });
    assert.ok(r.done, JSON.stringify(r.events.slice(-3)));
    const out = k => toolResults(calls[base + 2 + k].body)[0];
    const lt = out(0);
    assert.equal(lt.toolset_name, 'browser');
    assert.equal(lt.is_error, undefined);
    assert.deepEqual(lt.content, [{ type: 'browser_state', tabs: [{ tab_id: 'tab-1', title: 'Inbox (3)', url: 'https://mail.test/inbox', active: true }, { tab_id: 'tab-9', title: 'blank', url: 'about:blank' }] }]);
    assert.deepEqual(out(1).content, [{ type: 'browser_state', tabs: [{ ...TABS[0], active: undefined }, TABS[1], { tab_id: 'tab-3', title: '', url: 'about:blank', active: true }].map(t => JSON.parse(JSON.stringify(t))), state_changes: [{ type: 'tab_opened', tab_id: 'tab-3' }] }]);
    assert.equal(out(2).is_error, true);
    assert.equal(said(out(2)), 'The new tab didn’t come through.');
    const click = out(3);
    assert.equal(click.content[0].type, 'text');
    assert.match(click.content[0].text, /^Clicked \(5, 5\) \(link "Deals"\)\. Another site opened in a new tab\.$/);
    assert.deepEqual(click.content[1].state_changes, [{ type: 'tab_opened', tab_id: 'tab-4' }]);
    assert.equal(click.content.length, 2);
    const big = out(4).content[0];
    assert.equal(big.tabs.length, 100);
    assert.ok(big.tabs.some(t => t.active && t.tab_id === 'tab-141'), 'the active tab is kept');
    assert.ok(big.tabs.every(t => !t.url.includes('?')));
    assert.equal(out(5).is_error, true, 'two active tabs: no block, so the tab member fails');
    assert.equal(out(6).is_error, true);
    assert.ok(!out(6).content.some(b => b.type === 'browser_state'), 'never on an error');
    assert.equal(out(7).toolset_name, undefined);
    assert.ok(!out(7).content.some(b => b.type === 'browser_state'), 'never on highlight');
    assert.equal(said(out(8)), 'Went to https://shop.example.test/. It’s still loading.');
    assert.equal(out(8).content.at(-1).type, 'browser_state');
    assert.equal(said(out(9)), 'Nothing new in the console since the last read.');
    assert.deepEqual(out(10).content, [{ type: 'text', text: 'Result: 2' }], 'no tabs sent, no block');
    const steps2 = JSON.parse((await db.query("SELECT steps FROM messages WHERE conversation_id=$1 AND role='assistant' ORDER BY id DESC LIMIT 1", [r.done.conversationId])).rows[0].steps);
    assert.deepEqual(steps2.slice(1, 4).map(s => [s.tool, s.text, s.outcome]), [['list_tabs', 'Looked at the tabs', 'done'], ['new_tab', 'Opened a tab', 'done'], ['new_tab', 'Opened a tab', 'failed']]);
    assert.ok(steps2.some(s => s.tool === 'javascript_exec' && s.text === 'Ran a script on the page'));
  });

  await t.test('a click that opens the same site in a new tab says so; only another site is called another site', async () => {
    const click = (tab, sameSite) => ({ role: 'link', label: 'Page B', tab, ...(sameSite && { sameSite }) });
    script = rounds([{ tools: [{ name: 'screenshot', input: {} }] }, { tools: [{ name: 'left_click', input: { target: coord(5, 5), modifiers: 'ctrl' } }] }, { tools: [{ name: 'left_click', input: { target: coord(5, 5) } }] }]);
    const base = calls.length;
    const results = [click('https://news.example.test/b', true), click('https://other.example.test/', 'yes')];
    const r = await chat(EXT, { onAct: ev => act(ev.id, { result: ev.name === 'screenshot' ? { image: PNG, w: 800, h: 600, scale: 1 } : results.shift() }) });
    assert.ok(r.done, JSON.stringify(r.events.slice(-3)));
    assert.equal(said(toolResults(calls[base + 2].body)[0]), 'Clicked (5, 5) (link "Page B"). It opened in a new tab.');
    assert.equal(said(toolResults(calls[base + 3].body)[0]), 'Clicked (5, 5) (link "Page B"). Another site opened in a new tab.', 'only a real true counts');
  });

  await t.test('waits: tab listing is quick, anything a person may decide waits minutes, and holding a key adds its time', async () => {
    script = rounds([{ tools: [{ name: 'list_tabs', input: {} }, { name: 'navigate', input: { url: 'reload' } }, { name: 'hold_key', input: { text: 'shift', duration: 3 } }, { name: 'read_page', input: {} }] }]);
    const r = await chat(EXT, { onAct: ev => act(ev.id, { result: ev.name === 'list_tabs' ? { tabs: TABS } : { url: 'https://news.example.test/a', tabs: TABS, text: 'x' } }) });
    assert.ok(r.done);
    assert.deepEqual(r.acts.map(a => [a.name, a.wait]), [['list_tabs', 20000 * SCALE], ['navigate', 300000 * SCALE], ['hold_key', 303000 * SCALE], ['read_page', 300000 * SCALE]]);
    assert.deepEqual(r.acts.map(a => a.ask), [false, true, true, false]);
  });

  await t.test('the zip route is limited to 30 a minute', async () => {
    let status = 200, n = 0;
    while (status === 200 && n < 40) { status = (await raw('/pagebot-extension.zip')).status; n++; }
    assert.equal(status, 429);
    assert.ok(n <= 31, `limited after ${n}`);
  });
});

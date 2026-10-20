import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// How the features add up: every model call a question makes is billed to the daily limit, however it ends, and no
// request breaks the API's rules when a PDF, page actions, web search and history meet. Real server, isolated
// PostgreSQL schema, local mock model (no real API calls).
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const ADMIN = 'review-test-admin-token-0123456789';
let db, adminDb, app, mock, mockOrigin, origin, owner;
const calls = [];
let script = null, ip = 0, users = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pdfFile = (pages = 2, tag = '') => Buffer.from('%PDF-1.4\n%' + tag + '\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
  `2 0 obj << /Type /Pages /Count ${pages} >> endobj\n` +
  Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`).join('') + 'trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
// one model reply. spec: text, tools, stop ('pause_turn'...), usage {input_tokens, output_tokens, cache_read_input_tokens},
// hold (a promise to wait for before answering), status (an HTTP error instead), cut (hang up after the text)
async function sse(res, body, spec = {}) {
  if (spec.hold) await spec.hold;
  if (spec.status) { res.writeHead(spec.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'mock says no' } })); }
  const usage = { input_tokens: 20, output_tokens: 5, ...spec.usage };
  const ev = [{ type: 'message_start', message: { id: 'msg_' + randomBytes(4).toString('hex'), type: 'message', role: 'assistant', content: [], model: body.model,
    stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } }];
  let i = 0;
  if (spec.text || !spec.tools?.length) {
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: spec.text || 'A local fixture answer.' } },
      { type: 'content_block_stop', index: i });
    i++;
  }
  for (const t of spec.tools || []) {
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'toolu_' + randomBytes(6).toString('hex'), name: t.name, input: {}, ...(t.name !== 'highlight' && { toolset_name: 'browser' }) } }, // browser toolset members name their toolset
      { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input || {}) } },
      { type: 'content_block_stop', index: i });
    i++;
  }
  const stop = spec.stop || (spec.tools?.length ? 'tool_use' : 'end_turn');
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of ev.slice(0, spec.cut ? 3 : undefined)) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  if (spec.cut) return setTimeout(() => res.destroy(), 20);
  res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })}\n\n`);
  res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
}
async function api(route, { token = owner, admin, method = 'GET', body } = {}) {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(admin && { 'x-admin-token': ADMIN }), ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, data: r.headers.get('content-type')?.includes('ndjson')
    ? text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(text || '{}') };
}
async function upload(bytes, { token = owner, name = 'report.pdf' } = {}) {
  ip++;
  const r = await fetch(`${origin}/api/pdf?name=${encodeURIComponent(name)}`, { method: 'POST', body: bytes,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), 'Content-Type': 'application/pdf', 'X-Forwarded-For': `10.77.${ip >> 8 & 255}.${ip & 255}` } });
  return { status: r.status, data: await r.json().catch(() => null) };
}
// a chat, reading the stream as it comes so a test can answer each {t:'act'} or hang up
async function chat(body = {}, { token = owner, onAct, signal } = {}) {
  const r = await fetch(origin + '/api/chat', { method: 'POST', signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Please help.', ...body }) });
  if (!r.headers.get('content-type')?.includes('ndjson')) return { status: r.status, events: [], error: (await r.json()).error };
  const events = [], reader = r.body.getReader(), dec = new TextDecoder();
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
      if (ev.t === 'act' && onAct) await onAct(ev);
    }
  }
  return { status: r.status, events, done: events.find(e => e.t === 'done'), acts: events.filter(e => e.t === 'act'), error: events.find(e => e.t === 'err')?.v };
}
const answerAct = ev => api('/api/chat/act', { method: 'POST', token: ev.token, body: { id: ev.id, note: 'Read it', result: { url: 'https://x.example/', title: 'X', text: 'Fresh.' } } });
async function session(userId = null) {
  const token = randomBytes(24).toString('hex');
  await db.query('INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), userId]);
  return token;
}
// a trusted account with a daily limit (tokens) and its session
async function account(limit = 100_000, extra = '') {
  const name = 'rev' + ++users;
  const id = Number((await db.query(`INSERT INTO users(username,password_hash,status,limit_kind,limit_value) VALUES ($1,'x','trusted','tokens',$2) RETURNING id`, [name, limit])).rows[0].id);
  if (extra) await db.query(`UPDATE users SET ${extra} WHERE id=$1`, [id]);
  return { id, name, token: await session(id) };
}
const spent = async id => Number((await db.query('SELECT COALESCE(SUM(input_tokens+output_tokens),0) AS n FROM messages WHERE user_id=$1', [id])).rows[0].n);
// every cache_control marker in a request, wherever it sits (the API allows 4)
const breakpoints = body => (JSON.stringify(body).match(/"cache_control"/g) || []).length;

// the database as the original release (before accounts' bans, the dashboard and the four newer features) left it
const OLD_SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users (id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', note TEXT, admin_note TEXT,
  limit_kind TEXT, limit_value NUMERIC, allow_sonnet BOOLEAN NOT NULL DEFAULT true, allow_web BOOLEAN NOT NULL DEFAULT true, prefs TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), approved_at TIMESTAMPTZ, last_seen TIMESTAMPTZ);
CREATE UNIQUE INDEX users_name_idx ON users (lower(username));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used TIMESTAMPTZ NOT NULL DEFAULT now(), user_id BIGINT REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE conversations (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), page_url TEXT, page_title TEXT, user_id BIGINT, memory_site TEXT);
CREATE TABLE messages (id BIGSERIAL PRIMARY KEY, conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL,
  had_image BOOLEAN NOT NULL DEFAULT false, input_tokens INT NOT NULL DEFAULT 0, output_tokens INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model TEXT, web_searches INT NOT NULL DEFAULT 0, refused BOOLEAN NOT NULL DEFAULT false, user_id BIGINT, cost_usd NUMERIC(14,6), incomplete BOOLEAN NOT NULL DEFAULT false,
  page_doc TEXT, theme TEXT);
`;

// a server on its own port against one PostgreSQL schema; stop() ends it
async function startApp(name, mockOrigin) {
  const url = new URL(database);
  url.searchParams.set('options', `-csearch_path=${name}`);
  const portServer = createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const o = `http://127.0.0.1:${port}`, out = { origin: o, logs: '', url: url.href };
  const proc = spawn(process.execPath, ['--import', './tests/helpers/local-model.mjs', 'server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: url.href, PGSSL: 'false', PORT: String(port),
      INITIAL_PASSWORD: '', ADMIN_TOKEN: ADMIN, ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: mockOrigin,
      OPENROUTER_API_KEY: 'local-fixture-only', OPENROUTER_MODEL: 'meta/muse-spark-1.3-contributor', PAGEBOT_MOCK_MODEL_ORIGIN: mockOrigin, SYSTEM_PROMPT: 'You are a test helper.', TIMEZONE: 'UTC', PAGEBOT_TEST_ACT_WAIT_SCALE: '0.1' },
  });
  proc.stdout.on('data', chunk => { out.logs += chunk; });
  proc.stderr.on('data', chunk => { out.logs += chunk; });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (proc.exitCode != null) throw new Error(`Test server exited: ${out.logs}`);
    try { ready = (await fetch(o + '/health')).ok; } catch { /* starting */ }
    if (!ready) await sleep(100);
  }
  assert.ok(ready, `Server failed to start: ${out.logs}`);
  out.stop = async () => { if (proc.exitCode == null) { proc.kill(); await once(proc, 'exit'); } };
  return out;
}

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
    if (req.url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 1234 }));
    }
    const n = calls.push({ body, router: req.url === '/router' }) - 1;
    if (req.url === '/router') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A router answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 6, cost: 0.00002 } })}\n\ndata: [DONE]\n\n`);
    }
    await sse(res, body, script ? script(body, n) : {});
  }).listen(0, '127.0.0.1');
  await once(mock, 'listening');
  mockOrigin = `http://127.0.0.1:${mock.address().port}`;
  app = await startApp(schema, mockOrigin);
  origin = app.origin;
  owner = await session();
});

after(async () => {
  await app?.stop();
  if (mock) await new Promise(resolve => mock.close(resolve));
  await db?.end();
  if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
});

test('accounting and request shape across features', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  await t.test('a paused search turn is only continued while today’s limit has room', async () => {
    const a = await account(20_000);
    const base = calls.length;
    // every continuation re-sends the prompt, so each call costs 6,500 tokens: the limit has room for three, not four
    script = (body, n) => ({ stop: 'pause_turn', text: 'Looking. ', usage: { input_tokens: 6450, output_tokens: 50 } });
    const r = await chat({ message: 'Search please', web: true }, { token: a.token });
    assert.ok(r.done, JSON.stringify(r.events));
    assert.ok(await spent(a.id) <= 20_000, `billed ${await spent(a.id)} against a limit of 20000 in ${calls.length - base} calls`);
  });

  await t.test('three PDFs, a page and page actions together never put more than 4 cache breakpoints in a request', async () => {
    const a = await account(10_000_000);
    script = () => ({ text: 'Fine.' });
    let conv = null;
    for (const tag of ['one', 'two', 'three']) {
      const up = await upload(pdfFile(2, tag), { token: a.token });
      const r = await chat({ pdf: up.data.id, conversationId: conv, message: 'About ' + tag }, { token: a.token });
      assert.ok(r.done, JSON.stringify(r.events));
      conv = r.done.conversationId;
    }
    const base = calls.length;
    script = (body, n) => n === base ? { tools: [{ name: 'read_page', input: {} }] } : { text: 'Done.' };
    const r = await chat({ conversationId: conv, message: 'Now act', actions: true, cite: true, page: { url: 'https://x.example/', title: 'X', text: 'A page.' } },
      { token: a.token, onAct: ev => api('/api/chat/act', { method: 'POST', token: a.token, body: { id: ev.id, result: { url: 'https://x.example/', title: 'X', text: 'Fresh.' } } }) });
    assert.ok(r.done, JSON.stringify(r.events));
    assert.equal(calls.length - base, 2);
    for (const c of calls.slice(base)) assert.ok(breakpoints(c.body) <= 4, `${breakpoints(c.body)} cache breakpoints in one request`);
  });

  await t.test('a paused turn still carries on when there is room', async () => {
    const base = calls.length;
    script = (body, n) => n === base ? { stop: 'pause_turn', text: 'Looking. ' } : { text: 'Found it.' };
    const r = await chat({ message: 'Search please', web: true });
    assert.equal(r.done.stop, 'end_turn');
    assert.equal(calls.length - base, 2);
    assert.equal(calls[base + 1].body.messages.at(-1).role, 'assistant', 'the paused turn is resent as it was');
  });

  await t.test('a question with a NUL character is still saved and billed', async () => {
    const a = await account(100_000);
    script = () => ({ text: 'Fine.', usage: { input_tokens: 300, output_tokens: 20 } });
    const r = await chat({ message: 'hi\u0000 there', selection: 'a\u0000b' }, { token: a.token });
    assert.ok(r.done, JSON.stringify(r.events));
    assert.equal(await spent(a.id), 320, 'PostgreSQL text can’t hold NUL, so an unsanitised question would lose its usage row');
    script = () => ({ text: 'a\u0000b', usage: { input_tokens: 300, output_tokens: 20 } }); // and so can't an answer
    assert.ok((await chat({ message: 'Print a NUL' }, { token: a.token })).done);
    assert.equal(await spent(a.id), 640);
  });

  await t.test('a PDF pushed out by newer uploads mid-answer is still billed', async () => {
    const a = await account(100_000);
    const up = await upload(pdfFile(2, 'evict0'), { token: a.token });
    let release; const hold = new Promise(r => { release = r; });
    const base = calls.length;
    script = () => ({ hold, text: 'Late answer.', usage: { input_tokens: 500, output_tokens: 20 } });
    const running = chat({ pdf: up.data.id }, { token: a.token });
    while (calls.length === base) await sleep(20);
    for (let i = 1; i <= 11; i++) assert.equal((await upload(pdfFile(2, 'evict' + i), { token: a.token })).status, 200); // 10 unused uploads are kept
    assert.equal(Number((await db.query('SELECT count(*) FROM attachments WHERE id=$1', [up.data.id])).rows[0].count), 0, 'the answering PDF was swept away');
    release();
    const r = await running;
    assert.ok(r.done, JSON.stringify(r.events));
    assert.equal(await spent(a.id), 520);
  });

  await t.test('hanging up mid-answer bills what was used, and the chat keeps the stopped answer', async () => {
    const a = await account(100_000);
    script = () => ({ cut: true, text: 'Half an ans', usage: { input_tokens: 400, output_tokens: 20 } });
    const r = await chat({ message: 'Cut me off' }, { token: a.token }).catch(e => ({ events: [], error: String(e) }));
    for (let i = 0; i < 50 && !(await spent(a.id)); i++) await sleep(50);
    assert.ok(await spent(a.id) >= 400, 'the prompt was billed');
    const row = (await db.query("SELECT incomplete, content FROM messages WHERE user_id=$1 AND role='assistant'", [a.id])).rows[0];
    assert.equal(row.incomplete, true);
  });

  await t.test('an error in a later round keeps the earlier rounds’ usage and the answer so far', async () => {
    const a = await account(1_000_000);
    const base = calls.length;
    script = (body, n) => n === base ? { text: 'Checking. ', tools: [{ name: 'read_page' }], usage: { input_tokens: 700, output_tokens: 30 } } : { status: 400 };
    const r = await chat({ message: 'Act', actions: true }, { token: a.token, onAct: ev => api('/api/chat/act', { method: 'POST', token: a.token, body: { id: ev.id, result: { url: 'u', title: 't', text: 'x' } } }) });
    assert.ok(r.error, JSON.stringify(r.events));
    assert.equal(await spent(a.id), 730);
    assert.deepEqual(r.events.find(e => e.t === 'err').quota, { pct: 0.07 }, 'the usage bar hears about what the broken-off answer used (730 of 1,000,000), as a percentage only');
    const row = (await db.query("SELECT incomplete, content, steps FROM messages WHERE user_id=$1 AND role='assistant'", [a.id])).rows[0];
    assert.equal(row.incomplete, true);
    assert.match(row.content, /Checking/);
    assert.equal(JSON.parse(row.steps).length, 1);
  });

  await t.test('a closed panel while a page step waits still bills the finished round', async () => {
    const a = await account(1_000_000);
    const base = calls.length, ac = new AbortController();
    script = (body, n) => ({ tools: [{ name: 'left_click', input: { target: { type: 'ref', ref: 'ref_1' } } }], usage: { input_tokens: 900, output_tokens: 10 } });
    const r = await chat({ message: 'Act', actions: true }, { token: a.token, signal: ac.signal, onAct: () => ac.abort() }).catch(() => null);
    for (let i = 0; i < 50 && !(await spent(a.id)); i++) await sleep(50);
    assert.equal(await spent(a.id), 910);
    assert.equal(calls.length - base, 1, 'no more rounds once the panel is gone');
  });

  await t.test('a database from the original release upgrades in place, and starting twice changes nothing', async () => {
    const old = `pagebot_test_${randomBytes(8).toString('hex')}`;
    await adminDb.query(`CREATE SCHEMA ${old}`);
    const odb = new pg.Pool({ connectionString: (() => { const u = new URL(database); u.searchParams.set('options', `-csearch_path=${old}`); return u.href; })() });
    let first, second;
    try {
      await odb.query(OLD_SCHEMA);
      const uid = Number((await odb.query(`INSERT INTO users(username,password_hash,status,limit_kind,limit_value) VALUES ('olduser','x','trusted','tokens',50000) RETURNING id`)).rows[0].id);
      const tok = randomBytes(24).toString('hex');
      await odb.query('INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)', [createHash('sha256').update(tok).digest('hex'), uid]);
      const conv = Number((await odb.query(`INSERT INTO conversations(page_url,page_title,user_id) VALUES ('https://old.example/a','Old page',$1) RETURNING id`, [uid])).rows[0].id);
      await odb.query(`INSERT INTO messages(conversation_id,role,content,user_id,created_at) VALUES ($1,'user','Old question',$2,now()-interval '2 minutes')`, [conv, uid]);
      await odb.query(`INSERT INTO messages(conversation_id,role,content,user_id,input_tokens,output_tokens,model,web_searches,created_at) VALUES ($1,'assistant','Old answer',$2,1000,200,'claude-haiku-5-5',1,now()-interval '1 minute')`, [conv, uid]);
      first = await startApp(old, mockOrigin);
      const look = async o => {
        const h = { Authorization: `Bearer ${tok}` };
        const boot = await (await fetch(o + '/api/boot', { headers: h })).json();
        const chats = await (await fetch(o + '/api/chats', { headers: h })).json();
        const one = await (await fetch(`${o}/api/chats/${conv}`, { headers: h })).json();
        return { boot, chats, one, rows: (await odb.query('SELECT id, cost_usd::text AS cost, attachment_id, steps, meta FROM messages ORDER BY id')).rows,
          conv: (await odb.query('SELECT updated_at IS NOT NULL AS stamped, hidden_at FROM conversations')).rows };
      };
      const a = await look(first.origin);
      assert.deepEqual(a.boot.quota, { pct: 2 }, 'the old rows count toward today’s limit (1,200 of 50,000)');
      assert.equal(a.boot.user.allowPdf, true); assert.equal(a.boot.user.allowActions, true);
      assert.equal(a.chats.chats[0].id, conv); assert.equal(a.chats.chats[0].title, 'Old question');
      assert.deepEqual(a.one.messages.map(m => [m.role, m.text]), [['user', 'Old question'], ['assistant', 'Old answer']]);
      assert.equal(a.rows[1].cost, '0.010200', 'costs of rows from before costs were tracked are filled in (1000 in, 200 out, one search)');
      assert.equal(a.conv[0].stamped, true);
      // the upgraded database answers a question, then a second start leaves everything as it was
      script = () => ({ text: 'New answer.', usage: { input_tokens: 100, output_tokens: 10 } });
      const asked = await fetch(first.origin + '/api/chat', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'New question', conversationId: conv }) });
      assert.match(await asked.text(), /"t":"done"/);
      const before = await look(first.origin);
      await first.stop(); first = null;
      second = await startApp(old, mockOrigin);
      const after = await look(second.origin);
      assert.deepEqual(after.rows, before.rows);
      assert.deepEqual(after.boot.quota, before.boot.quota);
      assert.deepEqual(after.one.messages, before.one.messages);
      assert.equal(after.one.messages.length, 4);
      assert.doesNotMatch(second.logs, /error/i);
    } finally {
      await first?.stop(); await second?.stop(); await odb.end();
      await adminDb.query(`DROP SCHEMA IF EXISTS ${old} CASCADE`);
    }
  });

  await t.test('one answer at a time: a second question while one runs is refused, and the lock is freed on every way out', async () => {
    const a = await account(1_000_000);
    let release; const hold = new Promise(r => { release = r; });
    let base = calls.length;
    script = () => ({ hold, text: 'Slow.' });
    const first = chat({ message: 'One' }, { token: a.token });
    while (calls.length === base) await sleep(20);
    const second = await chat({ message: 'Two' }, { token: a.token });
    assert.equal(second.status, 429);
    release();
    assert.ok((await first).done);
    // early returns (400s before the model), a model error, and a hang-up all give the lock back
    assert.equal((await chat({ message: '', page: null }, { token: a.token })).status, 400);
    assert.equal((await chat({ message: 'x', image: 'nope' }, { token: a.token })).status, 400);
    assert.equal((await chat({ message: 'x', pdf: 999999 }, { token: a.token })).status, 404);
    script = () => ({ status: 400 });
    assert.ok((await chat({ message: 'Errors' }, { token: a.token })).error);
    base = calls.length;
    script = () => ({ cut: true, text: 'Half' });
    await chat({ message: 'Cut' }, { token: a.token }).catch(() => null);
    script = () => ({ text: 'Fine.' });
    let again;
    for (let i = 0; i < 40; i++) { again = await chat({ message: 'Again' }, { token: a.token }); if (again.status !== 429) break; await sleep(50); }
    assert.ok(again.done, JSON.stringify(again));
  });

  await t.test('chaining page-action rounds stops before today’s limit, and the rounds are all billed', async () => {
    const a = await account(14000); // (the browser toolset's schemas make the first prompt's estimate about 5,000 tokens)
    const base = calls.length;
    script = () => ({ tools: [{ name: 'read_page' }], usage: { input_tokens: 2500, output_tokens: 20 } });
    const r = await chat({ message: 'Keep reading', actions: true }, { token: a.token,
      onAct: ev => api('/api/chat/act', { method: 'POST', token: a.token, body: { id: ev.id, result: { url: 'u', title: 't', text: 'x' } } }) });
    assert.ok(r.done, JSON.stringify(r.events));
    assert.ok(calls.length - base >= 2 && calls.length - base < 6, `${calls.length - base} rounds`);
    assert.equal(await spent(a.id), 2520 * (calls.length - base));
    assert.ok(await spent(a.id) <= 14000);
    assert.match(r.events.filter(e => e.t === 'd').map(e => e.v).join(''), /Stopped here/);
  });

  await t.test('a PDF is counted against the limit on every question that sends it, and removing chats from history resets nothing', async () => {
    const a = await account(4000);
    const up = await upload(pdfFile(2, 'big'), { token: a.token }); // the mock counts 1,234 tokens for it
    script = () => ({ text: 'Read it.', usage: { input_tokens: 1300, output_tokens: 10 } });
    const first = await chat({ pdf: up.data.id, message: 'Summarize' }, { token: a.token });
    assert.ok(first.done, JSON.stringify(first.events));
    const conv = first.done.conversationId;
    const q = async () => (await api('/api/boot', { token: a.token })).data.quota;
    assert.deepEqual(await q(), { pct: 33 }); // 1,310 of 4,000
    assert.equal(await spent(a.id), 1310);
    const second = await chat({ conversationId: conv, message: 'More' }, { token: a.token });
    assert.ok(second.done, JSON.stringify(second.events));
    assert.deepEqual(await q(), { pct: 66 }); // 2,620
    assert.equal(await spent(a.id), 2620);
    const stats = (await api('/api/admin/stats', { token: null, admin: true })).data;
    const wrapped = (await api('/api/wrapped', { token: a.token })).data;
    assert.equal((await api('/api/chats?all=1', { method: 'DELETE', token: a.token })).status, 200);
    assert.deepEqual(await q(), { pct: 66 }, 'removing a chat from history keeps what it used');
    assert.equal(await spent(a.id), 2620);
    assert.deepEqual((await api('/api/admin/stats', { token: null, admin: true })).data.total, stats.total);
    assert.equal((await api('/api/wrapped', { token: a.token })).data.questions, wrapped.questions);
    // with 1,380 left, the next question's PDF alone (1,234) leaves no room for an answer
    const base = calls.length;
    const third = await chat({ message: 'A new chat, same PDF', pdf: up.data.id }, { token: a.token });
    assert.equal(third.status === 429 || !!third.error, true, JSON.stringify(third));
    assert.equal(calls.length, base, 'nothing reached the model');
  });

  await t.test('a restriction’s daily limit is the one checked, and the one the usage bar is a percentage of', async () => {
    const a = await account(1_000_000);
    const res = await api(`/api/admin/users/${a.id}/ban`, { admin: true, token: null, method: 'POST', body: { kind: 'restrict', hours: 1, reason: 'Testing', limitKind: 'tokens', limitValue: 3000 } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual((await api('/api/boot', { token: a.token })).data.quota, { pct: 0 });
    script = () => ({ text: 'Fine.', usage: { input_tokens: 2900, output_tokens: 10 } });
    const base = calls.length;
    const first = await chat({ message: 'One' }, { token: a.token });
    assert.deepEqual(first.done.quota, { pct: 97 }); // 2,910 of the restricted 3,000
    const second = await chat({ message: 'Two' }, { token: a.token });
    assert.equal(second.status, 429);
    assert.equal(calls.length - base, 1);
    await api(`/api/admin/users/${a.id}/ban?kind=restrict`, { admin: true, token: null, method: 'DELETE' });
    assert.ok((await chat({ message: 'Three' }, { token: a.token })).done, 'their own limit is back when it ends');
  });

  await t.test('OpenRouter gets plain text only: no PDFs, tools or cache markers, and a chat with a PDF is refused before spending anything', async () => {
    const a = await account(1_000_000);
    script = () => ({ text: 'Fine.' });
    // a chat with a page, a screenshot and page-action steps in it, continued on OpenRouter
    const first = await chat({ message: 'About the page', actions: true, page: { url: 'https://x.example/', title: 'X', text: 'Page text.' }, cite: true }, { token: a.token });
    const conv = first.done.conversationId;
    await db.query("UPDATE messages SET steps = $2 WHERE conversation_id = $1 AND role = 'assistant'", [conv, JSON.stringify([{ tool: 'click', text: 'Clicked Next', outcome: 'done' }])]);
    const base = calls.length;
    const r = await chat({ message: 'And now?', conversationId: conv, model: 'openrouter', actions: true, web: true, image: 'data:image/png;base64,AAAA' }, { token: a.token });
    assert.ok(r.done, JSON.stringify(r.events));
    const sent = calls[base];
    assert.equal(sent.router, true);
    assert.equal(breakpoints(sent.body), 0);
    assert.ok(!sent.body.tools?.some(x => x.type === 'browser_toolset_20260801' || x.name === 'highlight'), 'no page tools');
    assert.doesNotMatch(JSON.stringify(sent.body.messages), /"type":"document"|"citations"/);
    assert.match(JSON.stringify(sent.body.messages), /Page actions I took in this answer/);
    assert.equal(await spent(a.id), 25 + 46, 'its prompt and answer tokens are billed like the others');
    // a chat that has a PDF in it can't go to OpenRouter, and nothing is spent or kept
    const up = await upload(pdfFile(2, 'router'), { token: a.token });
    const withPdf = await chat({ message: 'About it', pdf: up.data.id }, { token: a.token });
    const before = calls.length, spentBefore = await spent(a.id);
    const refused = await chat({ message: 'And more?', conversationId: withPdf.done.conversationId, model: 'openrouter' }, { token: a.token });
    assert.equal(refused.status, 400);
    assert.equal(calls.length, before);
    assert.equal(await spent(a.id), spentBefore);
  });

  await t.test('newly accepted accounts start with the defaults, PDF uploads and page actions included', async () => {
    const id = Number((await db.query(`INSERT INTO users(username,password_hash,status) VALUES ('waiting','x','pending') RETURNING id`)).rows[0].id);
    const set = await api('/api/admin/accounts', { admin: true, token: null, method: 'POST', body: { defaults: { allowPdf: false, allowActions: false, allowWeb: false, limitKind: 'usd', limitValue: 0.25 } } });
    assert.deepEqual([set.data.defaults.allowPdf, set.data.defaults.allowActions], [false, false]);
    assert.equal((await api(`/api/admin/users/${id}`, { admin: true, token: null, method: 'POST', body: { status: 'trusted' } })).status, 200);
    const u = (await api('/api/admin/users', { admin: true, token: null })).data.users.find(x => x.id === id);
    assert.deepEqual([u.allowSonnet, u.allowWeb, u.allowPdf, u.allowActions, u.limitKind, u.limitValue], [true, false, false, false, 'usd', 0.25]);
    await api('/api/admin/accounts', { admin: true, token: null, method: 'POST', body: { defaults: { allowPdf: true, allowActions: true, allowWeb: true, limitKind: 'tokens', limitValue: 100000 } } });
  });
});

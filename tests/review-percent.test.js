import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// What accounts see of their daily limit: a percentage and nothing else, in every response the panel gets. The owner keeps
// the amounts. Real server, isolated PostgreSQL schema, local mock model (no real API calls).
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const ADMIN = 'percent-test-admin-token-0123456789';
let db, adminDb, app, mock, mockOrigin, origin, owner;
const calls = [];
let script = null, users = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// one model reply. spec: text, tools, stop ('pause_turn'...), usage {input_tokens, output_tokens, cache_read_input_tokens},
// hold (a promise to wait for before answering), status (an HTTP error instead), cut (hang up after the text)
async function sse(res, body, spec = {}) {
  if (spec.hold) await spec.hold;
  if (spec.status) { res.writeHead(spec.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: spec.message || 'mock says no' } })); }
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
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'toolu_' + randomBytes(6).toString('hex'), name: t.name, input: {} } },
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
async function session(userId = null) {
  const token = randomBytes(24).toString('hex');
  await db.query('INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), userId]);
  return token;
}
// a trusted account with a daily limit (tokens or usd) and its session
async function account(limit = 100_000, extra = '', kind = 'tokens') {
  const name = 'pct' + ++users;
  const id = Number((await db.query(`INSERT INTO users(username,password_hash,status,limit_kind,limit_value) VALUES ($1,'x','trusted',$3,$2) RETURNING id`, [name, limit, kind])).rows[0].id);
  if (extra) await db.query(`UPDATE users SET ${extra} WHERE id=$1`, [id]);
  return { id, name, token: await session(id) };
}
const spent = async id => Number((await db.query('SELECT COALESCE(SUM(input_tokens+output_tokens),0) AS n FROM messages WHERE user_id=$1', [id])).rows[0].n);
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

// the only shapes accounts may get, and what no response for them may say
const AMOUNT = /\$\s?\d|\d+(\.\d+)?\s*K?\s*tokens/i;
const noAmounts = (what, v) => assert.doesNotMatch(typeof v === 'string' ? v : JSON.stringify(v), AMOUNT, `${what} has an amount in it`);
const onlyPct = (what, q) => { assert.deepEqual(Object.keys(q), ['pct'], `${what}: only a percentage`); assert.equal(typeof q.pct, 'number'); };
const boot = async token => (await api('/api/boot', { token })).data;
// rows for an account as if it had used this much today (one chat, one answer)
async function use(id, { tokens = 0, usd = 0 }) {
  const conv = Number((await db.query(`INSERT INTO conversations(user_id) VALUES ($1) RETURNING id`, [id])).rows[0].id);
  await db.query(`INSERT INTO messages(conversation_id, role, content, user_id) VALUES ($1,'user','Q',$2)`, [conv, id]);
  await db.query(`INSERT INTO messages(conversation_id, role, content, user_id, input_tokens, output_tokens, model, cost_usd) VALUES ($1,'assistant','A',$2,$3,0,'claude-haiku-5-5',$4)`, [conv, id, tokens, usd]);
  return conv;
}

test('accounts see their daily limit as a percentage only', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  await t.test('a token limit: boot, the done event and the answer’s own share are percentages', async () => {
    const a = await account(10_000);
    onlyPct('boot quota', (await boot(a.token)).quota);
    assert.deepEqual((await boot(a.token)).quota, { pct: 0 });
    script = () => ({ text: 'Fine.', usage: { input_tokens: 700, output_tokens: 50 } });
    const r = await chat({ message: 'Hello' }, { token: a.token });
    assert.ok(r.done, JSON.stringify(r.events));
    assert.deepEqual(r.done.quota, { pct: 8 }, '750 of 10,000 is 7.5%, shown as a whole number');
    assert.deepEqual(r.done.usage, { pct: 7.5 }, 'what this answer used, as its share of the limit');
    assert.equal(await spent(a.id), 750, 'the exact numbers still count');
    assert.deepEqual((await boot(a.token)).quota, { pct: 8 });
    const wire = JSON.stringify(r.events);
    assert.doesNotMatch(wire, /"(usd|in|out|used|left|limit|kind)":/, 'no amounts anywhere in the stream');
  });

  await t.test('a dollar limit is the same: percentages, no dollars', async () => {
    const a = await account(0.02, '', 'usd');
    assert.deepEqual((await boot(a.token)).quota, { pct: 0 });
    script = () => ({ text: 'Fine.', usage: { input_tokens: 40_000, output_tokens: 2000 } }); // $0.004 + $0.001 on Haiku
    const r = await chat({ message: 'Hello' }, { token: a.token });
    assert.ok(r.done, JSON.stringify(r.events));
    assert.deepEqual(r.done.quota, { pct: 25 });
    assert.deepEqual(r.done.usage, { pct: 25 });
    assert.doesNotMatch(JSON.stringify(r.events), /"(usd|in|out|used|left|limit|kind)":/);
    assert.deepEqual((await boot(a.token)).quota, { pct: 25 });
  });

  await t.test('an account without a limit gets no quota and no amounts in the done event', async () => {
    const a = await account(1, 'limit_kind = NULL, limit_value = NULL');
    assert.equal((await boot(a.token)).quota, null);
    script = () => ({ text: 'Fine.', usage: { input_tokens: 700, output_tokens: 50 } });
    const r = await chat({ message: 'Hello' }, { token: a.token });
    assert.ok(r.done, JSON.stringify(r.events));
    assert.deepEqual(r.done.usage, {});
    assert.equal(r.done.quota, undefined);
  });

  await t.test('an answer that breaks off still moves the bar, as a percentage', async () => {
    const a = await account(10_000);
    const base = calls.length;
    script = (body, n) => n === base ? { text: 'Checking. ', tools: [{ name: 'read_page' }], usage: { input_tokens: 700, output_tokens: 30 } } : { status: 400 };
    const r = await chat({ message: 'Act', actions: true }, { token: a.token,
      onAct: ev => api('/api/chat/act', { method: 'POST', token: a.token, body: { id: ev.id, result: { url: 'u', title: 't', text: 'x' } } }) });
    const err = r.events.find(e => e.t === 'err');
    assert.ok(err, JSON.stringify(r.events));
    assert.deepEqual(err.quota, { pct: 7 }, '730 of 10,000');
    onlyPct('err quota', err.quota);
  });

  await t.test('the API’s own error text never carries token amounts to an account, but the owner still sees it', async () => {
    const a = await account(10_000);
    script = () => ({ status: 400, message: 'prompt is too long: 250000 tokens > 200000 maximum' });
    const r = await chat({ message: 'Hello' }, { token: a.token });
    const err = r.events.find(e => e.t === 'err');
    assert.ok(err, JSON.stringify(r.events));
    assert.doesNotMatch(err.v, /\d/, 'no numbers in what an account is told');
    assert.match(err.v, /too long/i);
    const o = await chat({ message: 'Hello' });
    assert.match(o.events.find(e => e.t === 'err').v, /250000 tokens/, 'the owner keeps the API’s wording');
  });

  await t.test('a used-up limit says so without a number, and is a 100% bar', async () => {
    const a = await account(1000);
    script = () => ({ text: 'Fine.', usage: { input_tokens: 1200, output_tokens: 30 } });
    const first = await chat({ message: 'Use it all' }, { token: a.token });
    assert.deepEqual(first.done.quota, { pct: 100 });
    assert.deepEqual(first.done.usage, { pct: 100 }, 'an answer is never more than all of it');
    const base = calls.length;
    const r = await api('/api/chat', { method: 'POST', token: a.token, body: { message: 'Again' } });
    assert.equal(r.status, 429);
    assert.deepEqual(r.data, { error: 'You’ve used today’s limit. It resets at midnight.', quota: { pct: 100 } });
    noAmounts('429 body', r.data);
    assert.equal(calls.length, base, 'nothing reached the model');
    assert.deepEqual((await boot(a.token)).quota, { pct: 100 });
  });

  await t.test('a question too big for what is left says so without amounts (tokens and dollars)', async () => {
    for (const a of [await account(1000), await account(0.0003, '', 'usd')]) {
      const base = calls.length;
      const r = await api('/api/chat', { method: 'POST', token: a.token, body: { message: 'x'.repeat(7000) } });
      assert.equal(r.status, 429, JSON.stringify(r.data));
      assert.match(r.data.error, /^That’s more than what’s left of today\. /);
      noAmounts('too-big 429', r.data);
      assert.doesNotMatch(r.data.error, /\d/);
      onlyPct('429 quota', r.data.quota);
      assert.equal(calls.length, base);
    }
  });

  await t.test('rounding: under 1%, whole numbers, 99 until the limit is really reached, 100 at or over it', async () => {
    const pct = async (tokens, usd) => {
      const a = usd == null ? await account(100_000) : await account(10, '', 'usd');
      await use(a.id, { tokens, usd });
      return (await boot(a.token)).quota.pct;
    };
    assert.equal(await pct(0), 0);
    assert.equal(await pct(1), 0.01, 'a sliver is under 1%');
    assert.equal(await pct(400), 0.4);
    assert.equal(await pct(1500), 2, '1.5% rounds to 2');
    assert.equal(await pct(42_000), 42);
    assert.equal(await pct(99_600), 99, 'not 100 until it is');
    assert.equal(await pct(100_000), 100);
    assert.equal(await pct(250_000), 100);
    assert.equal(await pct(0, 4.2), 42, 'dollars work out the same way');
    assert.equal(await pct(0, 10), 100);
  });

  await t.test('a restriction that lowers the limit says it is lower, not what it is', async () => {
    const a = await account(1_000_000);
    const res = await api(`/api/admin/users/${a.id}/ban`, { admin: true, token: null, method: 'POST', body: { kind: 'restrict', hours: 1, reason: 'Too much', limitKind: 'tokens', limitValue: 3000, noWeb: true } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const b = await boot(a.token);
    assert.deepEqual(b.restriction.limits, { noWeb: true, lowerLimit: true });
    assert.doesNotMatch(JSON.stringify(b.restriction), /3000|limitKind|limitValue/);
    assert.deepEqual(b.quota, { pct: 0 });
    // the owner still sees the real thing in /admin
    const listed = (await api('/api/admin/users', { admin: true, token: null })).data.users.find(u => u.id === a.id);
    assert.deepEqual(listed.restriction.limits, { noWeb: true, limitKind: 'tokens', limitValue: 3000 });
    assert.equal(listed.limitValue, 1_000_000);
  });

  await t.test('a reopened chat shows each answer’s share of today’s limit, not its tokens', async () => {
    const a = await account(10_000);
    script = () => ({ text: 'Fine.', usage: { input_tokens: 700, output_tokens: 50 } });
    const r = await chat({ message: 'Hello' }, { token: a.token });
    const past = await api('/api/chats/' + r.done.conversationId, { token: a.token });
    assert.deepEqual(past.data.messages.at(-1).usage, { pct: 7.5 });
    noAmounts('reopened chat', past.data);
    const b = await account(0.02, '', 'usd');
    script = () => ({ text: 'Fine.', usage: { input_tokens: 40_000, output_tokens: 2000 } });
    const s = await chat({ message: 'Hello' }, { token: b.token });
    assert.deepEqual((await api('/api/chats/' + s.done.conversationId, { token: b.token })).data.messages.at(-1).usage, { pct: 25 });
  });

  await t.test('the owner keeps the numbers: done event, reopened chats and /admin', async () => {
    script = () => ({ text: 'Fine.', usage: { input_tokens: 700, output_tokens: 50 } });
    const r = await chat({ message: 'Owner question' }, { token: owner });
    assert.deepEqual([r.done.usage.in, r.done.usage.out], [700, 50]);
    assert.ok(r.done.usage.usd > 0);
    assert.equal(r.done.quota, undefined, 'the owner has no daily limit');
    const past = await api('/api/chats/' + r.done.conversationId, { token: owner });
    assert.deepEqual(past.data.messages.at(-1).usage, { in: 700, out: 50 });
    const a = await account(10_000);
    await use(a.id, { tokens: 2500 });
    const listed = (await api('/api/admin/users', { admin: true, token: null })).data.users.find(u => u.id === a.id);
    assert.equal(listed.today.tokens, 2500);
    assert.equal(listed.limitValue, 10_000);
    assert.equal((await boot(a.token)).quota.pct, 25);
  });
});

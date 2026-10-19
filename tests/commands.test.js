import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Slash commands against a real server and an isolated PostgreSQL schema, with a local mock model (no API calls).
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const ADMIN = 'test-admin-token-' + randomBytes(8).toString('hex');
let db, adminDb, app, mock, origin, owner, alice, bob, pending, carol, ids = {};
const calls = [];
let logs = '', ip = '10.0.0.1';
// Writes are limited to 60 a minute per address, so each subtest comes from its own address (trust proxy is on).
let ipCount = 1;
const fresh = () => { ip = `10.0.0.${++ipCount}`; };

async function api(route, { token = owner, method = 'GET', body, admin } = {}) {
  const r = await fetch(origin + route, {
    method,
    headers: { 'X-Forwarded-For': ip, ...(token && { Authorization: `Bearer ${token}` }), ...(admin && { 'x-admin-token': ADMIN }), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, data: r.headers.get('content-type')?.includes('ndjson')
    ? text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(text) };
}
const put = (body, token = owner) => api('/api/commands', { method: 'PUT', body, token });
const del = (name, token = owner) => api('/api/commands?name=' + encodeURIComponent(name), { method: 'DELETE', token });
const list = async (token = owner) => (await api('/api/commands', { token })).data.commands;
const count = async () => (await db.query('SELECT COUNT(*)::int AS n FROM slash_commands')).rows[0].n;
async function session(userId = null) {
  const token = randomBytes(24).toString('hex');
  await db.query('INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), userId]);
  return token;
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
    calls.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const events = [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A local fixture answer.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
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
    env: { ...process.env, DATABASE_URL: url.href, PGSSL: 'false', PORT: String(port), INITIAL_PASSWORD: '', ADMIN_TOKEN: ADMIN,
      ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: mockOrigin, OPENROUTER_API_KEY: '',
      PAGEBOT_MOCK_MODEL_ORIGIN: mockOrigin, SYSTEM_PROMPT: 'You are a test helper.', TIMEZONE: 'UTC' },
  });
  app.stdout.on('data', chunk => { logs += chunk; });
  app.stderr.on('data', chunk => { logs += chunk; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (app.exitCode != null) throw new Error(`Test server exited: ${logs}`);
    try { if ((await fetch(origin + '/health')).ok) { ready = true; break; } } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Server failed to start: ${logs}`);
  const users = await db.query(`INSERT INTO users(username,password_hash,status) VALUES
    ('alice','fixture-unused','trusted'),('bob','fixture-unused','trusted'),('pending','fixture-unused','pending'),('carol','fixture-unused','trusted') RETURNING id, username`);
  for (const u of users.rows) ids[u.username] = Number(u.id);
  [owner, alice, bob, pending, carol] = await Promise.all([session(), ...users.rows.map(u => session(u.id))]);
});

after(async () => {
  if (app && app.exitCode == null) { app.kill(); await once(app, 'exit'); }
  if (mock) await new Promise(resolve => mock.close(resolve));
  await db?.end();
  if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
});

test('slash commands integration', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  t.beforeEach(fresh);

  await t.test('needs a signed-in, accepted account that is not banned', async () => {
    assert.equal((await api(`/api/admin/users/${ids.carol}/ban`, { admin: true, token: null, method: 'POST', body: { kind: 'ban', hours: 24, reason: 'Spam' } })).status, 200);
    for (const [method, route, body] of [['GET', '/api/commands'], ['PUT', '/api/commands', { name: 'x', prompt: 'X.' }], ['DELETE', '/api/commands?name=x']]) {
      assert.equal((await api(route, { method, body, token: null })).status, 401, method);
      assert.equal((await api(route, { method, body, token: 'not-a-session' })).status, 401, method);
      const p = await api(route, { method, body, token: pending });
      assert.equal(p.status, 403, method);
      assert.equal(p.data.status, 'pending');
      const c = await api(route, { method, body, token: carol });
      assert.equal(c.status, 403, method);
      assert.equal(c.data.banned, true);
    }
    assert.equal(await count(), 0);
  });

  await t.test('saves, normalizes and lists commands per person', async () => {
    const r = await put({ name: '  /TLDR ', prompt: '  Give me a TL;DR.\n  ' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual({ ...r.data.command, updatedAt: undefined }, { name: 'tldr', prompt: 'Give me a TL;DR.', starter: false, updatedAt: undefined });
    assert.deepEqual(r.data.commands.map(c => c.name), ['tldr'], 'a save sends back the whole list');
    assert.equal((await put({ name: 'tldr', prompt: 'Alice’s TL;DR.' }, alice)).status, 200);
    assert.equal((await put({ name: 'b-two', prompt: 'Two.' })).status, 200);
    assert.equal((await put({ name: 'a_one', prompt: 'One.', starter: true })).status, 200);
    assert.deepEqual((await list()).map(c => [c.name, c.prompt, c.starter]), [['a_one', 'One.', true], ['b-two', 'Two.', false], ['tldr', 'Give me a TL;DR.', false]]);
    assert.deepEqual((await list(alice)).map(c => [c.name, c.prompt]), [['tldr', 'Alice’s TL;DR.']]);
    assert.deepEqual(await list(bob), []);
    assert.deepEqual((await list(await session())).map(c => c.name), ['a_one', 'b-two', 'tldr'], 'every owner device sees the owner’s commands');
    const rows = await db.query("SELECT user_id FROM slash_commands WHERE name='tldr' ORDER BY user_id NULLS FIRST");
    assert.deepEqual(rows.rows.map(r => r.user_id === null ? null : Number(r.user_id)), [null, ids.alice]);
  });

  await t.test('turns away bad names, built-in names and bad prompts, and saves nothing', async () => {
    const before = await count();
    for (const name of ['', '/', '1st', '-x', '_x', 'a'.repeat(25), 'two words', 'café', 'a/b', 'a.b', 'x!', 42, null, ['tldr'], { name: 'x' }]) {
      const r = await put({ name, prompt: 'Fine.' });
      assert.equal(r.status, 400, JSON.stringify(name));
      assert.match(r.data.error, /Start the name with a letter/);
    }
    for (const name of ['new', '/Summarize', 'KEYPOINTS', 'simple', 'web', 'page', 'screenshot', 'region', 'settings', 'help', 'history', 'pdf', 'actions']) {
      const r = await put({ name, prompt: 'Fine.' });
      assert.equal(r.status, 400, name);
      assert.match(r.data.error, /is a built-in command/, name);
    }
    for (const prompt of ['', '   \n ', 'x'.repeat(2001), {}, 7, null, ['x']]) assert.equal((await put({ name: 'okname', prompt })).status, 400, JSON.stringify(prompt).slice(0, 30));
    assert.equal((await put({ name: 'okname', prompt: '  ' + 'x'.repeat(2000) + '  ' })).status, 200, '2,000 characters after trimming is fine');
    assert.equal((await put({ name: 'a'.repeat(24), prompt: 'Long name.' })).status, 200);
    assert.equal((await api('/api/commands', { method: 'PUT', body: 'just a string' })).status, 400);
    assert.equal(await count(), before + 2);
    await del('okname'); await del('a'.repeat(24));
  });

  await t.test('updates in place and renames without duplicates', async () => {
    const first = (await list()).find(c => c.name === 'tldr');
    const again = await put({ name: 'tldr', prompt: 'A shorter TL;DR.' });
    assert.equal(again.data.command.prompt, 'A shorter TL;DR.');
    assert.ok(new Date(again.data.command.updatedAt) >= new Date(first.updatedAt));
    const renamed = await put({ from: '/TLDR', name: 'short', prompt: 'A shorter TL;DR.' });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.data.commands.map(c => c.name), ['a_one', 'b-two', 'short']);
    const clash = await put({ from: 'short', name: 'a_one', prompt: 'Clash.' });
    assert.equal(clash.status, 409);
    assert.match(clash.data.error, /You already have \/a_one/);
    assert.deepEqual((await list()).map(c => [c.name, c.prompt]), [['a_one', 'One.'], ['b-two', 'Two.'], ['short', 'A shorter TL;DR.']]);
    assert.equal((await put({ from: 'gone', name: 'fresh', prompt: 'Renamed from one deleted elsewhere.' })).status, 200);
    assert.equal((await put({ from: 'bad name!', name: 'x1', prompt: 'X.' })).status, 400);
    assert.equal((await put({ from: 'short', name: 'short', prompt: 'Same name.' })).status, 200);
    assert.ok((await list(alice)).some(c => c.name === 'tldr'), 'the owner renaming theirs leaves alice’s alone');
    await del('fresh');
  });

  await t.test('shows at most three commands on new chats, even with saves at once', async () => {
    assert.equal((await put({ name: 's1', prompt: 'S1.', starter: true }, bob)).status, 200);
    const both = await Promise.all([put({ name: 's2', prompt: 'S2.', starter: true }, bob), put({ name: 's3', prompt: 'S3.', starter: true }, bob), put({ name: 's4', prompt: 'S4.', starter: true }, bob)]);
    assert.deepEqual(both.map(r => r.status).sort(), [200, 200, 400]);
    assert.match(both.find(r => r.status === 400).data.error, /You can show 3 commands on new chats/);
    assert.equal((await list(bob)).filter(c => c.starter).length, 3);
    assert.equal((await put({ name: 's1', prompt: 'S1 again.', starter: true }, bob)).status, 200, 'saving a starter again is fine');
    assert.equal((await put({ from: 's1', name: 's1-renamed', prompt: 'S1.', starter: true }, bob)).status, 200, 'so is renaming one');
    assert.equal((await put({ name: 's1-renamed', prompt: 'S1.', starter: false }, bob)).status, 200);
    assert.equal((await put({ name: 's5', prompt: 'S5.', starter: true }, bob)).status, 200, 'one off, another on');
    assert.equal((await list(bob)).filter(c => c.starter).length, 3);
    await db.query('DELETE FROM slash_commands WHERE user_id=$1', [ids.bob]);
  });

  await t.test('holds the 50-command cap during concurrent creates, and still allows edits at the cap', async () => {
    await db.query("INSERT INTO slash_commands(user_id,name,prompt) SELECT $1, 'c' || n, 'Existing.' FROM generate_series(1,49) n", [ids.bob]);
    const results = await Promise.all([put({ name: 'last', prompt: 'New.' }, bob), put({ name: 'extra', prompt: 'New.' }, bob)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
    assert.match(results.find(r => r.status === 400).data.error, /You can save 50 commands/);
    assert.equal((await put({ name: 'c1', prompt: 'Edited.' }, bob)).status, 200);
    assert.equal((await put({ from: 'c2', name: 'c2-renamed', prompt: 'Renamed at the cap.' }, bob)).status, 200);
    assert.equal((await put({ name: 'one-more', prompt: 'No.' }, bob)).status, 400);
    assert.equal((await list(bob)).length, 50);
    assert.equal((await put({ name: 'own', prompt: 'Alice is not at a cap.' }, alice)).status, 200);
  });

  await t.test('deletes only the signed-in person’s command', async () => {
    const r = await del('tldr', alice);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.commands.map(c => c.name), ['own']);
    assert.ok((await list()).some(c => c.name === 'short'), 'the owner’s are untouched');
    assert.equal((await del('short', bob)).status, 200, 'deleting a name you don’t have is fine');
    assert.ok((await list()).some(c => c.name === 'short'));
    assert.equal((await del('/SHORT')).status, 200);
    assert.ok(!(await list()).some(c => c.name === 'short'));
    assert.equal((await del('short')).status, 200, 'again is fine too');
    assert.equal((await api('/api/commands?name=a&name=b', { method: 'DELETE' })).status, 400);
    assert.equal((await api('/api/commands?name=bad%20name', { method: 'DELETE' })).status, 400);
    assert.equal((await api('/api/commands', { method: 'DELETE' })).status, 400);
  });

  await t.test('boot carries commands for the owner and accepted accounts only', async () => {
    const o = (await api('/api/boot')).data;
    assert.deepEqual(o.commands.map(c => c.name), ['a_one', 'b-two']);
    assert.deepEqual({ ...o.commandLimits, reserved: undefined }, { maxCommands: 50, maxPrompt: 2000, maxStarters: 3, reserved: undefined });
    for (const name of ['new', 'history', 'pdf', 'actions']) assert.ok(o.commandLimits.reserved.includes(name), name);
    assert.deepEqual((await api('/api/boot', { token: alice })).data.commands.map(c => c.name), ['own']);
    for (const token of [pending, carol, null]) assert.equal('commands' in (await api('/api/boot', { token })).data, false);
  });

  await t.test('a saved name that a built-in takes later still lists and can be deleted, but not saved again', async () => {
    await db.query("INSERT INTO slash_commands(user_id,name,prompt) VALUES ($1,'history','Saved before chat history shipped.')", [ids.alice]);
    assert.ok((await api('/api/boot', { token: alice })).data.commands.some(c => c.name === 'history'));
    assert.equal((await put({ name: 'history', prompt: 'Again.' }, alice)).status, 400);
    assert.equal((await put({ from: 'history', name: 'old-history', prompt: 'Renamed to keep using it.' }, alice)).status, 200);
    assert.deepEqual((await list(alice)).map(c => c.name), ['old-history', 'own']);
    assert.equal((await del('old-history', alice)).status, 200);
  });

  await t.test('the server never expands commands: it gets and stores what the panel sends', async () => {
    const r = await api('/api/chat', { method: 'POST', body: { message: '/a_one' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.at(-1).t, 'done');
    assert.match(JSON.stringify(calls.at(-1).messages), /\/a_one/);
    assert.doesNotMatch(JSON.stringify(calls.at(-1).messages), /One\./);
    const row = await db.query("SELECT content FROM messages WHERE role='user' ORDER BY id DESC LIMIT 1");
    assert.equal(row.rows[0].content, '/a_one');
  });

  await t.test('deleting an account deletes its commands and nothing else', async () => {
    await put({ name: 'keep', prompt: 'Kept.' }, bob);
    const msgs = (await db.query('SELECT COUNT(*)::int AS n FROM messages')).rows[0].n;
    assert.equal((await api(`/api/admin/users/${ids.bob}`, { admin: true, token: null, method: 'DELETE' })).status, 200);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM slash_commands WHERE user_id=$1', [ids.bob])).rows[0].n, 0);
    assert.deepEqual((await list()).map(c => c.name), ['a_one', 'b-two']);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM messages')).rows[0].n, msgs);
  });

  await t.test('writes are rate-limited per address', async () => {
    const statuses = [];
    for (let i = 0; i < 61; i++) statuses.push((await del('nothing-here')).status);
    assert.deepEqual([...new Set(statuses.slice(0, 60))], [200]);
    assert.equal(statuses[60], 429);
    fresh();
    assert.equal((await del('nothing-here')).status, 200, 'another address is unaffected');
  });
});

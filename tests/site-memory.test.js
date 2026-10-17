import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Use a disposable database or one on which the test may create an isolated schema.
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
let db, adminDb, app, mock, origin, owner, alice, bob, pending, aliceId;
const calls = [];
let logs = '';

async function api(route, { token = owner, method = 'GET', body } = {}) {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, data: r.headers.get('content-type')?.includes('ndjson')
    ? text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(text) };
}
async function save(site, instructions, token = owner) {
  return api('/api/site-memory', { method: 'PUT', body: { site, instructions }, token });
}
async function chat(body, token = owner) {
  const response = await api('/api/chat', { method: 'POST', body: { message: 'Please help.', ...body }, token });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.at(-1).t, 'done', JSON.stringify(response.data));
  return response.data.at(-1).conversationId;
}
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
    calls.push({ provider: req.url === '/router' ? 'router' : 'anthropic', body });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (req.url === '/router') {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A local fixture answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.00001 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
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
    env: { ...process.env, DATABASE_URL: url.href, PGSSL: 'false', PORT: String(port),
      INITIAL_PASSWORD: '', ADMIN_TOKEN: '', ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: mockOrigin,
      OPENROUTER_API_KEY: 'local-fixture-only', OPENROUTER_MODEL: 'meta/muse-spark-1.3-contributor',
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
  const users = await db.query("INSERT INTO users(username,password_hash,status) VALUES ('alice','fixture-unused','trusted'),('bob','fixture-unused','trusted'),('pending','fixture-unused','pending') RETURNING id");
  aliceId = Number(users.rows[0].id);
  [owner, alice, bob, pending] = await Promise.all([session(), ...users.rows.map(u => session(u.id))]);
});

after(async () => {
  if (app && app.exitCode == null) { app.kill(); await once(app, 'exit'); }
  if (mock) await new Promise(resolve => mock.close(resolve));
  await db?.end();
  if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
});

test('website memory integration', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  await t.test('requires an authenticated, approved account', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const route = method === 'DELETE' ? '/api/site-memory?site=example.com' : '/api/site-memory';
      const body = method === 'PUT' ? { site: 'example.com', instructions: 'Test.' } : undefined;
      assert.equal((await api(route, { method, body, token: null })).status, 401);
      assert.equal((await api(route, { method, body, token: pending })).status, 403);
    }
  });

  await t.test('normalizes hostnames, persists edits, and isolates the owner and accounts', async () => {
    const first = await save('https://EXAMPLE.com.:8443/path?q=yes', '  Use concise bullets.  ');
    assert.equal(first.status, 200);
    assert.equal(first.data.memory.site, 'example.com');
    assert.equal(first.data.memory.instructions, 'Use concise bullets.');
    await save('example.com', 'Owner instructions.');
    await save('http://example.com/path', 'Alice instructions.', alice);
    const read = token => api('/api/site-memory?site=example.com', { token });
    assert.equal((await read(owner)).data.memory.instructions, 'Owner instructions.');
    assert.equal((await read(alice)).data.memory.instructions, 'Alice instructions.');
    assert.equal((await read(bob)).data.memory, null);
    assert.deepEqual((await api('/api/site-memory', { token: bob })).data.memories, []);
    assert.equal((await api('/api/site-memory?site=docs.example.com')).data.memory, null);
    assert.equal((await save('https://bücher.example', 'IDN instructions.')).data.memory.site, 'xn--bcher-kva.example');
    const rows = await db.query("SELECT COUNT(*)::int AS n FROM site_memories WHERE site='example.com'");
    assert.equal(rows.rows[0].n, 2);
    assert.equal((await api('/api/site-memory?site=example.com', { token: await session() })).data.memory.instructions, 'Owner instructions.');
  });

  await t.test('rejects unsupported sites and oversized or malformed instructions', async () => {
    for (const site of ['ftp://example.com', 'javascript:alert(1)', 'https://person:secret@example.com', 'not a host', '', 'https://bad_host.example', 'https://example.com\\other']) {
      assert.equal((await save(site, 'Instructions.')).status, 400, site);
    }
    assert.equal((await save('example.com', 'x'.repeat(4001))).status, 400);
    assert.equal((await save('example.com', {})).status, 400);
    assert.equal((await api('/api/site-memory?site[bad]=example.com')).status, 200);
    assert.equal((await api('/api/site-memory?site=example.com&site=other.example')).status, 400);
  });

  await t.test('applies only matching instructions for both providers and no-page follow-ups', async () => {
    const conv = await chat({ page: { url: 'https://example.com/a', title: 'Example', text: 'Example page.' } });
    assert.match(calls.at(-1).body.system, /Owner instructions\./);
    await save('example.com', 'Updated owner instructions.');
    await chat({ conversationId: conv });
    assert.match(calls.at(-1).body.system, /Updated owner instructions\./);
    await chat({ site: 'example.com', model: 'sonnet' }, alice);
    assert.match(calls.at(-1).body.system, /Alice instructions\./);
    assert.doesNotMatch(calls.at(-1).body.system, /owner instructions/i);
    const routerConv = await chat({ site: 'https://example.com/path', model: 'openrouter' });
    assert.equal(calls.at(-1).provider, 'router');
    assert.match(calls.at(-1).body.messages[0].content, /Updated owner instructions\./);
    await chat({ conversationId: routerConv, model: 'openrouter' });
    assert.match(calls.at(-1).body.messages[0].content, /Updated owner instructions\./);
    await chat({ site: 'docs.example.com' });
    assert.doesNotMatch(calls.at(-1).body.system, /owner instructions/i);
    await chat({ site: 'example.com', conversationId: conv }, bob);
    assert.doesNotMatch(calls.at(-1).body.system, /owner instructions/i);
    await chat({ conversationId: conv, page: { url: 'file:///local', text: 'A local file.' } });
    await chat({ conversationId: conv });
    assert.doesNotMatch(calls.at(-1).body.system, /owner instructions/i);
  });

  await t.test('changing websites updates the follow-up context and deleted memory stops applying', async () => {
    await save('other.example', 'Use other website instructions.');
    const conv = await chat({ site: 'example.com' });
    await chat({ conversationId: conv, site: 'other.example' });
    await chat({ conversationId: conv });
    assert.match(calls.at(-1).body.system, /Use other website instructions\./);
    assert.doesNotMatch(calls.at(-1).body.system, /owner instructions/i);
    assert.equal((await api('/api/site-memory?site=other.example', { method: 'DELETE', token: bob })).status, 200);
    assert.ok((await api('/api/site-memory?site=other.example')).data.memory);
    await api('/api/site-memory?site=other.example', { method: 'DELETE' });
    await chat({ conversationId: conv });
    assert.doesNotMatch(calls.at(-1).body.system, /other website instructions/i);
    assert.equal((await save('example.com', '   ', alice)).data.memory, null);
    assert.equal((await api('/api/site-memory?site=example.com', { token: alice })).data.memory, null);
  });

  await t.test('explicitly clearing the website prevents stale instructions on subsequent turns', async () => {
    const conv = await chat({ site: 'example.com' });
    await chat({ conversationId: conv, site: null });
    assert.doesNotMatch(calls.at(-1).body.system, /owner instructions/i);
    await chat({ conversationId: conv });
    assert.doesNotMatch(calls.at(-1).body.system, /owner instructions/i);
    const cleared = await chat({ site: null, page: { url: 'https://example.com', text: 'A page without active website memory.' } });
    assert.doesNotMatch(calls.at(-1).body.system, /owner instructions/i);
    await chat({ conversationId: cleared });
    assert.doesNotMatch(calls.at(-1).body.system, /owner instructions/i);
  });

  await t.test('enforces the site cap during concurrent creates and permits updates at the cap', async () => {
    const bobId = (await db.query("SELECT id FROM users WHERE username='bob'")).rows[0].id;
    await db.query("INSERT INTO site_memories(user_id,site,instructions) SELECT $1, 'site' || n || '.example', 'Existing.' FROM generate_series(1,99) n", [bobId]);
    const results = await Promise.all([save('last.example', 'New.', bob), save('extra.example', 'New.', bob)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
    assert.equal((await save('site1.example', 'Edited.', bob)).status, 200);
    assert.equal((await api('/api/site-memory', { token: bob })).data.memories.length, 100);
  });

  await t.test('counts saved instructions toward the daily token allowance before calling a provider', async () => {
    await db.query("UPDATE users SET limit_kind='tokens', limit_value=1000 WHERE id=$1", [aliceId]);
    const baseline = await api('/api/chat', { token: alice, method: 'POST', body: { message: 'Hello.', site: 'quota.example' } });
    assert.equal(baseline.status, 200);
    assert.equal(baseline.data.at(-1).t, 'done');
    await save('quota.example', 'x'.repeat(4000), alice);
    const count = calls.length;
    const limited = await api('/api/chat', { token: alice, method: 'POST', body: { message: 'Hello.', site: 'quota.example' } });
    assert.equal(limited.status, 429);
    assert.equal(calls.length, count);
    assert.match(limited.data.error, /left of today/);
  });
});

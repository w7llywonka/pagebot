import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Chat history against a real PostgreSQL schema and local mock model servers (no real API calls).
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const ADMIN = 'history-test-admin-token-' + randomBytes(6).toString('hex');
let db, adminDb, mock, mockOrigin, dbUrl, origin, owner, alice, bob, pending, aliceId, bobId;
const calls = [], servers = [];
let logs = '';

async function api(route, { token = owner, method = 'GET', body, ip, admin } = {}) {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }),
      ...(ip && { 'X-Forwarded-For': ip }), ...(admin && { 'X-Admin-Token': ADMIN }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, data: r.headers.get('content-type')?.includes('ndjson')
    ? text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(text) };
}
// one question; returns the done event (with its conversationId)
async function ask(body, token = owner) {
  const response = await api('/api/chat', { method: 'POST', body: { message: 'Please help.', ...body }, token });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.at(-1).t, 'done', JSON.stringify(response.data));
  return response.data.at(-1);
}
const chat = async (body, token) => (await ask(body, token)).conversationId;
const list = async (query = '', token = owner) => api('/api/chats' + (query ? '?' + query : ''), { token });
async function session(userId = null) {
  const token = randomBytes(24).toString('hex');
  await db.query('INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), userId]);
  return token;
}
const lastText = body => {
  const c = body.messages.at(-1).content;
  return typeof c === 'string' ? c : c.filter(b => b.type === 'text').map(b => b.text).join('\n');
};
async function startServer() {
  const portServer = createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const app = spawn(process.execPath, ['--import', './tests/helpers/local-model.mjs', 'server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: 'false', PORT: String(port),
      INITIAL_PASSWORD: '', ADMIN_TOKEN: ADMIN, ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: mockOrigin,
      OPENROUTER_API_KEY: 'local-fixture-only', OPENROUTER_MODEL: 'meta/muse-spark-1.3-contributor',
      PAGEBOT_MOCK_MODEL_ORIGIN: mockOrigin, SYSTEM_PROMPT: 'You are a test helper.', TIMEZONE: 'UTC' },
  });
  servers.push(app);
  app.stdout.on('data', chunk => { logs += chunk; });
  app.stderr.on('data', chunk => { logs += chunk; });
  const at = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (app.exitCode != null) throw new Error(`Test server exited: ${logs}`);
    try { if ((await fetch(at + '/health')).ok) return { app, origin: at }; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server failed to start: ${logs}`);
}

before(async () => {
  if (!database) return;
  adminDb = new pg.Pool({ connectionString: database });
  await adminDb.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(database);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  dbUrl = url.href;
  db = new pg.Pool({ connectionString: dbUrl });
  // [cite] answers quote the page and cite a web page; [cut] runs out of tokens
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
    const text = lastText(body), cite = text.includes('[cite]'), cut = text.includes('[cut]');
    const events = [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: cite ? 'The page says hello.' : 'A local fixture answer.' } },
      ...(cite ? [
        { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'char_location', cited_text: 'From the page', document_index: 0, document_title: 'Example', start_char_index: 0, end_char_index: 13 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://source.example/a', title: 'Source A', cited_text: 'x', encrypted_index: 'e' } } },
      ] : []),
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: cut ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  }).listen(0, '127.0.0.1');
  await once(mock, 'listening');
  mockOrigin = `http://127.0.0.1:${mock.address().port}`;
  ({ origin } = await startServer());
  const users = await db.query("INSERT INTO users(username,password_hash,status) VALUES ('alice','fixture-unused','trusted'),('bob','fixture-unused','trusted'),('pending','fixture-unused','pending') RETURNING id");
  aliceId = Number(users.rows[0].id); bobId = Number(users.rows[1].id);
  [owner, alice, bob, pending] = await Promise.all([session(), ...users.rows.map(u => session(u.id))]);
});

after(async () => {
  for (const app of servers) if (app.exitCode == null && app.signalCode == null) { app.kill(); await once(app, 'exit'); }
  if (mock) await new Promise(resolve => mock.close(resolve));
  await db?.end();
  if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
});

test('chat history integration', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  await t.test('requires an authenticated, approved account', async () => {
    for (const [route, method] of [['/api/chats', 'GET'], ['/api/chats/1', 'GET'], ['/api/chats/1', 'DELETE'], ['/api/chats?all=1', 'DELETE']]) {
      assert.equal((await api(route, { method, token: null })).status, 401, `${method} ${route}`);
      assert.equal((await api(route, { method, token: pending })).status, 403, `${method} ${route}`);
    }
  });

  await t.test('names chats from what was asked and shows stored questions without their wrappers', async () => {
    const typed = await chat({ message: 'What does this clause mean?\nSecond line', page: { url: 'https://example.com/a', title: 'Example page', text: 'Body text.' } });
    const stock = await chat({ message: 'Summarize this page.', page: { url: 'https://news.example/x', title: 'A news story', text: 'News.' } });
    const highlight = await chat({ message: '', selection: 'Some highlighted words' });
    const noText = await chat({ message: '', page: { url: 'https://empty.example/', title: 'Empty <b>page</b> "quoted"', text: '' } });
    const long = await chat({ message: 'word '.repeat(60) });
    // a question saved by an old version, with the page's text inline and its quotes escaped
    const old = Number((await db.query("INSERT INTO conversations(page_url, page_title) VALUES ('https://old.example/x', NULL) RETURNING id")).rows[0].id);
    await db.query(`INSERT INTO messages(conversation_id, role, content) VALUES ($1, 'user', $2), ($1, 'assistant', 'Old answer.')`,
      [old, '<page url="https://old.example/x" title="Old &quot;quoted&quot;">\nOld page text with </page> inside\n</page>\n\n<highlighted_text>\nquoted bit\n</highlighted_text>\n\nWhat is this?']);
    const titles = Object.fromEntries((await list()).data.chats.map(c => [c.id, c.title]));
    assert.equal(titles[typed], 'What does this clause mean? Second line');
    assert.equal(titles[stock], 'A news story');
    assert.equal(titles[highlight], '“Some highlighted words”');
    assert.equal(titles[noText], 'Empty <b>page</b> "quoted"');
    assert.ok(titles[long].endsWith('…') && titles[long].length <= 101, titles[long]);
    assert.equal(titles[old], 'What is this?');

    const h = (await api('/api/chats/' + highlight)).data.messages[0];
    assert.deepEqual([h.text, h.highlight, h.page], ['Explain the highlighted text.', 'Some highlighted words', false]);
    const n = (await api('/api/chats/' + noText)).data;
    assert.deepEqual([n.messages[0].text, n.messages[0].page, n.messages[0].url], ['Summarize this page.', true, 'https://empty.example/']);
    assert.equal(n.chat.site, 'empty.example');
    const o = await api('/api/chats/' + old);
    assert.deepEqual([o.data.messages[0].text, o.data.messages[0].highlight, o.data.messages[0].url], ['What is this?', 'quoted bit', 'https://old.example/x']);
    assert.equal(o.data.messages[1].text, 'Old answer.');
    assert.doesNotMatch(JSON.stringify(o.data), /Old page text/, 'page text never goes back to the panel');
    const p = (await api('/api/chats/' + typed)).data;
    assert.equal(p.messages[0].page, true);
    assert.equal(p.chat.url, 'https://example.com/a');
    assert.doesNotMatch(JSON.stringify(p), /Body text/);
  });

  await t.test('lists newest first and pages with a cursor, without gaps, empty chats or removed ones', async () => {
    // 35 chats, two at a time sharing a timestamp, so ties are broken by id
    const base = new Date(Date.now() - 60_000);
    for (let i = 0; i < 35; i++) {
      const id = (await db.query(`INSERT INTO conversations(user_id, page_url, updated_at) VALUES ($1, 'https://bob.example/' || $2, $3::timestamptz - make_interval(mins => $4)) RETURNING id`,
        [bobId, i, base, Math.floor(i / 2)])).rows[0].id;
      await db.query(`INSERT INTO messages(conversation_id, role, content, user_id) VALUES ($1, 'user', $2, $3), ($1, 'assistant', 'Answer.', $3)`, [id, `Bob question ${i}`, bobId]);
    }
    const empty = (await db.query('INSERT INTO conversations(user_id) VALUES ($1) RETURNING id', [bobId])).rows[0].id;
    const hidden = (await db.query('INSERT INTO conversations(user_id, hidden_at) VALUES ($1, now()) RETURNING id', [bobId])).rows[0].id;
    await db.query(`INSERT INTO messages(conversation_id, role, content, user_id) VALUES ($1, 'user', 'Hidden one', $2)`, [hidden, bobId]);
    const one = await list('', bob);
    assert.equal(one.data.chats.length, 30);
    // newest first; within a tie, the newer id first
    const order = [...Array(35).keys()].sort((a, b) => Math.floor(a / 2) - Math.floor(b / 2) || b - a).map(i => `Bob question ${i}`);
    assert.deepEqual(one.data.chats.map(c => c.title), order.slice(0, 30));
    assert.equal(one.data.chats[0].site, 'bob.example');
    const times = one.data.chats.map(c => [Date.parse(c.updatedAt), c.id]);
    for (let i = 1; i < times.length; i++) assert.ok(times[i - 1][0] > times[i][0] || (times[i - 1][0] === times[i][0] && times[i - 1][1] > times[i][1]), 'newest first, then by id');
    assert.ok(one.data.next);
    const two = await list('before=' + encodeURIComponent(one.data.next), bob);
    assert.equal(two.data.chats.length, 5);
    assert.equal(two.data.next, null);
    const ids = [...one.data.chats, ...two.data.chats].map(c => c.id);
    assert.equal(new Set(ids).size, 35);
    assert.ok(!ids.includes(Number(empty)) && !ids.includes(Number(hidden)));
    assert.deepEqual(two.data.chats.map(c => c.title), order.slice(30));
    assert.equal((await list('before=abc', bob)).status, 400);
    assert.equal((await list('before=a&before=b', bob)).status, 400);
    assert.equal((await api('/api/chats/' + empty, { token: bob })).status, 404);
    assert.equal((await api('/api/chats/' + hidden, { token: bob })).status, 404);
    assert.equal((await api('/api/chats/abc', { token: bob })).status, 404);
  });

  await t.test('searches questions, answers, page titles and addresses, literally and only your own', async () => {
    const penguins = await chat({ message: 'Tell me about penguins' });
    const price = await chat({ message: 'Price is 50% off' });
    const birds = await chat({ message: 'Tell me more', page: { url: 'https://birds.example/', title: 'Antarctic birds', text: 'Birds.' } });
    const hl = await chat({ message: 'What is this?', selection: 'Emperor colonies' });
    const ids = async q => (await list('q=' + encodeURIComponent(q))).data.chats.map(c => c.id);
    assert.deepEqual(await ids('PENGUIN'), [penguins]);
    assert.deepEqual(await ids('0% off'), [price]);
    assert.deepEqual(await ids('_x'), []);
    assert.deepEqual(await ids('antarctic'), [birds]);
    assert.deepEqual(await ids('birds.example'), [birds]);
    assert.deepEqual(await ids('emperor'), [hl]); // what was highlighted is searchable
    assert.ok(!(await ids('highlighted_text')).includes(hl), 'the stored markup is not');
    const answers = (await list('q=' + encodeURIComponent('fixture answer'))).data.chats;
    assert.ok(answers.length >= 4 && answers.some(c => c.id === price));
    assert.match(answers.find(c => c.id === price).snippet, /local fixture answer/);
    assert.equal((await list('q=penguin')).data.chats[0].snippet, undefined, 'no snippet when the title already shows the match');
    assert.equal((await list('q=p')).data.chats.length, (await list()).data.chats.length, 'one letter is no search');
    assert.deepEqual((await list('q=penguin', alice)).data.chats, []);
    assert.equal((await list('q=a&q=b')).status, 400);
    const longQ = await list('q=' + 'x'.repeat(500));
    assert.equal(longQ.status, 200);
    assert.deepEqual(longQ.data.chats, []);
  });

  await t.test('keeps the owner and accounts apart', async () => {
    const mine = await chat({ message: 'Owner only question' });
    const alices = await chat({ message: 'Alice only question' }, alice);
    for (const method of ['GET', 'DELETE']) assert.equal((await api('/api/chats/' + mine, { method, token: alice })).status, 404);
    assert.equal((await db.query('SELECT hidden_at FROM conversations WHERE id=$1', [mine])).rows[0].hidden_at, null);
    assert.equal((await api('/api/chats/' + alices, { method: 'DELETE', token: bob })).status, 404);
    assert.ok(!(await list('', bob)).data.chats.some(c => c.id === alices));
    assert.ok(!(await list('', alice)).data.chats.some(c => c.id === mine));
    assert.ok((await list('', await session())).data.chats.some(c => c.id === mine), 'a second owner session sees the owner’s chats');
    assert.equal((await api('/api/chats/' + mine, { token: await session() })).status, 200);
    const taken = await ask({ conversationId: mine, message: 'Continue it?' }, alice);
    assert.notEqual(taken.conversationId, mine);
    assert.equal(calls.at(-1).body.messages.length, 1, 'someone else’s chat is never sent');
  });

  await t.test('a follow-up moves the chat to the top', async () => {
    const a = await chat({ message: 'First chat' });
    await chat({ message: 'Second chat' });
    const before = (await db.query('SELECT updated_at FROM conversations WHERE id=$1', [a])).rows[0].updated_at;
    await chat({ conversationId: a, message: 'Back to the first' });
    assert.equal((await list()).data.chats[0].id, a);
    assert.ok((await db.query('SELECT updated_at FROM conversations WHERE id=$1', [a])).rows[0].updated_at > before);
    assert.equal(calls.at(-1).body.messages.length, 3, 'the earlier turn went along');
  });

  await t.test('saves each answer’s sources, quotes and markers, and reopens them without page text', async () => {
    const done = await ask({ message: '[cite] What does it say?', page: { url: 'https://example.com/a', title: 'Example', text: 'From the page and more.' }, cite: true });
    assert.deepEqual(done.quotes, ['From the page']);
    assert.deepEqual(done.cites, [{ at: 20, q: [0] }]);
    assert.deepEqual(done.sources, [{ url: 'https://source.example/a', title: 'Source A' }]);
    const rows = (await db.query('SELECT role, meta FROM messages WHERE conversation_id=$1 ORDER BY id', [done.conversationId])).rows;
    assert.deepEqual(JSON.parse(rows[0].meta), { url: 'https://example.com/a' });
    assert.deepEqual(JSON.parse(rows[1].meta), { sources: done.sources, quotes: done.quotes, cites: done.cites });
    const r = (await api('/api/chats/' + done.conversationId)).data;
    const [q, a] = r.messages;
    assert.equal(q.url, 'https://example.com/a');
    assert.equal(q.text, '[cite] What does it say?');
    assert.deepEqual([a.text, a.quotes, a.cites, a.sources, a.model], ['The page says hello.', done.quotes, done.cites, done.sources, 'Haiku 5.5']);
    assert.ok(a.usage.in > 0 && a.usage.out > 0);
    assert.doesNotMatch(JSON.stringify(r), /and more\./);

    const web = await ask({ message: '[cut] Search it', web: true });
    const w = (await api('/api/chats/' + web.conversationId)).data.messages;
    assert.equal(w[0].web, true);
    assert.equal(w[1].stop, 'max_tokens');
    const routed = await chat({ message: 'Through OpenRouter', model: 'openrouter' });
    const ra = (await api('/api/chats/' + routed)).data.messages[1];
    assert.match(ra.model, /^Muse Spark 1\.3/);
    assert.deepEqual([ra.sources, ra.quotes], [[], undefined]);
  });

  await t.test('removing hides a chat but keeps its messages, its usage and the owner’s view of it', async () => {
    await db.query("UPDATE users SET limit_kind='tokens', limit_value=100000 WHERE id=$1", [aliceId]);
    const first = await chat({ message: 'Secret plan', page: { url: 'https://example.com/plan', title: 'Plan', text: 'Plan text.' } }, alice);
    await chat({ message: 'Another plan', page: { url: 'https://example.com/b', title: 'Plan B', text: 'B text.' } }, alice);
    const snapshot = () => db.query(`SELECT id, role, content, page_doc, meta, input_tokens, output_tokens, cost_usd FROM messages WHERE conversation_id=$1 ORDER BY id`, [first]);
    const rowsBefore = (await snapshot()).rows;
    const conv = (await db.query('SELECT page_url, page_title, memory_site FROM conversations WHERE id=$1', [first])).rows[0];
    const used = (await api('/api/boot', { token: alice })).data.quota.used;
    const wrapped = (await api('/api/wrapped?tz=UTC', { token: alice })).data;
    const overview = (await api(`/api/admin/overview?days=30&user=${aliceId}`, { token: null, admin: true })).data.totals;

    assert.deepEqual((await api('/api/chats/' + first, { method: 'DELETE', token: alice })).data, { ok: true });
    assert.deepEqual((await snapshot()).rows, rowsBefore, 'every message row stays exactly as it was');
    const after = (await db.query('SELECT page_url, page_title, memory_site, hidden_at FROM conversations WHERE id=$1', [first])).rows[0];
    assert.ok(after.hidden_at);
    assert.deepEqual({ page_url: after.page_url, page_title: after.page_title, memory_site: after.memory_site }, conv);
    assert.equal((await api('/api/boot', { token: alice })).data.quota.used, used, 'removing gives back none of today’s limit');
    const wrappedAfter = (await api('/api/wrapped?tz=UTC', { token: alice })).data;
    assert.deepEqual([wrappedAfter.questions, wrappedAfter.sites], [wrapped.questions, wrapped.sites]);
    assert.deepEqual((await api(`/api/admin/overview?days=30&user=${aliceId}`, { token: null, admin: true })).data.totals, overview);

    assert.ok(!(await list('', alice)).data.chats.some(c => c.id === first));
    assert.deepEqual((await list('q=secret', alice)).data.chats, []);
    assert.equal((await api('/api/chats/' + first, { token: alice })).status, 404);
    assert.equal((await api('/api/chats/' + first, { method: 'DELETE', token: alice })).status, 404);

    const activity = (await api(`/api/admin/activity?days=30&user=${aliceId}`, { token: null, admin: true })).data.rows;
    const removed = activity.find(r => r.conversationId === first);
    assert.equal(removed.removed, true);
    assert.equal(removed.question, 'Secret plan');
    assert.ok(activity.filter(r => r.conversationId !== first).every(r => r.removed === false));
    assert.match((await api('/api/admin/activity/' + removed.id, { token: null, admin: true })).data.answer, /fixture answer/);
  });

  await t.test('a removed chat can’t be continued: the question starts a new chat', async () => {
    const gone = await chat({ message: 'About to go' });
    assert.equal((await api('/api/chats/' + gone, { method: 'DELETE' })).status, 200);
    const next = await ask({ conversationId: gone, message: 'Still there?' });
    assert.notEqual(next.conversationId, gone);
    assert.equal(calls.at(-1).body.messages.length, 1, 'none of the removed chat went to the model');
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id=$1', [gone])).rows[0].n, 2);
    assert.equal((await list()).data.chats[0].id, next.conversationId);
  });

  await t.test('removing everything only touches your own chats', async () => {
    assert.equal((await api('/api/chats', { method: 'DELETE', token: bob })).status, 400);
    const ownerCount = (await list()).data.chats.length, aliceCount = (await list('', alice)).data.chats.length;
    const r = await api('/api/chats?all=1', { method: 'DELETE', token: bob });
    assert.equal(r.status, 200);
    assert.ok(r.data.removed >= 35);
    assert.deepEqual((await list('', bob)).data.chats, []);
    assert.equal((await list()).data.chats.length, ownerCount);
    assert.equal((await list('', alice)).data.chats.length, aliceCount);
    assert.ok(Number((await db.query('SELECT COUNT(*)::int AS n FROM messages WHERE user_id=$1', [bobId])).rows[0].n) >= 70, 'bob’s messages are all still there');
  });

  await t.test('searches have their own limit', async () => {
    let limited = null;
    for (let i = 0; i < 31 && !limited; i++) {
      const r = await api('/api/chats?q=plan', { token: alice, ip: '203.0.113.9' });
      if (r.status === 429) limited = r;
      else assert.equal(r.status, 200);
    }
    assert.ok(limited, 'the 31st search in a minute is turned down');
    assert.match(limited.data.error, /searches/);
    assert.equal((await api('/api/chats', { token: alice, ip: '203.0.113.9' })).status, 200, 'listing still works');
  });

  await t.test('older chats get their last activity time when the schema updates', async () => {
    const old = (await db.query("INSERT INTO conversations(created_at, updated_at) VALUES (now() - interval '3 days', NULL) RETURNING id")).rows[0].id;
    await db.query(`INSERT INTO messages(conversation_id, role, content, created_at) VALUES ($1, 'user', 'Old', now() - interval '2 days'), ($1, 'assistant', 'Old answer', now() - interval '47 hours')`, [old]);
    const second = await startServer(); // runs SCHEMA again, as a deploy does
    const row = (await db.query(`SELECT updated_at = (SELECT max(created_at) FROM messages WHERE conversation_id = $1) AS ok FROM conversations WHERE id = $1`, [old])).rows[0];
    assert.equal(row.ok, true);
    second.app.kill(); await once(second.app, 'exit');
  });
});

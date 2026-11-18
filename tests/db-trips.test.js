import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, request } from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// How the server talks to Postgres, seen on the wire. The server reaches the database through a proxy here that reads
// the protocol both ways and notes every statement (its SQL, when it was sent and when its answer got back, on which
// connection, how many rows came back and the first of them) and every connection opened and closed. That pins what the
// answers alone can't show: independent queries going out side by side, "seen just now" marks not waiting for the
// disk, messages never leaving the database for someone else's chat, and idle connections kept for the next question.
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
let db, adminDb, app, mock, wire, origin, owner, logs = '', hop = 0;
const ids = {}, tokens = {}, chats = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the proxy
const conns = [], statements = [];
let delay = 0; // ms added to every answer from Postgres, so that statements in flight at once can't be missed
const cstr = (b, at) => { const end = b.indexOf(0, at); return [b.toString('utf8', at, end), end + 1]; };
function fieldNames(b) {
  const names = [];
  for (let i = 0, at = 2, n = b.readInt16BE(0); i < n; i++) { const [name, next] = cstr(b, at); names.push(name); at = next + 18; }
  return names;
}
function dataRow(b, names = []) {
  const row = {};
  for (let i = 0, at = 2, n = b.readInt16BE(0); i < n; i++) {
    const len = b.readInt32BE(at); at += 4;
    row[names[i] ?? i] = len < 0 ? null : b.toString('utf8', at, at + len);
    if (len > 0) at += len;
  }
  return row;
}
// calls `each(type, body)` for every whole message in `buf` (after `skip` bytes of startup), returns what is left over
function messages(buf, each) {
  while (buf.length >= 5) {
    const n = buf.readInt32BE(1);
    if (buf.length < 1 + n) break;
    each(String.fromCharCode(buf[0]), buf.subarray(5, 1 + n));
    buf = buf.subarray(1 + n);
  }
  return buf;
}
function recordingProxy(target) {
  return net.createServer(client => {
    const conn = { id: conns.length, opened: performance.now(), closed: null, waiting: [] };
    conns.push(conn);
    const server = net.connect(Number(target.port || 5432), target.hostname);
    client.setNoDelay(true); server.setNoDelay(true);
    let up = Buffer.alloc(0), down = Buffer.alloc(0), started = false;
    client.on('data', chunk => {
      server.write(chunk);
      up = Buffer.concat([up, chunk]);
      if (!started) { if (up.length < 4 || up.length < up.readInt32BE(0)) return; up = up.subarray(up.readInt32BE(0)); started = true; } // the startup message has no type
      up = messages(up, (type, body) => {
        // a simple query carries its SQL, an extended one carries it in Parse (after the statement's name)
        const sql = type === 'Q' ? cstr(body, 0)[0] : type === 'P' ? cstr(body, cstr(body, 0)[1])[0] : null;
        if (sql == null) return;
        const s = { conn: conn.id, sql, sent: performance.now(), answered: null, rows: 0, first: null, fields: null, error: null };
        conn.waiting.push(s); statements.push(s);
      });
    });
    // answers are read when Postgres sends them and passed on `delay` ms later, in order
    const out = [];
    const pump = () => {
      while (out.length && out[0].due <= performance.now()) client.write(out.shift().chunk);
      if (out.length) setTimeout(pump, out[0].due - performance.now());
    };
    server.on('data', chunk => {
      const due = performance.now() + delay;
      down = messages(Buffer.concat([down, chunk]), (type, body) => {
        const s = conn.waiting[0];
        if (!s) return; // signing in
        if (type === 'T') s.fields = fieldNames(body);
        else if (type === 'D' && s.rows++ === 0) s.first = dataRow(body, s.fields);
        else if (type === 'E') s.error = body.toString('utf8').replace(/\0/g, ' ');
        else if (type === 'Z') { s.answered = due; conn.waiting.shift(); }
      });
      out.push({ due, chunk });
      if (out.length === 1) pump();
    });
    const end = () => { conn.closed ??= performance.now(); client.destroy(); server.destroy(); };
    client.on('close', end); server.on('close', end); client.on('error', () => {}); server.on('error', () => {});
  }).listen(0, '127.0.0.1');
}
const open = () => conns.filter(c => c.closed == null);
const idle = () => open().every(c => !c.waiting.length);
// the statements a request sent, and the most of them that were in flight at the same moment
async function traced(run) {
  const from = statements.length, r = await run();
  for (let i = 0; i < 100 && !idle(); i++) await sleep(10);
  const sent = statements.slice(from);
  return { r, sent, together: Math.max(0, ...sent.map(s => sent.filter(t => t.sent <= s.sent && t.answered > s.sent).length)) };
}
const find = (sent, re, what) => { const s = sent.filter(x => re.test(x.sql)); assert.equal(s.length, 1, `${what}: exactly one statement matching ${re} (${sent.map(x => x.sql.slice(0, 60)).join(' | ')})`); return s[0]; };
const overlap = (a, b) => a.sent < b.answered && b.sent < a.answered && a.conn !== b.conn;

function api(route, { token, method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(origin + route, { method, agent: false, headers: { 'X-Forwarded-For': `10.66.${hop >> 8 & 255}.${hop++ & 255}`, 'Accept-Encoding': 'identity',
      ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let data = null; try { data = JSON.parse(text); } catch { /* a stream */ } resolve({ status: res.statusCode, data, text }); });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
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
    for await (const chunk of req) void chunk;
    const ev = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    ev({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-5-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'An answer.' } });
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
    ev({ type: 'message_stop' });
    res.end();
  }).listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
  wire = recordingProxy(url);
  await once(wire, 'listening');
  const through = new URL(url.href);
  through.hostname = '127.0.0.1'; through.port = String(wire.address().port);
  const portServer = createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['--import', './tests/helpers/local-model.mjs', 'server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: through.href, PGSSL: 'false', PORT: String(port), INITIAL_PASSWORD: '', ADMIN_TOKEN: 'db-trips-admin-token-' + randomBytes(6).toString('hex'),
      ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: mockOrigin, PAGEBOT_MOCK_MODEL_ORIGIN: mockOrigin, SYSTEM_PROMPT: 'You are a test helper.', TIMEZONE: 'UTC', RAILWAY_PUBLIC_DOMAIN: '' },
  });
  app.stdout.on('data', c => { logs += c; }); app.stderr.on('data', c => { logs += c; });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (app.exitCode != null) throw new Error(`Test server exited: ${logs}`);
    try { ready = (await fetch(origin + '/health')).ok; } catch { /* starting */ }
    if (!ready) await sleep(100);
  }
  assert.ok(ready, `Server failed to start: ${logs}`);
  // the owner, an account with a daily limit (so its boot reads today's usage too) and one without; commands, an
  // announcement, and a chat each
  owner = await session();
  for (const [name, kind, value] of [['alice', 'tokens', 100000000], ['free', null, null]]) {
    ids[name] = Number((await db.query(`INSERT INTO users(username,password_hash,status,limit_kind,limit_value) VALUES ($1,'x','trusted',$2,$3) RETURNING id`, [name, kind, value])).rows[0].id);
    tokens[name] = await session(ids[name]);
  }
  await db.query(`INSERT INTO slash_commands(user_id,name,prompt) VALUES (NULL,'brief','Be brief.'),($1,'brief','Be brief.')`, [ids.alice]);
  await db.query("INSERT INTO announcements(body) VALUES ('Hello, everyone.')");
  for (const [who, uid] of [['owner', null], ['alice', ids.alice]]) {
    chats[who] = Number((await db.query(`INSERT INTO conversations(page_url,page_title,user_id) VALUES ('https://example.com/a','An article',$1) RETURNING id`, [uid])).rows[0].id);
    await db.query(`INSERT INTO messages(conversation_id,role,content,user_id) VALUES ($1,'user','What is this?',$2),($1,'assistant','An article.',$2)`, [chats[who], uid]);
  }
});

after(async () => {
  if (app && app.exitCode == null && app.signalCode == null) { app.kill(); await once(app, 'exit'); }
  mock?.close(); wire?.close();
  await db?.end();
  if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
});

test('database round trips', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  const device = { 'X-Pagebot-Device': randomBytes(16).toString('hex') };

  await t.test('an account’s /api/boot sends the questions that don’t wait on each other side by side, once the pool has connections for them', async () => {
    // the first boots find one connection: they take turns on it, and the pool opens the others in the background
    for (let i = 0; i < 3; i++) assert.equal((await api('/api/boot', { token: tokens.alice, headers: device })).data.who, 'user');
    for (let i = 0; i < 200 && open().length < 4; i++) await sleep(20);
    assert.ok(open().length >= 4, `the pool opened connections for them (${open().length})`);
    delay = 40;
    try {
      const { r, sent, together } = await traced(() => api('/api/boot', { token: tokens.alice, headers: device }));
      assert.equal(r.data.who, 'user');
      const [seen, news, used, commands] = [/INSERT INTO user_devices/, /FROM announcements/, /SUM\(input_tokens \+ output_tokens\)/, /FROM slash_commands/].map(re => find(sent, re, 'account boot'));
      for (const [a, b] of [[seen, news], [news, used], [used, commands], [news, commands]]) assert.ok(overlap(a, b), `in flight at the same time:\n  ${a.sql.slice(0, 70)}\n  ${b.sql.slice(0, 70)}`);
      assert.ok(together >= 3, `${together} statements in flight at once`);
    } finally { delay = 0; }
    // today's usage is only read for an account that has a limit to show it against
    const { r, sent } = await traced(() => api('/api/boot', { token: tokens.free, headers: device }));
    assert.equal(r.data.who, 'user');
    assert.equal(sent.filter(s => /SUM\(input_tokens \+ output_tokens\)/.test(s.sql)).length, 0, 'no usage read without a limit');
  });

  await t.test('“seen just now” marks don’t wait for the disk, each statement for itself, and the session and the account are touched one after the other', async () => {
    for (const [who, token] of [['owner', owner], ['account', tokens.alice]]) {
      const { sent } = await traced(() => api('/api/boot', { token, headers: device }));
      const marks = [find(sent, /^UPDATE sessions s SET last_used/, who), ...(who === 'owner' ? [] : [find(sent, /^UPDATE users SET last_seen/, who), find(sent, /INSERT INTO user_devices/, who)])];
      // (set_config answers with the value it set, so 'off' here means it ran inside that very statement)
      for (const s of marks) assert.equal(s.first?.set_config, 'off', `${who}: synchronous_commit is turned off by ${s.sql.slice(0, 50)}`);
      // never both rows in one statement: that would hold the session while waiting for the account (see delivery-server.test.js)
      assert.equal(sent.filter(s => /UPDATE sessions/.test(s.sql) && /UPDATE users/.test(s.sql)).length, 0);
      if (who === 'account') assert.ok(marks[0].answered <= marks[1].sent, 'the account is touched after its session, not alongside');
    }
  });

  await t.test('reading or continuing a chat: the chat and its messages go side by side, and messages only ever leave the database for your own chat', async () => {
    const MESSAGES = /pdf_stored FROM messages/, CHAT = /^SELECT c\.id, c\.page_url/;
    delay = 40;
    try {
      let { r, sent } = await traced(() => api(`/api/chats/${chats.alice}`, { token: tokens.alice }));
      assert.equal(r.status, 200);
      assert.equal(r.data.messages.length, 2);
      assert.ok(overlap(find(sent, CHAT, 'own chat'), find(sent, MESSAGES, 'own chat')), 'the chat and its messages are read side by side');
      assert.equal(find(sent, MESSAGES, 'own chat').rows, 2);
      // someone else's chat looks like one that isn't there, and none of its messages were read
      ({ r, sent } = await traced(() => api(`/api/chats/${chats.owner}`, { token: tokens.alice })));
      assert.equal(r.status, 404);
      assert.equal(find(sent, MESSAGES, 'their chat').rows, 0, 'no messages came back for someone else’s chat');
      // the same for a question that tries to continue it: it starts a new chat, and the old one's messages stay put
      const PAST = /^SELECT role, content, had_image, page_doc, steps, attachment_id FROM messages/, CONV = /^SELECT memory_site, page_url FROM conversations/;
      ({ r, sent } = await traced(() => api('/api/chat', { token: tokens.alice, method: 'POST', body: { message: 'And then?', conversationId: chats.alice } })));
      assert.equal(r.status, 200, r.text);
      assert.ok(overlap(find(sent, CONV, 'own follow-up'), find(sent, PAST, 'own follow-up')), 'the chat and its history are read side by side');
      assert.equal(find(sent, PAST, 'own follow-up').rows, 2);
      ({ r, sent } = await traced(() => api('/api/chat', { token: tokens.alice, method: 'POST', body: { message: 'And then?', conversationId: chats.owner } })));
      assert.equal(r.status, 200, r.text);
      assert.notEqual(JSON.parse(r.text.split('\n')[0]).conversationId, chats.owner, 'a new chat');
      assert.equal(find(sent, PAST, 'their follow-up').rows, 0, 'no messages came back for someone else’s chat');
    } finally { delay = 0; }
  });

  await t.test('the history list starts its transaction and its time limit in one trip', async () => {
    const { r, sent } = await traced(() => api('/api/chats', { token: tokens.alice }));
    assert.equal(r.status, 200);
    assert.equal(sent[sent.findIndex(s => /^BEGIN/.test(s.sql))]?.sql, `BEGIN; SET LOCAL statement_timeout = '3s'`);
  });

  await t.test('a connection idle for longer than node-postgres’ usual 10 seconds is still there for the next question', async () => {
    for (let i = 0; i < 100 && !idle(); i++) await sleep(10);
    const opened = conns.length, closed = conns.filter(c => c.closed != null).length;
    await sleep(11_000);
    assert.equal((await api('/api/boot', { token: owner })).data.who, 'owner');
    assert.deepEqual([conns.length - opened, conns.filter(c => c.closed != null).length - closed], [0, 0], 'none opened again, none closed');
  });
});

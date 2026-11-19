import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Agent, createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';
import pg from 'pg';

// How the real server delivers things: pages in gzip and brotli with validators and 304s, the homepage per host, big JSON
// compressed and everything with a secret (or a stream) left alone, and /api/boot giving each kind of caller exactly what
// it always did. The server runs from a copy of the app in a temporary folder, so a page can be edited under it.
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const ADMIN = 'delivery-test-admin-token-' + randomBytes(6).toString('hex');
const BROWSER = 'gzip, deflate, br, zstd'; // what browsers send
let db, adminDb, app, mock, copy, origin, owner, logs = '', hop = 0;
const ids = {}, tokens = {};
let hold = null; // the mock model waits on this between two pieces of an answer

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
const decoded = r => r.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.body) : r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body;
// One request exactly as it crosses the wire: nothing decoded, no header added for us. Each comes from "another address"
// (the server trusts one proxy hop), so the per-address limits of one test don't run into another's.
function raw(route, { headers = {}, method = 'GET', body, ip, onChunk, agent = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(origin + route, { method, agent, headers: { 'X-Forwarded-For': ip || `10.77.${hop >> 8 & 255}.${hop++ & 255}`, ...headers, ...(body && { 'Content-Type': 'application/json' }) } }, res => {
      const chunks = [];
      res.on('data', c => { chunks.push(c); onChunk?.(Buffer.concat(chunks).toString('utf8'), res); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const bearer = token => ({ Authorization: `Bearer ${token}` });
async function api(route, { token = owner, admin, method = 'GET', body, headers = {}, ip } = {}) {
  const r = await raw(route, { method, body, ip, headers: { ...(token && bearer(token)), ...(admin && { 'x-admin-token': ADMIN }), ...headers } });
  return { status: r.status, headers: r.headers, data: JSON.parse(decoded(r).toString('utf8') || '{}'), text: decoded(r).toString('utf8') };
}
async function session(userId = null) {
  const token = randomBytes(24).toString('hex');
  await db.query('INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), userId]);
  return token;
}
const iso = d => new Date(d).toISOString();
// the same value with the same keys in the same order, all the way down
function same(actual, expected, what) {
  assert.deepEqual(actual, expected, what);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${what}: the keys come in the same order`);
}
// waits for the background compression of a page to finish (a second or two for the panel at brotli 11)
async function until(route, encoding, headers = {}) {
  for (let i = 0; i < 400; i++) {
    const r = await raw(route, { headers: { 'Accept-Encoding': encoding, ...headers } });
    if (r.headers['content-encoding'] === encoding) return r;
    await sleep(50);
  }
  assert.fail(`${route} was never served as ${encoding}`);
}

before(async () => {
  if (!database) return;
  adminDb = new pg.Pool({ connectionString: database });
  await adminDb.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(database);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  db = new pg.Pool({ connectionString: url.href });
  // a model that answers in two pieces and waits in between for as long as a test holds it
  mock = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    const ev = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    ev({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-5-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'First piece. ' } });
    await hold;
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Second piece.' } });
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    ev({ type: 'message_stop' });
    res.end();
  }).listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
  // the app, copied: its own public/ to edit, the real node_modules
  copy = mkdtempSync(path.join(tmpdir(), 'pagebot-app-'));
  for (const f of ['server.js', 'bookmarklet.js', 'package.json', 'lib', 'public']) cpSync(path.join(root, f), path.join(copy, f), { recursive: true });
  mkdirSync(path.join(copy, 'tests/helpers'), { recursive: true });
  cpSync(path.join(root, 'tests/helpers/local-model.mjs'), path.join(copy, 'tests/helpers/local-model.mjs'));
  symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const portServer = createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['--import', './tests/helpers/local-model.mjs', 'server.js'], {
    cwd: copy, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: url.href, PGSSL: 'false', PORT: String(port), INITIAL_PASSWORD: '', ADMIN_TOKEN: ADMIN, ANTHROPIC_API_KEY: 'local-fixture-only',
      ANTHROPIC_BASE_URL: mockOrigin, PAGEBOT_MOCK_MODEL_ORIGIN: mockOrigin, SYSTEM_PROMPT: 'You are a test helper.', TIMEZONE: 'UTC', RAILWAY_PUBLIC_DOMAIN: '' },
  });
  app.stdout.on('data', c => { logs += c; }); app.stderr.on('data', c => { logs += c; });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (app.exitCode != null) throw new Error(`Test server exited: ${logs}`);
    try { ready = (await fetch(origin + '/health')).ok; } catch { /* starting */ }
    if (!ready) await sleep(100);
  }
  assert.ok(ready, `Server failed to start: ${logs}`);
  owner = await session();
});

after(async () => {
  if (app && app.exitCode == null && app.signalCode == null) { app.kill(); await once(app, 'exit'); }
  mock?.close();
  await db?.end();
  if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
  if (copy) rmSync(copy, { recursive: true, force: true });
});

test('delivery integration', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  await t.test('/api/boot before anyone has an account: what a signed-out panel gets, and whether accounts exist', async () => {
    const out = await api('/api/boot', { token: null });
    assert.equal(out.status, 200);
    same(out.data, { version: 14, extVersion: 1, theme: 'ember', lock: 'none', passwordSet: false, accounts: { on: true, signup: true }, authed: false }, 'signed out');
    assert.equal(out.headers['cache-control'], 'no-store');
    assert.equal(out.headers['content-encoding'], undefined);
    same((await api('/api/boot', { token: 'not-a-session' })).data, out.data, 'an unknown token is signed out');
    // with sign-ups closed, "accounts" says whether anyone was ever let in
    assert.equal((await api('/api/admin/accounts', { admin: true, method: 'POST', body: { signup: false } })).data.signup, false);
    same((await api('/api/boot', { token: null })).data.accounts, { on: false, signup: false }, 'closed, nobody yet');
    await db.query("INSERT INTO users(username,password_hash) VALUES ('waiting','x')");
    same((await api('/api/boot', { token: null })).data.accounts, { on: false, signup: false }, 'someone waiting is not an account yet');
    same((await api('/api/boot', { token: owner })).data.accounts, { on: false, signup: false }, 'the same for the owner');
    const users = await db.query(`INSERT INTO users(username,password_hash,status,limit_kind,limit_value) VALUES
      ('alice','x','trusted','tokens',1000),('free','x','trusted',NULL,NULL),('blocked','x','blocked','tokens',1000),('banned','x','trusted','tokens',1000),('held','x','trusted','usd',2)
      RETURNING id, username`);
    for (const u of [...users.rows, ...(await db.query("SELECT id, username FROM users WHERE username = 'waiting'")).rows]) { ids[u.username] = Number(u.id); tokens[u.username] = await session(Number(u.id)); }
    same((await api('/api/boot', { token: null })).data.accounts, { on: true, signup: false }, 'closed, but accounts exist');
    assert.equal((await api('/api/admin/accounts', { admin: true, method: 'POST', body: { signup: true } })).data.signup, true);
    same((await api('/api/boot', { token: null })).data.accounts, { on: true, signup: true }, 'open again');
  });

  const COMMAND_LIMITS = { maxCommands: 50, maxPrompt: 2000, maxStarters: 3, reserved: ['summarize', 'keypoints', 'simple', 'new', 'web', 'page', 'screenshot', 'region', 'settings', 'help', 'history', 'pdf', 'actions'] };
  const LIMITS = { maxTokens: 100000, pageTokens: 5000, maxSearches: 3, maxTokensCap: 100000 };
  const PREFS = { theme: 'ember', model: 'haiku', web: false, actions: false, actionsAuto: false };
  const BASE = { version: 14, extVersion: 1, theme: 'ember', lock: 'none', passwordSet: false, accounts: { on: true, signup: true } };
  const LOCKS = [0, 1, 5, 15, 30, 60, 240, 1440];
  const person = (name, status, more = {}) => ({ name, status, allowSonnet: true, allowWeb: true, allowPdf: true, allowActions: true, passcode: false, lockMinutes: 15, ...more });
  const command = r => ({ name: r.name, prompt: r.prompt, starter: r.starter, updatedAt: iso(r.updated_at) });

  await t.test('/api/boot gives the owner everything, with their commands in name order', async () => {
    const saved = (await db.query(`INSERT INTO slash_commands(user_id,name,prompt,starter) VALUES (NULL,'zeta','Last by name.',false),(NULL,'brief','Say it in one line.',true) RETURNING *`)).rows;
    const out = await api('/api/boot');
    same(out.data, { ...BASE, authed: true, who: 'owner', lockMinutes: 0, prefs: PREFS, limits: LIMITS,
      models: [{ key: 'haiku', label: 'Haiku 5.5' }, { key: 'sonnet', label: 'Sonnet 5.5' }],
      commands: [command(saved[1]), command(saved[0])], commandLimits: COMMAND_LIMITS }, 'the owner');
  });

  await t.test('/api/boot gives an accepted account its own view: a percentage of today, the announcement, its commands', async () => {
    const mine = (await db.query(`INSERT INTO slash_commands(user_id,name,prompt,starter) VALUES ($1,'tldr','Shorter.',true) RETURNING *`, [ids.alice])).rows[0];
    const conv = Number((await db.query('INSERT INTO conversations(user_id) VALUES($1) RETURNING id', [ids.alice])).rows[0].id);
    await db.query(`INSERT INTO messages(conversation_id,role,content,input_tokens,output_tokens,user_id) VALUES ($1,'user','hi',200,0,$2),($1,'assistant','hello',0,50,$2)`, [conv, ids.alice]);
    const ann = (await db.query("INSERT INTO announcements(body) VALUES ('Sonnet is on for everyone this week.') RETURNING *")).rows[0];
    const models = [{ key: 'haiku', label: 'Haiku 5.5', locked: false }, { key: 'sonnet', label: 'Sonnet 5.5', locked: false }];
    const expected = { ...BASE, authed: true, who: 'user', lockMinutes: 0, lockChoices: LOCKS, user: person('alice', 'trusted'), prefs: PREFS, limits: LIMITS, models,
      quota: { pct: 25 }, announcement: { id: Number(ann.id), body: ann.body, createdAt: iso(ann.created_at) }, restriction: null, commands: [command(mine)], commandLimits: COMMAND_LIMITS };
    same((await api('/api/boot', { token: tokens.alice })).data, expected, 'alice, a quarter of the way through today’s 1,000 tokens');
    // an account with no daily limit has no quota to show
    same((await api('/api/boot', { token: tokens.free })).data, { ...expected, user: person('free', 'trusted'), quota: null, commands: [] }, 'no limit');
    // an announcement they dismissed stays away
    await db.query('UPDATE users SET ann_seen = $2 WHERE id = $1', [ids.free, ann.id]);
    assert.equal((await api('/api/boot', { token: tokens.free })).data.announcement, null);
    // a restriction shows, and takes effect
    const r = (await api(`/api/admin/users/${ids.held}/ban`, { admin: true, method: 'POST', body: { kind: 'restrict', hours: 24, reason: 'Slow down', noSonnet: true, limitKind: 'tokens', limitValue: 5000 } })).data.ban;
    const held = (await api('/api/boot', { token: tokens.held })).data;
    same(held, { ...expected, user: person('held', 'trusted', { allowSonnet: false }), models: [models[0], { ...models[1], locked: true }], quota: { pct: 0 }, commands: [],
      restriction: { id: r.id, kind: 'restrict', state: 'restricted', name: 'held', reason: 'Slow down', note: '', hours: 24, at: r.at, endsAt: r.endsAt, key: r.key, limits: { noSonnet: true, lowerLimit: true } } }, 'restricted');
  });

  await t.test('/api/boot tells waiting, turned-off and banned accounts only who they are (and why)', async () => {
    const some = { ...BASE, authed: true, who: 'user', lockMinutes: 0, lockChoices: LOCKS };
    same((await api('/api/boot', { token: tokens.waiting })).data, { ...some, user: person('waiting', 'pending') }, 'waiting to be accepted');
    same((await api('/api/boot', { token: tokens.blocked })).data, { ...some, user: person('blocked', 'blocked') }, 'turned off');
    const b = (await api(`/api/admin/users/${ids.banned}/ban`, { admin: true, method: 'POST', body: { kind: 'ban', hours: 24, reason: 'Spam', note: 'Read the rules.' } })).data.ban;
    assert.equal((await db.query('SELECT seen_at FROM bans WHERE id = $1', [b.id])).rows[0].seen_at, null);
    const expected = { ...some, user: person('banned', 'trusted'), ban: { id: b.id, kind: 'ban', state: 'active', name: 'banned', reason: 'Spam', note: 'Read the rules.', hours: 24, at: b.at, endsAt: b.endsAt, key: b.key, appeal: null } };
    same((await api('/api/boot', { token: tokens.banned })).data, expected, 'banned');
    const seen = (await db.query('SELECT seen_at FROM bans WHERE id = $1', [b.id])).rows[0].seen_at;
    assert.ok(seen, 'showing the notice marks it seen');
    same((await api('/api/boot', { token: tokens.banned })).data, expected, 'banned, again');
    assert.deepEqual((await db.query('SELECT seen_at FROM bans WHERE id = $1', [b.id])).rows[0].seen_at, seen, 'only the first time');
    assert.equal((await api('/api/chats', { token: tokens.banned })).status, 403, 'and everything else stays shut');
  });

  await t.test('/api/boot still touches the session and the account, notes the browser, and keeps its limit of 60 a minute', async () => {
    const hash = createHash('sha256').update(tokens.alice).digest('hex'), device = randomBytes(16).toString('hex');
    await db.query(`UPDATE sessions SET last_used = now() - interval '1 hour', ip = NULL WHERE token_hash = $1`, [hash]);
    await db.query('UPDATE users SET last_seen = NULL WHERE id = $1', [ids.alice]);
    assert.equal((await api('/api/boot', { token: tokens.alice, ip: '10.99.0.1', headers: { 'X-Pagebot-Device': device } })).data.authed, true);
    const s = (await db.query(`SELECT last_used > now() - interval '1 minute' AS fresh, ip FROM sessions WHERE token_hash = $1`, [hash])).rows[0];
    assert.deepEqual(s, { fresh: true, ip: '10.99.0.1' });
    assert.ok((await db.query('SELECT last_seen FROM users WHERE id = $1', [ids.alice])).rows[0].last_seen, 'the account was seen');
    const noted = () => db.query("SELECT username FROM user_devices WHERE device = $1", [createHash('sha256').update('device:' + device).digest('hex')]).then(r => r.rows.map(x => x.username));
    assert.deepEqual(await noted(), ['alice'], 'the browser is noted under the account, hashed');
    await api('/api/boot', { headers: { 'X-Pagebot-Device': device } });
    assert.deepEqual(await noted(), ['alice'], 'the owner’s boot notes nothing');
    await api('/api/boot', { token: tokens.waiting, headers: { 'X-Pagebot-Device': device } });
    assert.deepEqual((await noted()).sort(), ['alice', 'waiting'], 'an account still waiting is noted too');
    // a session past its time is signed out, and stays untouched
    await db.query(`UPDATE sessions SET last_used = now() - interval '40 days' WHERE token_hash = $1`, [hash]);
    assert.equal((await api('/api/boot', { token: tokens.alice })).data.authed, false);
    assert.equal((await db.query(`SELECT last_used < now() - interval '39 days' AS old FROM sessions WHERE token_hash = $1`, [hash])).rows[0].old, true);
    await db.query('UPDATE sessions SET last_used = now() WHERE token_hash = $1', [hash]);
    // a deleted account's session is gone with it
    const gone = Number((await db.query("INSERT INTO users(username,password_hash,status) VALUES ('gone','x','trusted') RETURNING id")).rows[0].id), goneToken = await session(gone);
    assert.equal((await api('/api/boot', { token: goneToken })).data.who, 'user');
    await db.query('DELETE FROM users WHERE id = $1', [gone]);
    assert.equal((await api('/api/boot', { token: goneToken })).data.authed, false);
    // 60 a minute from one address, then 429
    const codes = [];
    for (let i = 0; i < 62; i++) codes.push((await raw('/api/boot', { ip: '10.99.0.2' })).status);
    assert.deepEqual([codes.slice(0, 60).every(c => c === 200), codes[60], codes[61]], [true, 429, 429]);
  });

  await t.test('/api/boot with passcodes: the owner’s lock time and an account’s own decide when a session has gone idle too long', async () => {
    // the owner's passcode: its lock time is the owner sessions' idle limit (0 means "never lock", so the usual 30 days)
    const mine = await session(), hash = createHash('sha256').update(mine).digest('hex');
    const idle = (token, minutes) => db.query(`UPDATE sessions SET last_used = now() - make_interval(mins => $2) WHERE token_hash = $1`, [createHash('sha256').update(token).digest('hex'), minutes]);
    assert.deepEqual((await api('/api/admin/passcode', { admin: true, method: 'POST', body: { passcode: '24680', lockMinutes: 5 } })).data, { ok: true, on: true, minutes: 5 });
    let out = (await api('/api/boot', { token: mine })).data;
    assert.deepEqual([out.authed, out.who, out.lock, out.lockMinutes], [true, 'owner', 'passcode', 5]);
    await idle(mine, 4);
    assert.equal((await api('/api/boot', { token: mine })).data.authed, true, 'idle for less than the lock time');
    await idle(mine, 6);
    out = (await api('/api/boot', { token: mine })).data;
    assert.deepEqual([out.authed, out.lock, out.who], [false, 'passcode', undefined], 'idle for longer: locked');
    assert.equal((await db.query(`SELECT last_used < now() - interval '5 minutes' AS old FROM sessions WHERE token_hash = $1`, [hash])).rows[0].old, true, 'and not touched');
    await api('/api/admin/passcode', { admin: true, method: 'POST', body: { lockMinutes: 0 } });
    out = (await api('/api/boot', { token: mine })).data;
    assert.deepEqual([out.authed, out.who, out.lock, out.lockMinutes], [true, 'owner', 'passcode', 0], 'a lock time of 0 never locks');
    await api('/api/admin/passcode', { admin: true, method: 'POST', body: { passcode: null, lockMinutes: 15 } });
    await idle(mine, 6);
    out = (await api('/api/boot', { token: mine })).data;
    assert.deepEqual([out.authed, out.who, out.lock, out.lockMinutes], [true, 'owner', 'none', 0], 'no passcode: no lock');
    // an account's own passcode: its own lock time, whatever the owner's is
    await db.query(`UPDATE users SET passcode_hash = 'fixture', lock_minutes = 5 WHERE id = $1`, [ids.alice]);
    await idle(tokens.alice, 4);
    out = (await api('/api/boot', { token: tokens.alice })).data;
    assert.deepEqual([out.authed, out.who, out.lockMinutes, out.user.passcode, out.user.lockMinutes], [true, 'user', 5, true, 5]);
    await idle(tokens.alice, 6);
    assert.deepEqual((await api('/api/boot', { token: tokens.alice })).data, { ...BASE, authed: false }, 'idle for longer than its own lock time: signed out');
    await db.query(`UPDATE users SET lock_minutes = 0 WHERE id = $1`, [ids.alice]);
    out = (await api('/api/boot', { token: tokens.alice })).data;
    assert.deepEqual([out.authed, out.lockMinutes, out.user.lockMinutes], [true, 0, 0], 'its lock time of 0 never locks');
    await db.query(`UPDATE users SET passcode_hash = NULL, lock_minutes = 15 WHERE id = $1`, [ids.alice]);
    await idle(tokens.alice, 6);
    out = (await api('/api/boot', { token: tokens.alice })).data;
    assert.deepEqual([out.authed, out.lockMinutes, out.user.passcode], [true, 0, false], 'no passcode: no lock');
  });

  await t.test('an account deleted while its panel is signed in: the delete and the panel’s request both finish, in the worst order too', async () => {
    // Deleting an account holds its row while the cascade removes its sessions. A session touch that held its session
    // while it waited for that account row would close the circle: Postgres then ends one of the two after a second
    // (deadlock_timeout), and either the panel gets a 500 or the owner does and the account stays. Here they meet in
    // that order on purpose: a third connection holds the account's row, the delete queues for it first, and the
    // panel's /api/boot queues behind the delete.
    const blocked = async (pid, like) => (await db.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE $2', [pid, like])).rows[0]?.pid;
    const waitFor = async (what, f) => { for (let i = 0; i < 300; i++) { const v = await f(); if (v) return v; await sleep(10); } assert.fail(`never: ${what}`); };
    async function meet(name, prepare, remove) {
      const id = Number((await db.query(`INSERT INTO users(username,password_hash,status) VALUES ($1,'x','trusted') RETURNING id`, [name])).rows[0].id), token = await session(id);
      await db.query(`INSERT INTO site_memories(user_id, site, instructions) VALUES ($1, 'example.com', 'Be brief.')`, [id]);
      await prepare?.(id);
      const hold = await db.connect();
      let gone, boot;
      try {
        await hold.query('BEGIN');
        await hold.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [id]);
        const holder = (await hold.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        gone = remove(id);
        const deleting = await waitFor('the delete waits for the account row', () => blocked(holder, 'DELETE FROM users%'));
        boot = api('/api/boot', { token });
        await waitFor('the panel waits behind the delete', async () => await blocked(deleting, '%UPDATE users SET last_seen%') || blocked(holder, '%UPDATE users SET last_seen%'));
      } finally { await hold.query('COMMIT'); hold.release(); }
      const [d, b] = await Promise.all([gone, boot]);
      const left = (await db.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [id])).rows[0].n;
      return { d, b, left };
    }
    // the owner deletes the account in /admin
    let { d, b, left } = await meet('doomed', null, id => api(`/api/admin/users/${id}`, { admin: true, method: 'DELETE' }));
    assert.deepEqual([d.status, d.data], [200, { ok: true }], 'the delete went through');
    assert.deepEqual([b.status, b.data.authed], [200, false], 'and the panel is simply signed out');
    assert.equal(left, 0);
    // a termination whose two weeks are up, deleted by the sweep (which a sign-in by name runs first)
    ({ d, b, left } = await meet('terminated', id => db.query(`WITH b AS (INSERT INTO bans(user_id, username, kind, reason, notice_key, ends_at, seen_at)
        VALUES ($1, 'terminated', 'terminate', 'Test.', $2, now() - interval '1 minute', now()) RETURNING id) UPDATE users SET ban_id = (SELECT id FROM b) WHERE id = $1`, [id, randomBytes(12).toString('hex')]),
      () => api('/api/login', { token: null, method: 'POST', body: { username: 'nobody-by-that-name', password: 'wrong' } })));
    assert.equal(d.status, 401, 'the sign-in is answered as usual, after the sweep');
    assert.deepEqual([b.status, b.data.authed], [200, false]);
    assert.equal(left, 0, 'the sweep deleted the account');
    assert.doesNotMatch(logs, /deadlock/i);
  });

  await t.test('every page round-trips in each encoding, and its policy lists exactly the scripts that were sent', async () => {
    for (const route of ['/widget', '/chat', '/admin']) {
      const plain = await raw(route, { headers: { 'Accept-Encoding': 'identity' } });
      assert.equal(plain.status, 200);
      assert.equal(plain.headers['content-encoding'], undefined);
      assert.ok(plain.body.length > 100_000, `${route} is the real page`);
      assert.deepEqual(plain.body, (await raw(route)).body, 'no Accept-Encoding gets the plain page too');
      const br = await until(route, 'br'), gz = await until(route, 'gzip'), browser = await raw(route, { headers: { 'Accept-Encoding': BROWSER } });
      assert.equal(browser.headers['content-encoding'], 'br', 'a browser gets brotli');
      assert.ok(br.body.length < gz.body.length && gz.body.length < plain.body.length * 0.35, `${route}: brotli ${br.body.length} < gzip ${gz.body.length} < plain ${plain.body.length}`);
      const etags = new Set();
      for (const r of [plain, gz, br, browser]) {
        assert.deepEqual(decoded(r), plain.body, `${route} as ${r.headers['content-encoding'] || 'identity'} decodes to the same bytes`);
        assert.equal(Number(r.headers['content-length']), r.body.length);
        assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
        assert.equal(r.headers.vary, 'Accept-Encoding');
        assert.equal(r.headers['cache-control'], 'no-cache');
        assert.equal(r.headers['x-content-type-options'], 'nosniff');
        assert.match(r.headers.etag, /^W\/"[\w-]{22}(\.gz|\.br)?"$/);
        etags.add(r.headers.etag);
        // the policy allows exactly the inline scripts in what was sent
        const scripts = [...decoded(r).toString('utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => sha(m[1]));
        const allowed = /script-src ([^;]+);/.exec(r.headers['content-security-policy'])[1].split(' ');
        assert.ok(scripts.length > 0);
        assert.deepEqual(allowed, scripts);
        assert.equal(r.headers['content-security-policy'], plain.headers['content-security-policy']);
      }
      assert.equal(etags.size, 3, 'a validator per encoding');
    }
    // the panel may be framed anywhere; the workspace and the dashboard nowhere
    const [widget, chat] = [await raw('/widget'), await raw('/chat')];
    assert.match(widget.headers['content-security-policy'], /frame-ancestors \* chrome-extension:\/\/inknjdpepdgianddhnnpkdbpkjbbiomg$/);
    assert.equal(widget.headers['cross-origin-opener-policy'], undefined);
    assert.match(chat.headers['content-security-policy'], /frame-ancestors 'none'$/);
    assert.equal(chat.headers['cross-origin-opener-policy'], 'same-origin');
    assert.deepEqual(widget.body, chat.body, 'the same file');
    assert.notEqual(widget.headers.etag, chat.headers.etag, 'the validator covers the policy that goes with the page');
    const agent = new Agent({ keepAlive: true });
    assert.equal((await raw('/widget', { agent })).headers['keep-alive'], 'timeout=65', 'connections are kept open longer than the proxy in front keeps its own');
    agent.destroy();
  });

  await t.test('a browser that has the page gets a 304 with the policy and no body; HEAD gets headers only', async () => {
    for (const route of ['/widget', '/chat', '/admin']) {
      const first = await raw(route, { headers: { 'Accept-Encoding': BROWSER } });
      const again = await raw(route, { headers: { 'Accept-Encoding': BROWSER, 'If-None-Match': first.headers.etag } });
      assert.equal(again.status, 304);
      assert.equal(again.body.length, 0);
      for (const h of ['etag', 'vary', 'cache-control', 'content-security-policy', 'cross-origin-opener-policy', 'x-content-type-options', 'referrer-policy'])
        assert.equal(again.headers[h], first.headers[h], `${route}: ${h} on the 304`);
      for (const h of ['content-encoding', 'content-type', 'content-length']) assert.equal(again.headers[h], undefined, `${route}: no ${h} on a 304`);
      assert.equal((await raw(route, { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': first.headers.etag } })).status, 200, 'the brotli copy is no use to a browser that only takes gzip');
      assert.equal((await raw(route, { headers: { 'Accept-Encoding': BROWSER, 'If-None-Match': 'W/"an-older-version.br"' } })).status, 200);
      const head = await raw(route, { method: 'HEAD', headers: { 'Accept-Encoding': BROWSER } });
      assert.deepEqual([head.status, head.body.length, head.headers['content-encoding'], head.headers['content-length'], head.headers.etag],
        [200, 0, 'br', first.headers['content-length'], first.headers.etag]);
    }
    assert.equal((await raw('/widget', { headers: { 'If-None-Match': (await raw('/chat')).headers.etag } })).status, 200, 'one page’s validator is not another’s');
  });

  await t.test('the homepage is made for the host it is opened from, never stored, and compressed once it has been asked for', async () => {
    const bookmark = r => decodeURIComponent(/id="bm" href="javascript:([^"]+)"/.exec(decoded(r).toString('utf8'))[1].replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
    const plain = await raw('/', { headers: { Host: 'bookmark.example.test' } });
    assert.equal(plain.status, 200);
    assert.match(bookmark(plain), /var O="http:\/\/bookmark\.example\.test"/);
    assert.equal(plain.headers['cache-control'], 'no-store');
    assert.equal(plain.headers.etag, undefined, 'a page that is never stored needs no validator');
    assert.equal(plain.headers.vary, 'Host, X-Forwarded-Host, X-Forwarded-Proto, Accept-Encoding');
    assert.equal(plain.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
    assert.match(plain.headers['content-security-policy'], /frame-ancestors 'none'$/);
    assert.equal(plain.headers['cross-origin-opener-policy'], 'same-origin');
    for (const enc of ['br', 'gzip']) {
      const r = await until('/', enc, { Host: 'bookmark.example.test' });
      assert.deepEqual(decoded(r), plain.body);
      assert.ok(r.body.length < plain.body.length * 0.4, `${enc}: ${r.body.length} of ${plain.body.length} bytes`);
      assert.equal(r.headers.vary, plain.headers.vary);
      assert.equal(r.headers.etag, undefined);
      const scripts = [...decoded(r).toString('utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => sha(m[1]));
      assert.deepEqual(/script-src ([^;]+);/.exec(r.headers['content-security-policy'])[1].split(' '), scripts);
    }
    assert.equal((await raw('/', { headers: { Host: 'bookmark.example.test', 'If-None-Match': '*' } })).status, 200, 'never a 304');
    assert.deepEqual((await raw('/install', { headers: { Host: 'bookmark.example.test' } })).body, plain.body, '/install is the same page');
    // more hosts than are kept: each still gets its own bookmark, and the first one too when it comes back
    for (let i = 0; i < 12; i++) {
      const r = await raw('/', { headers: { Host: `h${i}.example.test:8443`, 'X-Forwarded-Proto': i % 2 ? 'https' : 'http', 'Accept-Encoding': BROWSER } });
      assert.match(bookmark(r), new RegExp(`var O="${i % 2 ? 'https' : 'http'}://h${i}\\.example\\.test:8443"`));
    }
    assert.match(bookmark(await raw('/', { headers: { Host: 'bookmark.example.test', 'Accept-Encoding': BROWSER } })), /var O="http:\/\/bookmark\.example\.test"/);
  });

  await t.test('big JSON is compressed for browsers; answers with tokens or keys in them, and small ones, never are', async () => {
    for (let c = 0; c < 12; c++) {
      const conv = Number((await db.query('INSERT INTO conversations(page_url,page_title) VALUES($1,$2) RETURNING id', [`https://example.com/a/${c}`, `An article about thing ${c}`])).rows[0].id);
      await db.query(`INSERT INTO messages(conversation_id,role,content,input_tokens,output_tokens) VALUES ($1,'user',$2,900,0),($1,'assistant',$3,0,300)`,
        [conv, `What does part ${c} mean, and why does it matter?`, 'Here is what the page says about it. '.repeat(40)]);
    }
    const BIG = ['/api/chats', `/api/chats/${(await api('/api/chats')).data.chats[0].id}`, '/api/pdf', '/api/admin/activity?limit=200', '/api/admin/overview', '/api/admin/usage?days=90'];
    for (const route of BIG) {
      const auth = route.startsWith('/api/admin') ? { 'x-admin-token': ADMIN } : bearer(owner);
      const plain = await raw(route, { headers: { ...auth, 'Accept-Encoding': 'identity' } });
      assert.equal(plain.status, 200, route);
      assert.equal(plain.headers['content-encoding'], undefined);
      assert.equal(plain.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(plain.headers['cache-control'], 'no-store');
      assert.equal(plain.headers.vary, 'Accept-Encoding');
      const strip = s => s.replace(/"(lastUsed|last|endsAt)":"[^"]*"/g, ''); // (nothing here changes between two asks, but be sure)
      for (const [accept, enc] of [[BROWSER, 'br'], ['gzip', 'gzip']]) {
        const r = await raw(route, { headers: { ...auth, 'Accept-Encoding': accept } });
        if (plain.body.length < 1024) { assert.equal(r.headers['content-encoding'], undefined, `${route} is small (${plain.body.length} bytes), so it goes plain`); continue; }
        assert.equal(r.headers['content-encoding'], enc, `${route} (${plain.body.length} bytes)`);
        assert.equal(strip(decoded(r).toString('utf8')), strip(plain.body.toString('utf8')), `${route} as ${enc} is the same JSON`);
        assert.equal(Number(r.headers['content-length']), r.body.length);
        assert.ok(r.body.length < plain.body.length * 0.6, `${route} as ${enc}: ${r.body.length} of ${plain.body.length} bytes`);
        assert.equal(r.headers['cache-control'], 'no-store');
      }
    }
    assert.ok((await raw('/api/chats', { headers: { ...bearer(owner), 'Accept-Encoding': 'identity' } })).body.length > 1024, 'the history list here is big enough to count');
    // left alone whatever their size: sessions and bans carry ids and keys next to text other people wrote, and boot carries a ban's key
    await db.query(`INSERT INTO slash_commands(user_id,name,prompt) SELECT NULL, 'long' || g, repeat('Explain this page in plain words. ', 20) FROM generate_series(1, 8) g`);
    for (const [route, auth] of [['/api/boot', bearer(owner)], ['/api/boot', bearer(tokens.alice)], ['/api/admin/users', { 'x-admin-token': ADMIN }], ['/api/admin/sessions', { 'x-admin-token': ADMIN }], ['/api/admin/stats', { 'x-admin-token': ADMIN }]]) {
      const r = await raw(route, { headers: { ...auth, 'Accept-Encoding': BROWSER } });
      assert.equal(r.status, 200, route);
      assert.equal(r.headers['content-encoding'], undefined, `${route} is not compressed`);
      JSON.parse(r.body.toString('utf8'));
    }
    assert.ok((await raw('/api/boot', { headers: { ...bearer(owner), 'Accept-Encoding': BROWSER } })).body.length > 4096, 'boot was big here, and still went plain');
    // errors and small answers on the same routes are plain JSON as before
    const missing = await raw('/api/chats/999999', { headers: { ...bearer(owner), 'Accept-Encoding': BROWSER } });
    assert.deepEqual([missing.status, missing.headers['content-encoding'], missing.body.toString()], [404, undefined, '{"error":"That chat isn’t in your history anymore."}']);
    assert.equal((await raw('/api/chats', { headers: { 'Accept-Encoding': BROWSER } })).status, 401);
    // someone else's chat looks like one that isn't there (that none of its messages are even read is checked on the wire, in db-trips.test.js)
    const theirs = (await api('/api/chats')).data.chats[0].id;
    assert.equal((await api(`/api/chats/${theirs}`, { token: tokens.alice })).status, 404);
    assert.equal((await api(`/api/chats/${theirs}`)).data.messages.length, 2);
  });

  await t.test('the answer stream is never compressed or held back: each piece arrives while the model is still talking', async () => {
    let release;
    hold = new Promise(r => { release = r; });
    const seen = [];
    let headers = null, firstPieceWhileHeld = false;
    const timer = setTimeout(() => release(), 8000); // a buffered stream would wait forever: let it end and fail below
    const done = raw('/api/chat', { method: 'POST', body: { message: 'Tell me in two pieces.' }, headers: { ...bearer(owner), 'Accept-Encoding': BROWSER },
      onChunk: (text, res) => {
        headers = res.headers;
        for (const line of text.split('\n').filter(Boolean).slice(seen.length)) { try { seen.push(JSON.parse(line)); } catch { break; } }
        if (!firstPieceWhileHeld && seen.some(e => e.t === 'd' && e.v === 'First piece. ')) { firstPieceWhileHeld = true; clearTimeout(timer); release(); }
      } });
    const r = await done;
    clearTimeout(timer);
    assert.equal(r.status, 200);
    assert.ok(firstPieceWhileHeld, 'the first words reached the panel before the model sent the rest');
    assert.equal(headers['content-type'], 'application/x-ndjson; charset=utf-8');
    assert.equal(headers['cache-control'], 'no-store, no-transform', 'proxies are told to leave it alone');
    assert.equal(headers['x-accel-buffering'], 'no');
    assert.equal(headers['content-encoding'], undefined);
    assert.equal(headers['content-length'], undefined, 'no length: it is sent as it comes');
    assert.equal(headers['transfer-encoding'], 'chunked');
    const events = r.body.toString('utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(events[0].t, 'id');
    assert.equal(events.filter(e => e.t === 'd').map(e => e.v).join(''), 'First piece. Second piece.');
    assert.equal(events.at(-1).t, 'done');
    // and a follow-up in the same chat still sees what was said (the chat and its messages are read side by side now)
    hold = null;
    const next = await raw('/api/chat', { method: 'POST', body: { message: 'And again?', conversationId: events[0].conversationId }, headers: bearer(owner) });
    const nextEvents = next.body.toString('utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(nextEvents[0].conversationId, events[0].conversationId, 'the same chat continues');
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1', [events[0].conversationId])).rows[0].n, 4);
    // somebody else's chat id starts a new chat instead, as before
    const other = await raw('/api/chat', { method: 'POST', body: { message: 'Mine now?', conversationId: events[0].conversationId }, headers: bearer(tokens.free) });
    assert.notEqual(JSON.parse(other.body.toString('utf8').split('\n')[0]).conversationId, events[0].conversationId);
  });

  await t.test('history reads one page of chats, however many there are: the planner knows how many chats a person has', async () => {
    // the statistics are set up in the background once the server is up
    const made = () => db.query(`SELECT 1 FROM pg_statistic_ext WHERE stxname = 'conversations_person_stat' AND stxnamespace = current_schema()::regnamespace`).then(r => r.rowCount);
    for (let i = 0; i < 100 && !(await made()); i++) await sleep(50);
    assert.equal(await made(), 1, `the statistics exist (${logs})`);
    // a long history for the owner, and the ANALYZE autovacuum would run after it
    await db.query(`WITH c AS (INSERT INTO conversations(page_title,created_at,updated_at) SELECT 'Old chat ' || g, now() - g * interval '3 hours', now() - g * interval '3 hours' FROM generate_series(1, 1500) g RETURNING id)
      INSERT INTO messages(conversation_id,role,content) SELECT c.id, 'user', 'What is this page about?' FROM c`);
    await db.query('ANALYZE conversations');
    const plan = async sql => (await db.query(`EXPLAIN (FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN'][0].Plan;
    const nodes = p => [p, ...(p.Plans || []).flatMap(nodes)];
    const all = Number((await db.query('SELECT COUNT(*)::int AS n FROM conversations WHERE user_id IS NULL AND hidden_at IS NULL')).rows[0].n);
    const guess = (await plan('SELECT 1 FROM conversations c WHERE COALESCE(c.user_id, 0) = 0 AND c.hidden_at IS NULL'))['Plan Rows'];
    assert.ok(guess > all / 2 && guess < all * 2, `the planner expects about ${all} chats for the owner, not a handful (it expects ${guess})`);
    const page = nodes(await plan('SELECT c.id FROM conversations c WHERE COALESCE(c.user_id, 0) = 0 AND c.hidden_at IS NULL ORDER BY c.updated_at DESC, c.id DESC LIMIT 31'));
    assert.deepEqual(page.map(n => n['Node Type']), ['Limit', 'Index Scan'], 'the newest chats are read off the index in order: nothing is sorted');
    assert.equal(page[1]['Index Name'], 'conversations_history_idx');
    // and the list itself is right: the newest 30, then the next 30
    const first = (await api('/api/chats')).data, second = (await api('/api/chats?before=' + encodeURIComponent(first.next))).data;
    assert.equal(first.chats.length, 30);
    assert.equal(second.chats.length, 30);
    const times = [...first.chats, ...second.chats].map(c => c.updatedAt);
    assert.deepEqual(times, [...times].sort().reverse(), 'newest first, across pages');
    assert.equal(new Set([...first.chats, ...second.chats].map(c => c.id)).size, 60);
  });

  await t.test('an edited page is served at once, with its new scripts allowed, a new validator, and new compressed copies', async () => {
    const before = await until('/widget', 'br'), file = path.join(copy, 'public/widget.html');
    appendFileSync(file, '\n<script>window.__edited = true;</script>\n');
    const soon = new Date(Date.now() + 5000);
    utimesSync(file, soon, soon); // (a modified time that is surely different)
    const now = await raw('/widget', { headers: { 'Accept-Encoding': BROWSER, 'If-None-Match': before.headers.etag } });
    assert.equal(now.status, 200, 'the old validator no longer matches');
    assert.notEqual(now.headers.etag.replace(/\.(br|gz)"$/, '"'), before.headers.etag.replace(/\.(br|gz)"$/, '"'));
    const html = decoded(now).toString('utf8');
    assert.ok(html.endsWith('\n<script>window.__edited = true;</script>\n'));
    assert.ok(html.startsWith(decoded(before).toString('utf8')), 'the rest of the page is as it was');
    const allowed = /script-src ([^;]+);/.exec(now.headers['content-security-policy'])[1].split(' ');
    assert.deepEqual(allowed, [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => sha(m[1])));
    assert.ok(allowed.includes(sha('window.__edited = true;')));
    for (const enc of ['gzip', 'br']) assert.deepEqual(decoded(await until('/widget', enc)).toString('utf8'), html, `the ${enc} copy is of the new page`);
    assert.deepEqual(decoded(await raw('/chat', { headers: { 'Accept-Encoding': BROWSER } })).toString('utf8'), html, '/chat is the same file');
    const fresh = await raw('/widget', { headers: { 'Accept-Encoding': BROWSER } });
    assert.equal((await raw('/widget', { headers: { 'Accept-Encoding': BROWSER, 'If-None-Match': fresh.headers.etag } })).status, 304);
  });
});

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Bans and terminations against a real server and an isolated PostgreSQL schema. No model is called.
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const ADMIN = 'test-admin-token-' + randomBytes(8).toString('hex');
let db, adminDb, app, origin, logs = '';
const ids = {};

async function api(route, { token, admin, method = 'GET', body, device } = {}) {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(device && { 'X-Pagebot-Device': device }), ...(token && { Authorization: `Bearer ${token}` }), ...(admin && { 'x-admin-token': ADMIN }), ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const login = (username, password) => api('/api/login', { method: 'POST', body: { username, password } });
const ban = (id, body) => api(`/api/admin/users/${id}/ban`, { admin: true, method: 'POST', body });
const unban = id => api(`/api/admin/users/${id}/ban`, { admin: true, method: 'DELETE' });
const boot = token => api('/api/boot', { token });
// a signed-in device, without spending the 10 logins a minute the server allows
async function session(userId) {
  const token = randomBytes(24).toString('hex');
  await db.query('INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), userId]);
  return token;
}
const hash = pw => { const salt = randomBytes(16); return `scrypt$${salt.toString('base64')}$${scryptSync(pw, salt, 64).toString('base64')}`; };

before(async () => {
  if (!database) return;
  adminDb = new pg.Pool({ connectionString: database });
  await adminDb.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(database);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  db = new pg.Pool({ connectionString: url.href });
  const portServer = createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: url.href, PGSSL: 'false', PORT: String(port), INITIAL_PASSWORD: '', ADMIN_TOKEN: ADMIN,
      ANTHROPIC_API_KEY: 'local-fixture-only', OPENROUTER_API_KEY: '', TIMEZONE: 'UTC' },
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
  for (const name of ['alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'gina', 'hank']) {
    ids[name] = Number((await db.query("INSERT INTO users(username,password_hash,status) VALUES ($1,$2,'trusted') RETURNING id", [name, hash(name + '-pass')])).rows[0].id);
  }
});

after(async () => {
  if (app && app.exitCode == null) { app.kill(); await once(app, 'exit'); }
  await db?.end();
  if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
});

test('bans and terminations', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  await t.test('needs the admin token, a reason and a listed length', async () => {
    assert.equal((await api(`/api/admin/users/${ids.alice}/ban`, { method: 'POST', body: { kind: 'ban', hours: 24, reason: 'x' } })).status, 401);
    assert.equal((await ban(ids.alice, { kind: 'ban', hours: 24, reason: '  ' })).status, 400);
    assert.equal((await ban(ids.alice, { kind: 'ban', hours: 5, reason: 'Spam' })).status, 400);
    assert.equal((await ban(ids.alice, { kind: 'nuke', reason: 'Spam' })).status, 400);
    assert.equal((await ban(999999, { kind: 'ban', hours: 24, reason: 'Spam' })).status, 404);
    assert.equal((await unban(ids.alice)).status, 404);
  });

  await t.test('a ban keeps the session but shows the notice and blocks everything else', async () => {
    const before = (await login('alice', 'alice-pass')).data.token;
    const r = await ban(ids.alice, { kind: 'ban', hours: 72, reason: 'Spamming', note: 'Sent the same question 400 times.' });
    assert.equal(r.status, 200);
    assert.equal(r.data.ban.state, 'active');
    const b = (await boot(before)).data;
    assert.equal(b.authed, true);
    assert.equal(b.ban.state, 'active');
    assert.equal(b.ban.reason, 'Spamming');
    assert.equal(b.ban.note, 'Sent the same question 400 times.');
    assert.equal(b.ban.hours, 72);
    assert.ok(Math.abs(new Date(b.ban.endsAt) - Date.now() - 72 * 3600_000) < 60_000);
    assert.equal(b.prefs, undefined, 'a banned panel gets the notice, not the chat');
    for (const [route, method] of [['/api/ping', 'POST'], ['/api/chat', 'POST'], ['/api/site-memory', 'GET'], ['/api/prefs', 'POST']]) {
      const res = await api(route, { token: before, method, ...(method === 'POST' && { body: { message: 'hi' } }) });
      assert.equal(res.status, 403, route);
      assert.equal(res.data.banned, true, route);
    }
    const seen = (await db.query('SELECT seen_at FROM bans WHERE id=$1', [b.ban.id])).rows[0].seen_at;
    assert.ok(seen, 'showing the notice marks it seen');
  });

  await t.test('signing in again shows the same notice; a wrong password reveals nothing', async () => {
    assert.equal((await login('alice', 'wrong')).status, 401);
    const again = await login('alice', 'alice-pass');
    assert.equal(again.status, 200);
    assert.equal((await boot(again.data.token)).data.ban.reason, 'Spamming');
  });

  await t.test('re-activation needs the ban\'s key and waits until the ban ends', async () => {
    const b = (await boot(await session(ids.alice))).data.ban;
    assert.equal(b.name, 'alice');
    for (const key of ['nope', 'x'.repeat(32)]) {
      assert.equal((await api('/api/ban-notice/reactivate', { method: 'POST', body: { key, agree: true } })).status, 404);
    }
    assert.equal((await api('/api/ban-notice/reactivate', { method: 'POST', body: { key: b.key, agree: true } })).status, 409);
    assert.equal((await api('/api/ban-notice', { method: 'POST', body: { key: b.key } })).status, 404, 'there is no separate notice page');
    assert.equal((await fetch(origin + '/banned')).status, 404);
  });

  await t.test('once a ban ends, the account re-activates after agreeing to the rules', async () => {
    const token = await session(ids.alice);
    await db.query("UPDATE bans SET ends_at = now() - interval '1 minute' WHERE user_id = $1 AND lifted_at IS NULL", [ids.alice]);
    const b = (await boot(token)).data.ban;
    assert.equal(b.state, 'ended');
    assert.equal((await api('/api/site-memory', { token })).status, 403, 'still out until re-activated');
    assert.equal((await api('/api/ban-notice/reactivate', { method: 'POST', body: { key: b.key } })).status, 400);
    const ok = await api('/api/ban-notice/reactivate', { method: 'POST', body: { key: b.key, agree: true } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.ban.state, 'reactivated');
    assert.equal((await boot(token)).data.ban, undefined);
    assert.equal((await api('/api/site-memory', { token })).status, 200);
    assert.equal((await api('/api/ban-notice/reactivate', { method: 'POST', body: { key: b.key, agree: true } })).status, 409);
  });

  await t.test('unbanning lifts a permanent ban, and a new ban replaces the old one', async () => {
    const token = await session(ids.bob);
    await ban(ids.bob, { kind: 'ban', hours: 24, reason: 'First' });
    const second = await ban(ids.bob, { kind: 'ban', hours: 0, reason: 'Second' });
    assert.equal(second.data.ban.endsAt, null);
    assert.equal(second.data.ban.hours, null);
    const b = (await boot(token)).data.ban;
    assert.equal(b.reason, 'Second');
    const states = (await db.query('SELECT lifted_at IS NOT NULL AS lifted FROM bans WHERE user_id=$1 ORDER BY id', [ids.bob])).rows.map(r => r.lifted);
    assert.deepEqual(states, [true, false]);
    assert.equal((await unban(ids.bob)).status, 200);
    assert.equal((await boot(token)).data.ban, undefined);
    assert.ok((await db.query('SELECT lifted_at FROM bans WHERE id=$1', [b.id])).rows[0].lifted_at);
  });

  await t.test('a termination shows on every sign-in and deletes the account after two weeks', async () => {
    const r = await ban(ids.carol, { kind: 'terminate', reason: 'Abusing pagebot' });
    assert.equal(r.data.ban.state, 'terminated');
    assert.ok(Math.abs(new Date(r.data.ban.endsAt) - Date.now() - 14 * 86400_000) < 60_000);
    for (let i = 0; i < 2; i++) {
      const token = (await login('carol', 'carol-pass')).data.token;
      const b = (await boot(token)).data.ban;
      assert.equal(b.state, 'terminated');
      assert.equal(b.reason, 'Abusing pagebot');
      assert.equal((await api('/api/ban-notice/reactivate', { method: 'POST', body: { key: b.key, agree: true } })).status, 409);
    }
    const listed = (await api('/api/admin/users', { admin: true })).data;
    assert.equal(listed.users.find(u => u.id === ids.carol).ban.state, 'terminated');
    assert.equal(listed.terminateDays, 14);
    assert.ok(listed.bans.some(b => b.userId === ids.carol && b.kind === 'terminate'));

    await db.query("UPDATE bans SET ends_at = now() - interval '1 minute' WHERE id = $1", [r.data.ban.id]);
    assert.equal((await login('carol', 'carol-pass')).status, 401, 'the account is gone');
    assert.equal((await db.query('SELECT 1 FROM users WHERE id=$1', [ids.carol])).rowCount, 0);
    const log = (await api('/api/admin/users', { admin: true })).data.bans.find(b => b.id === r.data.ban.id);
    assert.equal(log.state, 'deleted');
    assert.equal(log.userId, null);
    assert.equal(log.name, 'carol', 'the log keeps the username');
  });

  await t.test('a termination can be reversed before the account is deleted', async () => {
    const token = await session(ids.dave);
    await ban(ids.dave, { kind: 'terminate', reason: 'Mistake' });
    assert.equal((await boot(token)).data.ban.state, 'terminated');
    assert.equal((await unban(ids.dave)).status, 200);
    assert.equal((await boot(token)).data.ban, undefined);
    await db.query("UPDATE bans SET ends_at = now() - interval '1 minute' WHERE user_id = $1", [ids.dave]);
    assert.equal((await login('dave', 'dave-pass')).status, 200, 'a reversed termination never deletes');
  });

  await t.test('an appeal goes to the owner once per ban; accepting it lifts the ban', async () => {
    const token = await session(ids.eve);
    await ban(ids.eve, { kind: 'ban', hours: 168, reason: 'Spamming' });
    let b = (await boot(token)).data.ban;
    assert.equal(b.appeal, null);
    const appeal = body => api('/api/ban-notice/appeal', { method: 'POST', body: { key: b.key, body } });
    assert.equal((await appeal('   ')).status, 400);
    assert.equal((await appeal('x'.repeat(1001))).status, 400);
    assert.equal((await api('/api/ban-notice/appeal', { method: 'POST', body: { key: 'x'.repeat(32), body: 'Hi' } })).status, 404);
    assert.equal((await appeal('It was my little brother.')).status, 200);
    assert.equal((await appeal('Again!')).status, 409, 'one appeal per ban');
    b = (await boot(token)).data.ban;
    assert.equal(b.appeal.body, 'It was my little brother.');
    assert.equal(b.appeal.decision, null);
    let waiting = (await api('/api/admin/users', { admin: true })).data.appeals;
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].ban.name, 'eve');
    assert.equal((await api(`/api/admin/appeals/${waiting[0].id}`, { admin: true, method: 'POST', body: { decision: 'deny', reply: 'Keep an eye on him.' } })).status, 200);
    assert.equal((await api(`/api/admin/appeals/${waiting[0].id}`, { admin: true, method: 'POST', body: { decision: 'accept' } })).status, 404, 'answered once');
    b = (await boot(token)).data.ban;
    assert.equal(b.state, 'active');
    assert.equal(b.appeal.decision, 'denied');
    assert.equal(b.appeal.reply, 'Keep an eye on him.');
    assert.equal((await api('/api/admin/users', { admin: true })).data.appeals.length, 0);

    await ban(ids.eve, { kind: 'terminate', reason: 'Did it again' });
    b = (await boot(token)).data.ban;
    assert.equal((await api('/api/ban-notice/appeal', { method: 'POST', body: { key: b.key, body: 'Please.' } })).status, 200, 'a new ban gets its own appeal');
    waiting = (await api('/api/admin/users', { admin: true })).data.appeals;
    assert.equal((await api(`/api/admin/appeals/${waiting[0].id}`, { admin: true, method: 'POST', body: { decision: 'accept', reply: 'Okay, last chance.' } })).status, 200);
    assert.equal((await boot(token)).data.ban, undefined);
    assert.equal((await api('/api/site-memory', { token })).status, 200);
    assert.equal((await api('/api/ban-notice/appeal', { method: 'POST', body: { key: b.key, body: 'Thanks' } })).status, 409, 'a lifted ban can’t be appealed');
  });

  await t.test('a restriction takes away what it says until it ends, then the account is back to normal', async () => {
    const token = await session(ids.frank);
    assert.equal((await ban(ids.frank, { kind: 'restrict', hours: 0, noSonnet: true, reason: 'x' })).status, 400, 'restrictions end');
    assert.equal((await ban(ids.frank, { kind: 'restrict', hours: 24, reason: 'x' })).status, 400, 'something has to be taken away');
    assert.equal((await ban(ids.frank, { kind: 'restrict', hours: 24, limitKind: 'tokens', limitValue: 'lots', reason: 'x' })).status, 400);
    const r = await ban(ids.frank, { kind: 'restrict', hours: 72, noSonnet: true, noWeb: true, limitKind: 'tokens', limitValue: 5000, reason: 'Too much Sonnet' });
    assert.equal(r.status, 200);
    let b = (await boot(token)).data;
    assert.equal(b.ban, undefined, 'a restriction isn’t a ban');
    assert.equal(b.restriction.reason, 'Too much Sonnet');
    assert.deepEqual(b.restriction.limits, { noSonnet: true, noWeb: true, lowerLimit: true }, 'the person is told the limit is lower, not by how much');
    assert.equal(b.user.allowSonnet, false);
    assert.equal(b.user.allowWeb, false);
    assert.equal(b.models.find(m => m.key === 'sonnet').locked, true);
    assert.deepEqual(b.quota, { pct: 0 });
    assert.equal((await api('/api/prefs', { token, method: 'POST', body: { model: 'sonnet', web: true } })).data.prefs.model, 'haiku');
    const listed = (await api('/api/admin/users', { admin: true })).data.users.find(u => u.id === ids.frank);
    assert.equal(listed.restriction.state, 'restricted');
    assert.deepEqual(listed.restriction.limits, { noSonnet: true, noWeb: true, limitKind: 'tokens', limitValue: 5000 }, '/admin still sees the numbers');
    assert.equal(listed.allowSonnet, true, 'their own settings are untouched');

    // a ban on top shows the ban; once lifted, the restriction is back
    await ban(ids.frank, { kind: 'ban', hours: 1, reason: 'And spam' });
    assert.equal((await boot(token)).data.ban.reason, 'And spam');
    await unban(ids.frank);
    assert.equal((await boot(token)).data.restriction.reason, 'Too much Sonnet');

    assert.equal((await api(`/api/admin/users/${ids.frank}/ban?kind=restrict`, { admin: true, method: 'DELETE' })).status, 200);
    b = (await boot(token)).data;
    assert.equal(b.restriction, null);
    assert.equal(b.user.allowSonnet, true);
    assert.equal(b.quota, null);

    await ban(ids.frank, { kind: 'restrict', hours: 1, noWeb: true, reason: 'Short one' });
    await db.query("UPDATE bans SET ends_at = now() - interval '1 second' WHERE user_id = $1 AND kind = 'restrict' AND lifted_at IS NULL", [ids.frank]);
    b = (await boot(token)).data;
    assert.equal(b.restriction, null, 'it ends by itself');
    assert.equal(b.user.allowWeb, true);
  });

  await t.test('a terminated account’s username and browser can’t sign up again', async () => {
    const signup = (username, device) => api('/api/signup', { method: 'POST', device, body: { username, password: 'new-pass-1' } });
    assert.equal((await signup('Carol', 'fresh-browser-0000001')).status, 409, 'deleted after termination, still reserved');
    const gina = 'gina-browser-000000001', other = 'other-browser-00000001';
    assert.equal((await boot(await session(ids.gina))).status, 200);
    await api('/api/boot', { token: await session(ids.gina), device: gina });
    await api('/api/boot', { token: await session(ids.hank), device: gina }); // hank uses the same browser
    assert.equal((await ban(ids.gina, { kind: 'terminate', reason: 'Threats' })).status, 200);
    assert.equal((await signup('gina2', gina)).status, 403);
    assert.match((await signup('gina3', gina)).data.error, /terminated/);
    assert.equal((await signup('ivy', other)).status, 200, 'other browsers are fine');
    const hank = (await api('/api/admin/users', { admin: true })).data.users.find(u => u.id === ids.hank);
    assert.deepEqual(hank.linked, ['gina']);
    await unban(ids.gina);
    assert.equal((await signup('gina4', gina)).status, 200, 'a reversed termination stops blocking');
  });
});

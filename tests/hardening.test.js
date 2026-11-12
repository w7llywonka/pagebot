import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Hardening: who can reach what, and how often.
//  - every API route refuses a visitor who isn't signed in (and the chat routes refuse an account that isn't accepted yet)
//  - a 5-digit passcode only works in a browser that has signed in with the full password
//  - everything is rate limited: each route, the pages, addresses that don't exist, and every request in total
//  - plain http is sent to https, and the answers carry the headers that keep them out of other sites and search engines
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const ADMIN = 'hardening-test-admin-token-' + randomBytes(6).toString('hex');
const PASSWORD_FIRST = 'Sign in with your password in this browser first. After that, your passcode unlocks it.';
const servers = [];
let adminDb, origin;

// each test talks from its own address (the server trusts one proxy in front, as on Railway), so their limits don't mix
let lastIp = 0;
const newIp = () => { lastIp++; return `10.${(lastIp >> 16) & 255}.${(lastIp >> 8) & 255}.${lastIp & 255}`; };
const browser = name => `browser-${name}-`.padEnd(24, 'x'); // the random id a panel keeps in its browser

async function call(route, { base = origin, token, admin, method = 'GET', body, ip = newIp(), device, headers = {} } = {}) {
  const r = await fetch(base + route, {
    method, redirect: 'manual',
    headers: {
      'X-Forwarded-For': ip, ...(token && { Authorization: `Bearer ${token}` }), ...(admin && { 'X-Admin-Token': admin }),
      ...(device && { 'X-Pagebot-Device': device }), ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, data: r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}
const adm = (route, opts = {}) => call(route, { admin: ADMIN, ...opts });

async function start(env = {}) {
  const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
  await adminDb.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(database);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  const portServer = createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const s = { schema, origin: `http://127.0.0.1:${port}`, logs: '' };
  s.app = spawn(process.execPath, ['--import', './tests/helpers/local-model.mjs', 'server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: url.href, PGSSL: 'false', PORT: String(port), INITIAL_PASSWORD: '', ADMIN_TOKEN: ADMIN, ANTHROPIC_API_KEY: 'local-fixture-only',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', PAGEBOT_MOCK_MODEL_ORIGIN: 'http://127.0.0.1:9', SYSTEM_PROMPT: 'You are a test helper.', TIMEZONE: 'UTC', ...env },
  });
  s.app.stdout.on('data', c => { s.logs += c; }); s.app.stderr.on('data', c => { s.logs += c; });
  servers.push(s);
  for (let i = 0; i < 100; i++) {
    if (s.app.exitCode != null) throw new Error(`Test server exited: ${s.logs}`);
    try { if ((await fetch(s.origin + '/health', { headers: { 'X-Forwarded-For': '10.250.0.1' } })).ok) return s; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server failed to start: ${s.logs}`);
}

before(async () => {
  if (!database) return;
  adminDb = new pg.Pool({ connectionString: database });
  origin = (await start()).origin;
});

after(async () => {
  for (const s of servers) {
    if (s.app.exitCode == null && s.app.signalCode == null) { s.app.kill(); await once(s.app, 'exit'); }
    await adminDb.query(`DROP SCHEMA IF EXISTS ${s.schema} CASCADE`);
  }
  await adminDb?.end();
});

test('hardening', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  const OWNER_PW = 'owner-password-1', CODE = '24680';
  const ownerPasscode = (device, code = CODE) => call('/api/login', { method: 'POST', device, body: { passcode: code } });
  const ownerPassword = (device, password = OWNER_PW) => call('/api/login', { method: 'POST', device, body: { password } });
  const refused = (r, why) => {
    assert.equal(r.status, 401, why);
    assert.deepEqual(r.data, { error: PASSWORD_FIRST, usePassword: true }, why);
  };

  // ---------- passcodes ----------
  await t.test('a passcode can only be set once there is a password to back it', async () => {
    const none = await adm('/api/admin/passcode', { method: 'POST', body: { passcode: CODE } });
    assert.equal(none.status, 400);
    assert.match(none.data.error, /Set an access password first/);
    assert.equal((await adm('/api/admin/password', { method: 'POST', body: { password: 'short-7' } })).status, 400, 'the owner password needs 8 characters');
    assert.equal((await adm('/api/admin/password', { method: 'POST', body: { password: OWNER_PW } })).status, 200);
    assert.equal((await adm('/api/admin/passcode', { method: 'POST', body: { passcode: CODE } })).data.on, true);
  });

  await t.test('the owner passcode is no use from a browser that never signed in with the password', async () => {
    refused(await ownerPasscode(browser('stranger')), 'even the right passcode');
    refused(await call('/api/login', { method: 'POST', body: { passcode: CODE } }), 'and with no browser id at all');
    // guessing from outside doesn't touch the real passcode's tries, so it can't lock the owner out of it either
    for (let i = 0; i < 12; i++) refused(await ownerPasscode(browser('guess' + i), String(10000 + i)));
    const sec = (await adm('/api/admin/security')).data;
    assert.equal(sec.passcode.fails, 0);
    assert.equal(sec.passcode.locked, false);
    // and such a browser isn't shown the number pad
    assert.equal((await call('/api/boot', { device: browser('stranger') })).data.lock, 'password');
  });

  await t.test('after the password, that browser (and only that one) unlocks with the passcode', async () => {
    assert.equal((await ownerPassword(browser('laptop'), 'wrong-password')).status, 401);
    refused(await ownerPasscode(browser('laptop')), 'a wrong password proves nothing');
    const signedIn = await ownerPassword(browser('laptop'));
    assert.equal(signedIn.status, 200);
    assert.equal((await call('/api/boot', { device: browser('laptop') })).data.lock, 'passcode');
    assert.equal((await call('/api/boot', { device: browser('other') })).data.lock, 'password');
    const unlocked = await ownerPasscode(browser('laptop'));
    assert.equal(unlocked.status, 200);
    assert.equal((await call('/api/boot', { token: unlocked.data.token, device: browser('laptop') })).data.who, 'owner');
    refused(await ownerPasscode(browser('other')));
    // in the trusted browser a wrong passcode is a real wrong try, counted like before
    const wrong = await ownerPasscode(browser('laptop'), '11111');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.data.error, 'Wrong passcode');
    assert.equal((await adm('/api/admin/security')).data.passcode.fails, 1);
  });

  await t.test('locking keeps the passcode; Log out makes the browser forget it', async () => {
    const s = await ownerPasscode(browser('laptop'));
    assert.equal((await call('/api/logout', { method: 'POST', token: s.data.token, device: browser('laptop'), body: { forget: false } })).status, 200);
    const again = await ownerPasscode(browser('laptop'));
    assert.equal(again.status, 200, 'a lock is undone with the passcode');
    assert.equal((await call('/api/logout', { method: 'POST', token: again.data.token, device: browser('laptop'), body: { forget: true } })).status, 200);
    refused(await ownerPasscode(browser('laptop')), 'logged out: the password comes first again');
    assert.equal((await call('/api/boot', { device: browser('laptop') })).data.lock, 'password');
  });

  await t.test('signing out everywhere, signing one device out, and a new owner password each take the passcode away', async () => {
    const trust = async (pw = OWNER_PW) => { assert.equal((await ownerPassword(browser('laptop'), pw)).status, 200); assert.equal((await ownerPasscode(browser('laptop'))).status, 200); };
    await trust();
    assert.equal((await adm('/api/admin/signout-all', { method: 'POST' })).status, 200);
    refused(await ownerPasscode(browser('laptop')), 'after "sign out everywhere"');

    await trust();
    await adm('/api/admin/signout-all', { method: 'POST' });
    await ownerPassword(browser('laptop'));
    const devices = (await adm('/api/admin/sessions')).data.sessions;
    assert.equal(devices.length, 1);
    assert.equal((await adm('/api/admin/sessions/' + devices[0].id, { method: 'DELETE' })).status, 200);
    refused(await ownerPasscode(browser('laptop')), 'after signing that device out');

    await trust();
    assert.equal((await adm('/api/admin/password', { method: 'POST', body: { password: 'owner-password-2' } })).status, 200);
    refused(await ownerPasscode(browser('laptop')), 'after the password changed');
    await trust('owner-password-2');
  });

  let aliceId, aliceToken;
  await t.test('an account’s passcode works the same way, and never says whether an account exists', async () => {
    const signup = await call('/api/signup', { method: 'POST', device: browser('alice-phone'), body: { username: 'alice', password: 'alice-password-1' } });
    assert.equal(signup.status, 200);
    aliceToken = signup.data.token;
    aliceId = (await adm('/api/admin/users')).data.users.find(u => u.name === 'alice').id;
    assert.equal((await adm('/api/admin/users/' + aliceId, { method: 'POST', body: { status: 'trusted' } })).status, 200);
    const set = await call('/api/account/passcode', { method: 'POST', token: aliceToken, device: browser('alice-phone'), body: { passcode: '13579', current: 'alice-password-1' } });
    assert.equal(set.status, 200, JSON.stringify(set.data));
    const pass = (device, username = 'alice', passcode = '13579') => call('/api/login', { method: 'POST', device, body: { username, passcode } });

    assert.equal((await pass(browser('alice-phone'))).status, 200, 'where she signed up and set it');
    refused(await pass(browser('thief')), 'her username and the right passcode, from somewhere else');
    refused(await pass(browser('thief'), 'nobody-here'), 'an account that does not exist answers the same');
    refused(await pass(browser('thief'), 'alice', '00000'));
    assert.equal((await adm('/api/admin/users')).data.users.find(u => u.name === 'alice').passcodeFails ?? 0, 0, 'none of that used up her tries');

    // her other browser: the password once, then the passcode
    assert.equal((await call('/api/login', { method: 'POST', device: browser('alice-laptop'), body: { username: 'alice', password: 'alice-password-1' } })).status, 200);
    assert.equal((await pass(browser('alice-laptop'))).status, 200);

    // being signed out everywhere by the owner means the password again, everywhere
    assert.equal((await adm('/api/admin/users/' + aliceId, { method: 'POST', body: { signout: true } })).status, 200);
    refused(await pass(browser('alice-phone')));
    refused(await pass(browser('alice-laptop')));
  });

  await t.test('changing the password keeps the passcode to the browser that changed it', async () => {
    const phone = await call('/api/login', { method: 'POST', device: browser('alice-phone'), body: { username: 'alice', password: 'alice-password-1' } });
    await call('/api/login', { method: 'POST', device: browser('alice-laptop'), body: { username: 'alice', password: 'alice-password-1' } });
    const changed = await call('/api/account/password', { method: 'POST', token: phone.data.token, device: browser('alice-phone'), body: { current: 'alice-password-1', password: 'alice-password-2' } });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    await call('/api/account/passcode', { method: 'POST', token: phone.data.token, device: browser('alice-phone'), body: { passcode: '13579', current: 'alice-password-2' } });
    const pass = device => call('/api/login', { method: 'POST', device, body: { username: 'alice', passcode: '13579' } });
    assert.equal((await pass(browser('alice-phone'))).status, 200);
    refused(await pass(browser('alice-laptop')), 'the other browser has not seen the new password');
    aliceToken = (await pass(browser('alice-phone'))).data.token;
  });

  await t.test('new passwords need 8 characters and can’t be the username', async () => {
    const signup = body => call('/api/signup', { method: 'POST', body });
    const short = await signup({ username: 'bob', password: 'seven77' });
    assert.equal(short.status, 400);
    assert.match(short.data.error, /at least 8 characters/);
    const same = await signup({ username: 'Roberta1', password: 'roberta1' });
    assert.equal(same.status, 400);
    assert.match(same.data.error, /isn’t your username/);
    const change = await call('/api/account/password', { method: 'POST', token: aliceToken, body: { current: 'alice-password-2', password: 'seven77' } });
    assert.equal(change.status, 400);
    assert.equal((await adm('/api/admin/users/' + aliceId, { method: 'POST', body: { password: 'seven77' } })).status, 400);
  });

  // ---------- who can reach what ----------
  const routes = [...source.matchAll(/^app\.(get|post|put|delete)\('(\/api\/[^']+)',(.*)$/gm)].map(m => ({ method: m[1].toUpperCase(), path: m[2].replace(/:\w+/g, '1'), line: m[3] }));
  const OPEN = new Set(['GET /api/boot', 'POST /api/signup', 'POST /api/login', 'POST /api/logout', 'POST /api/ban-notice/reactivate', 'POST /api/ban-notice/appeal']);
  const isOpen = r => OPEN.has(`${r.method} ${r.path}`);
  const send = (r, opts = {}) => call(r.path, { method: r.method, ...(r.method !== 'GET' && { body: {} }), ...opts });

  await t.test('every API route but the six needed to sign in refuses a visitor who isn’t signed in', async () => {
    assert.ok(routes.length >= 50, `found ${routes.length} routes`);
    assert.equal(routes.filter(isOpen).length, OPEN.size, 'the open routes are exactly the ones listed here');
    for (const r of routes.filter(r => !isOpen(r))) {
      const name = `${r.method} ${r.path}`;
      const nothing = await send(r), badToken = await send(r, { token: 'not-a-real-session-token' }), badAdmin = await send(r, { admin: 'not-the-admin-token-not-the-admin-token' });
      for (const x of [nothing, badToken, badAdmin]) {
        assert.equal(x.status, 401, name);
        assert.deepEqual(Object.keys(x.data), x.data.locked === undefined ? ['error'] : ['error', 'locked'], `${name} says only that it’s refused`);
      }
    }
  });

  await t.test('the admin routes take the admin token and nothing else', async () => {
    const adminRoutes = routes.filter(r => r.path.startsWith('/api/admin/'));
    assert.ok(adminRoutes.length >= 20);
    for (const r of adminRoutes) {
      assert.match(r.line, /\badmin,/, `${r.method} ${r.path} is behind the admin check`);
      assert.equal((await send(r, { token: aliceToken })).status, 401, `${r.method} ${r.path} with an accepted account’s session`);
    }
    const ownerSession = (await ownerPassword(browser('laptop'), 'owner-password-2')).data.token;
    assert.equal((await call('/api/admin/stats', { token: ownerSession })).status, 401, 'not even the owner’s panel session');
  });

  await t.test('an account that isn’t accepted yet can’t use anything that asks, reads or stores', async () => {
    const waiting = (await call('/api/signup', { method: 'POST', body: { username: 'waiting', password: 'waiting-password-1' } })).data.token;
    const gated = routes.filter(r => /\btrusted,/.test(r.line));
    assert.ok(gated.length >= 15, `found ${gated.length}`);
    for (const r of gated) {
      const x = await send(r, { token: waiting });
      assert.equal(x.status, 403, `${r.method} ${r.path}`);
      assert.equal(x.data.status, 'pending');
    }
    // everything behind a session that isn't an admin route, apart from the handful a waiting person needs, is one of those
    const allowed = new Set(['POST /api/ping', 'POST /api/prefs', 'POST /api/account/password', 'POST /api/announcements/seen']);
    for (const r of routes.filter(r => !isOpen(r) && !r.path.startsWith('/api/admin/') && !/\btrusted,/.test(r.line)))
      assert.ok(allowed.has(`${r.method} ${r.path}`), `${r.method} ${r.path} is open to accounts that aren’t accepted`);
  });

  await t.test('before signing in, the panel is told how to unlock and nothing else', async () => {
    const boot = (await call('/api/boot')).data;
    assert.deepEqual(Object.keys(boot).sort(), ['accounts', 'authed', 'lock', 'passwordSet', 'theme', 'version']);
    assert.equal(boot.authed, false);
    const health = await call('/health');
    assert.deepEqual(health.data, { ok: true, version: 13 }, 'the health check says it’s up, not what runs here');
  });

  // ---------- headers, https ----------
  await t.test('answers stay out of other sites’ pages, out of frames, and out of search engines', async () => {
    for (const r of [await call('/api/boot'), await call('/api/chats'), await call('/api/nothing-here')]) {
      assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    }
    for (const path of ['/', '/chat', '/admin', '/widget', '/api/boot', '/health', '/robots.txt', '/nothing-here']) {
      const r = await call(path);
      assert.match(r.headers.get('x-robots-tag'), /noindex/, path);
      assert.match(r.headers.get('permissions-policy'), /camera=\(\)/, path);
      assert.equal(r.headers.get('x-powered-by'), null, path);
    }
    for (const path of ['/', '/chat', '/admin']) {
      const r = await call(path);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
      assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/, path);
    }
    const widget = await call('/widget'); // the panel is the one thing that has to load inside other sites
    assert.equal(widget.headers.get('x-frame-options'), null);
    assert.match(widget.headers.get('content-security-policy'), /frame-ancestors \*/);
    assert.equal((await call('/robots.txt')).text, 'User-agent: *\nDisallow: /\n');
  });

  await t.test('plain http is sent to https, and nothing but opening a page is answered over it', async () => {
    const http = { 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'pagebot.example' };
    const page = await call('/chat?x=1', { headers: http });
    assert.equal(page.status, 308);
    assert.equal(page.headers.get('location'), 'https://pagebot.example/chat?x=1');
    const login = await call('/api/login', { method: 'POST', headers: http, body: { password: 'owner-password-2' } });
    assert.equal(login.status, 403);
    assert.deepEqual(login.data, { error: 'Use https.' });
    assert.equal((await call('/health', { headers: http })).status, 200, 'the platform’s health check is answered as it comes');
    const secure = await call('/chat', { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'pagebot.example' } });
    assert.equal(secure.status, 200);
    assert.match(secure.headers.get('strict-transport-security'), /max-age=\d{7,}/);
  });

  await t.test('an address that isn’t there says so, briefly', async () => {
    const api = await call('/api/admin/nope');
    assert.equal(api.status, 404);
    assert.deepEqual(api.data, { error: 'Not found' });
    for (const path of ['/.env', '/wp-login.php', '/server.js', '/public/admin.html', '/package.json', '/.git/config']) {
      const r = await call(path);
      assert.equal(r.status, 404, path);
      assert.equal(r.text, 'Not found', path);
    }
    assert.equal((await call('/api/login')).status, 404, 'the wrong method is not there either');
    assert.equal((await call('/API/boot')).status, 404, 'nor the same address in capitals, which would skip the checks made by address');
    assert.equal((await call('/Admin')).status, 404);
  });

  // ---------- rate limits ----------
  const burst = async (n, route, opts) => (await Promise.all(Array.from({ length: n }, () => call(route, opts)))).map(r => r.status);
  const count = (list, status) => list.filter(s => s === status).length;

  await t.test('the pages are rate limited, and a "slow down" says for how long', async () => {
    const ip = newIp();
    const got = [...await burst(60, '/', { ip }), ...await burst(60, '/admin', { ip })];
    assert.equal(count(got, 200), 120);
    for (const path of ['/', '/chat', '/widget', '/admin', '/robots.txt']) {
      const r = await call(path, { ip });
      assert.equal(r.status, 429, path);
      const wait = Number(r.headers.get('retry-after'));
      assert.ok(wait >= 1 && wait <= 60, `Retry-After: ${r.headers.get('retry-after')}`);
    }
    assert.equal((await call('/')).status, 200, 'someone else is not affected');
  });

  await t.test('so are addresses that don’t exist, and the health check', async () => {
    const ip = newIp();
    assert.equal(count(await burst(60, '/api/guess', { ip }), 404), 60);
    assert.equal((await call('/wp-admin', { ip })).status, 429);
    assert.equal((await call('/api/guess', { ip })).status, 429);
    const other = newIp();
    assert.equal(count(await burst(120, '/health', { ip: other }), 200), 120);
    assert.equal((await call('/health', { ip: other })).status, 429);
  });

  await t.test('every API route has its own limit', async () => {
    for (const r of routes) assert.match(r.line, /^\s*limit\(\d+, '[a-z-]+'/, `${r.method} ${r.path} starts with a rate limit`);
    const ip = newIp();
    const tries = [];
    for (let i = 0; i < 11; i++) tries.push((await call('/api/login', { method: 'POST', ip, body: { password: 'guess-' + i } })).status);
    assert.deepEqual(tries, [...Array(10).fill(401), 429], '10 sign-in tries a minute');
  });

  await t.test('one IPv6 connection counts as one address, however many addresses it uses', async () => {
    const got = [];
    for (let i = 0; i < 120; i++) got.push((await call('/health', { ip: `2001:db8:aa:bb:${(i + 1).toString(16)}:1:2:${i.toString(16)}` })).status);
    assert.equal(count(got, 200), 120);
    assert.equal((await call('/health', { ip: '2001:db8:aa:bb:ffff:ffff:ffff:ffff' })).status, 429, 'another address on the same line');
    assert.equal((await call('/health', { ip: '2001:DB8:AA:BB::7' })).status, 429, 'written another way');
    assert.equal((await call('/health', { ip: '2001:db8:aa:cc::1' })).status, 200, 'a different line');
    // and ::ffff:1.2.3.4 is the same address as 1.2.3.4
    const v4 = newIp();
    assert.equal(count(await burst(120, '/health', { ip: v4 }), 200), 120);
    assert.equal((await call('/health', { ip: '::ffff:' + v4 })).status, 429);
  });

  await t.test('all of an address’s requests together are limited too, before their bodies are read', async () => {
    const small = await start({ REQUESTS_PER_MIN: '300', INITIAL_PASSWORD: 'small-server-pass' });
    const ip = newIp(), at = { base: small.origin, ip };
    // 300 requests spread so that no single route's limit is reached
    const got = [...await burst(110, '/health', at), ...await burst(110, '/', at), ...await burst(50, '/api/boot', at), ...await burst(30, '/api/chats', at)];
    assert.equal(count(got, 429), 0, 'nothing was limited yet');
    const over = await call('/api/logout', { ...at, method: 'POST', body: {} }); // a route this address hasn't used
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers.get('retry-after')) >= 1);
    // a body that would be refused as too big (or as not JSON) isn't even looked at
    const big = await fetch(small.origin + '/api/login', { method: 'POST', headers: { 'X-Forwarded-For': ip, 'Content-Type': 'application/json' }, body: '{"password":"' + 'x'.repeat(200_000) + '"}' });
    assert.equal(big.status, 429);
    assert.equal((await call('/api/boot', { base: small.origin })).status, 200, 'someone else is not affected');
  });

  await t.test('the counters have a ceiling: a flood of addresses can’t fill the memory, and the owner still gets in', async () => {
    const tiny = await start({ MAX_RATE_KEYS: '40', INITIAL_PASSWORD: 'tiny-server-pass' });
    const known = newIp(), at = ip => ({ base: tiny.origin, ip });
    assert.equal((await call('/api/boot', at(known))).status, 200);
    let turnedAway = 0;
    for (let i = 0; i < 60; i++) if ((await call('/api/boot', at(newIp()))).status === 429) turnedAway++;
    assert.ok(turnedAway >= 30, `${turnedAway} new addresses were turned away once the counters were full`);
    assert.equal((await call('/api/boot', at(known))).status, 200, 'an address already being counted carries on');
    // but nothing new gets through uncounted: a route that address hasn't used would need a counter of its own
    const tries = [];
    for (let i = 0; i < 12; i++) tries.push((await call('/api/login', { ...at(known), method: 'POST', body: { password: 'guess-' + i } })).status);
    assert.deepEqual(tries, Array(12).fill(429));
    // the owner, with the admin token, still gets in to look (from an address the server has never seen, too)
    assert.equal((await adm('/api/admin/security', at(known))).status, 200);
    assert.equal((await adm('/api/admin/security', at(newIp()))).status, 200);
    assert.equal((await call('/api/admin/security', { ...at(newIp()), admin: 'not-the-admin-token-not-the-admin-token' })).status, 429, 'a wrong token gets no such pass');
  });
});

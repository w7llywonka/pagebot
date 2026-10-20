import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// The redesign on the server's side: the four new themes are accepted and saved (for the owner and for accounts), anything else is
// not, the bookmark carries the half-window default, and the version is 12.
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const ADMIN = 'redesign-test-admin-token-' + randomBytes(6).toString('hex');
let db, adminDb, dbUrl, origin, app, owner, alice, logs = '';

async function api(route, { token = owner, method = 'GET', body } = {}) {
  const r = await fetch(origin + route, { method, headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) });
  const text = await r.text();
  return { status: r.status, data: r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
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
  dbUrl = url.href;
  db = new pg.Pool({ connectionString: dbUrl });
  const portServer = createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  app = spawn(process.execPath, ['--import', './tests/helpers/local-model.mjs', 'server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: 'false', PORT: String(port), INITIAL_PASSWORD: '', ADMIN_TOKEN: ADMIN, ANTHROPIC_API_KEY: 'local-fixture-only',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', PAGEBOT_MOCK_MODEL_ORIGIN: 'http://127.0.0.1:9', SYSTEM_PROMPT: 'You are a test helper.', TIMEZONE: 'UTC' },
  });
  app.stdout.on('data', c => { logs += c; }); app.stderr.on('data', c => { logs += c; });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (app.exitCode != null) throw new Error(`Test server exited: ${logs}`);
    try { if ((await fetch(origin + '/health')).ok) break; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const users = await db.query("INSERT INTO users(username,password_hash,status) VALUES ('alice','fixture-unused','trusted') RETURNING id");
  [owner, alice] = await Promise.all([session(), session(Number(users.rows[0].id))]);
});

after(async () => {
  if (app && app.exitCode == null && app.signalCode == null) { app.kill(); await once(app, 'exit'); }
  await db?.end();
  if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
});

test('redesign integration', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  await t.test('the version is 12 and the homepage bookmark works out the half-window default', async () => {
    assert.equal((await api('/health')).data.version, 12);
    const html = (await api('/', { token: null })).data;
    const href = /id="bm" href="([^"]+)"/.exec(html)[1].replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&quot;', '"');
    const code = decodeURIComponent(href.slice('javascript:'.length));
    assert.match(code, /v:12\}/);
    assert.match(code, /P\.def=function\(\)\{/);
    assert.match(code, /Math\.round\(vw\*\.5\),360\),vw-32/);
    assert.match(code, /Math\.round\(vh\*\.8\),420\),vh-32/);
    assert.match(code, /Math\.round\(vw\*\.4\),420\),vw-40/);
    assert.match(html, /fourteen themes/);
  });

  await t.test('the owner can pick each new theme; it is saved and comes back on the next boot', async () => {
    for (const theme of ['pond', 'orbit', 'void', 'arcade']) {
      const saved = await api('/api/prefs', { method: 'POST', body: { theme } });
      assert.equal(saved.status, 200);
      assert.equal(saved.data.prefs.theme, theme);
      assert.equal((await api('/api/boot')).data.theme, theme);
    }
  });

  await t.test('an account picks them too, and its choice is its own', async () => {
    assert.equal((await api('/api/prefs', { token: alice, method: 'POST', body: { theme: 'void' } })).data.prefs.theme, 'void');
    assert.equal((await api('/api/boot', { token: alice })).data.theme, 'void');
    assert.equal((await api('/api/boot')).data.theme, 'arcade', 'the owner kept their own');
  });

  await t.test('a theme that does not exist is ignored, and the old ones still work', async () => {
    assert.equal((await api('/api/prefs', { method: 'POST', body: { theme: 'neon-cave' } })).data.prefs.theme, 'arcade');
    assert.equal((await api('/api/prefs', { method: 'POST', body: { theme: 'sakura' } })).data.prefs.theme, 'sakura');
    for (const theme of ['glass', 'clear', 'auto']) assert.equal((await api('/api/prefs', { method: 'POST', body: { theme } })).data.prefs.theme, theme);
  });
});

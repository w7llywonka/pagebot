#!/usr/bin/env node
// Measures what the server puts on the wire and how long it takes, against a real server and a real Postgres.
// It starts server.js the way the integration tests do (a throwaway schema, a local stand-in for the model), seeds a
// realistic history, and prints bytes per page and encoding, response times, and the time from start to a healthy /health.
//
//   PAGEBOT_TEST_DATABASE_URL=postgres://pagebot:pagebot@127.0.0.1:5432/pagebot_test node scripts/measure-server.mjs
//
// Options:
//   --compare <dir>    also measure another checkout of the app (say, the commit before a change) at the same time:
//                      requests alternate between the two in small batches, so a busy machine slows both alike
//   --db-delay <ms>    put a proxy in front of Postgres that adds this much to every round trip (fractions are fine).
//                      The app's database is never on localhost in production: this shows what a saved round trip is worth.
//   --rounds <n>       batches per timing (default 20, of 12 requests each)
//   --starts <n>       how many times each server is stopped and started again to time its start (default 9)
//   --idle <seconds>   also time the first /api/boot after the server sat idle that long, three times: the usual case
//                      for a panel opened now and then (connections that were closed meanwhile have to be opened again)
//   --json <file>      also write the numbers as JSON
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import pg from 'pg';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i < 0 ? fallback : args[i + 1]; };
const here = fileURLToPath(new URL('../', import.meta.url));
const roots = [...(opt('compare') ? [path.resolve(opt('compare'))] : []), here]; // the other checkout first: it is "before"
const dbDelay = Number(opt('db-delay', 0)), rounds = Number(opt('rounds', 20)), idleSeconds = Number(opt('idle', 0)), restarts = Number(opt('starts', 9)), BATCH = 12;
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
if (!database) { console.error('Set PAGEBOT_TEST_DATABASE_URL (a Postgres database this may create a schema in).'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const { port } = s.address(); await new Promise(r => s.close(r)); return port; };
const adminDb = new pg.Pool({ connectionString: database });

// ---- a model that answers 25 ms after it is asked, so the first line of an answer's stream (which the server sends
// before it calls the model) is clearly apart from the answer itself
const model = http.createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  await sleep(25);
  const ev = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  ev({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-5-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A short answer.' } });
  ev({ type: 'content_block_stop', index: 0 });
  ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  ev({ type: 'message_stop' });
  res.end();
}).listen(0, '127.0.0.1');
await once(model, 'listening');
const modelOrigin = `http://127.0.0.1:${model.address().port}`;

// ---- a Postgres proxy that makes every round trip take `dbDelay` ms longer (half on the way in, half on the way out).
// Timers only fire on whole milliseconds, so what is due is looked at on every turn of the event loop instead.
const due = []; let spinning = false;
function spin() {
  const now = performance.now();
  while (due.length && due[0].at <= now) { const d = due.shift(); if (!d.to.destroyed) d.to.write(d.chunk); }
  if (due.length) setImmediate(spin); else spinning = false;
}
async function delayProxy(target) {
  const later = (to, chunk) => { due.push({ at: performance.now() + dbDelay / 2, to, chunk }); if (!spinning) { spinning = true; setImmediate(spin); } };
  const server = net.createServer(a => {
    const b = net.connect(Number(target.port || 5432), target.hostname);
    a.setNoDelay(true); b.setNoDelay(true);
    a.on('data', c => later(b, c)); b.on('data', c => later(a, c));
    const end = () => setTimeout(() => { a.destroy(); b.destroy(); }, dbDelay + 5);
    a.on('close', end); b.on('close', end); a.on('error', () => {}); b.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

// ---- one request, counted the way the network sees it: the header block and the body as sent (never decoded).
// /api/boot allows 60 a minute from one address; the server trusts one proxy hop, so each request comes from "another address".
let hop = 0;
const from = () => ({ 'X-Forwarded-For': `10.${(hop >> 16) & 255}.${(hop >> 8) & 255}.${hop++ & 255}` });
const bearer = t => ({ Authorization: `Bearer ${t}` });
const BROWSER = { 'Accept-Encoding': 'gzip, deflate, br, zstd' };
function ask(s, route, headers = {}, { method = 'GET', body, firstByte = false } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = http.request(s.origin + route, { method, agent: s.agent, headers: { ...from(), ...headers, ...(body && { 'Content-Type': 'application/json' }) } }, res => {
      const chunks = []; let first = null;
      res.on('data', c => { first ??= process.hrtime.bigint(); chunks.push(c); });
      res.on('end', () => {
        const t1 = firstByte && res.statusCode === 200 ? first : process.hrtime.bigint(), body = Buffer.concat(chunks);
        let head = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
        for (let i = 0; i < res.rawHeaders.length; i += 2) head += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
        resolve({ status: res.statusCode, headers: res.headers, body, wire: Buffer.byteLength(head) + 2 + body.length, ms: Number(t1 - t0) / 1e6 });
      });
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
const decode = r => r.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.body) : r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body;
const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];

// ---- a server: its own schema, started the way the tests start it
async function start(root) {
  const s = { root, schema: `pagebot_measure_${randomBytes(6).toString('hex')}`, agent: new http.Agent({ keepAlive: true, maxSockets: 1 }) };
  await adminDb.query(`CREATE SCHEMA ${s.schema}`);
  const url = new URL(database);
  url.searchParams.set('options', `-csearch_path=${s.schema}`);
  s.db = new pg.Pool({ connectionString: url.href });
  const serverUrl = new URL(url.href);
  if (dbDelay > 0) { s.proxy = await delayProxy(url); serverUrl.hostname = '127.0.0.1'; serverUrl.port = String(s.proxy.address().port); }
  const port = await freePort();
  s.origin = `http://127.0.0.1:${port}`;
  s.env = { ...process.env, DATABASE_URL: serverUrl.href, PGSSL: 'false', PORT: String(port), INITIAL_PASSWORD: '', ADMIN_TOKEN: 'measure-admin-token-' + randomBytes(6).toString('hex'), ANTHROPIC_API_KEY: 'local-fixture-only',
    ANTHROPIC_BASE_URL: modelOrigin, PAGEBOT_MOCK_MODEL_ORIGIN: modelOrigin, SYSTEM_PROMPT: 'You are a test helper.', TIMEZONE: 'UTC' };
  s.boot = async () => {
    const t0 = process.hrtime.bigint();
    s.app = spawn(process.execPath, ['--import', './tests/helpers/local-model.mjs', 'server.js'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: s.env });
    let err = ''; s.app.stderr.on('data', c => { err += c; });
    for (;;) {
      if (s.app.exitCode != null) throw new Error(`The server in ${root} exited: ${err}`);
      try { if ((await fetch(s.origin + '/health')).ok) break; } catch { /* starting */ }
      await sleep(3);
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  s.stop = async () => { if (s.app && s.app.exitCode == null && s.app.signalCode == null) { s.app.kill(); await once(s.app, 'exit'); } };
  s.firstStart = await s.boot(); // this one creates the tables
  return s;
}
// people and things to work with: the owner and an account, each with commands and 1,500 chats of four messages; an
// announcement; and the statistics autovacuum would have gathered by the time a history is that long
async function seed(s) {
  const session = async userId => { const token = randomBytes(24).toString('hex'); await s.db.query('INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), userId]); return token; };
  const uid = Number((await s.db.query("INSERT INTO users(username,password_hash,status,limit_kind,limit_value) VALUES ('alice','fixture-unused','trusted','tokens',100000000) RETURNING id")).rows[0].id);
  [s.owner, s.alice] = [await session(null), await session(uid)];
  await s.db.query(`INSERT INTO slash_commands(user_id,name,prompt,starter) SELECT u, 'cmd' || g, repeat('Explain this page as if I were new to the subject. ', 3), g < 3 FROM generate_series(1, 6) g, (VALUES (NULL::bigint), (${uid})) x(u)`);
  await s.db.query("INSERT INTO announcements(body) VALUES ('Welcome. Sonnet is on for everyone this week.')");
  await s.db.query(`WITH c AS (INSERT INTO conversations(page_url,page_title,user_id,created_at,updated_at)
      SELECT 'https://example.com/a/' || g, 'An article about thing ' || g, CASE WHEN g % 2 = 1 THEN ${uid} END, now() - g * interval '3 hours', now() - g * interval '3 hours' FROM generate_series(1, 3000) g RETURNING id, user_id, created_at)
    INSERT INTO messages(conversation_id,role,content,input_tokens,output_tokens,user_id,model,cost_usd,created_at)
      SELECT c.id, r.role, r.content || md5(c.id::text || r.content) || repeat(r.more, r.n), 900, 300, c.user_id, 'claude-haiku-5-5', 0.0003, c.created_at - interval '2 days'
      FROM c, (VALUES ('user', 'What does this part mean, and why does it matter? ', '', 0), ('assistant', 'Here is what the page says about it: ', 'it explains the idea in plain words, with an example. ', 12),
        ('user', 'And the next part? ', '', 0), ('assistant', 'It goes on like this: ', 'more of the same, a little differently. ', 12)) r(role, content, more, n)`);
  await s.db.query('ANALYZE conversations; ANALYZE messages; ANALYZE users; ANALYZE sessions; ANALYZE slash_commands');
  const chats = async token => JSON.parse((await ask(s, '/api/chats', { ...bearer(token), 'Accept-Encoding': 'identity' })).body).chats;
  [s.ownerChat, s.aliceChat] = [(await chats(s.owner))[0].id, (await chats(s.alice))[0].id];
}

const servers = [], out = { node: process.version, at: new Date().toISOString(), dbDelayMs: dbDelay, rounds, batch: BATCH, servers: [] };
try {
  for (const root of roots) servers.push(await start(root));

  // ---- start to healthy: each server stopped and started again a few times, taking turns
  const starts = servers.map(() => []);
  for (let i = 0; i < restarts; i++) for (const [k, s] of servers.entries()) { await s.stop(); starts[k].push(await s.boot()); }
  for (const s of servers) await seed(s);

  // ---- bytes on the wire, per page and per encoding (pages are compressed in the background after the server
  // starts: give that a few seconds; a server that never compresses just uses them up)
  for (const [k, s] of servers.entries()) {
    for (let i = 0; i < 80; i++) {
      const [w, a] = [await ask(s, '/widget', { 'Accept-Encoding': 'br' }), await ask(s, '/admin', { 'Accept-Encoding': 'br' })];
      if (w.headers['content-encoding'] === 'br' && a.headers['content-encoding'] === 'br') break;
      await sleep(50);
    }
    const bytes = {};
    const routes = { '/widget': {}, '/chat': {}, '/admin': {}, '/': {}, '/api/chats (30 chats)': bearer(s.owner), [`/api/chats/${s.ownerChat} (a chat)`]: bearer(s.owner), '/api/boot (owner)': bearer(s.owner), '/api/boot (account)': bearer(s.alice) };
    for (const [label, auth] of Object.entries(routes)) {
      const route = label.split(' ')[0], plain = await ask(s, route, { ...auth, 'Accept-Encoding': 'identity' });
      if (route === '/') await sleep(300); // the homepage's copies are made once it has been asked for
      const row = bytes[label.replace(/\/\d+ /, '/:id ')] = {};
      for (const [name, accept] of [['identity', 'identity'], ['gzip', 'gzip'], ['br', 'br']]) {
        const r = await ask(s, route, { ...auth, 'Accept-Encoding': accept });
        if (!route.startsWith('/api/') && !decode(r).equals(plain.body)) throw new Error(`${route} (${name}) does not decode to the page`);
        row[name] = { wire: r.wire, body: r.body.length, encoding: r.headers['content-encoding'] || 'identity' };
      }
      if (plain.headers.etag) {
        const got = await ask(s, route, { ...auth, ...BROWSER }), again = await ask(s, route, { ...auth, ...BROWSER, 'If-None-Match': got.headers.etag });
        row.revalidated = { status: again.status, wire: again.wire };
      }
      row.cache = plain.headers['cache-control'];
    }
    s.etag = (await ask(s, '/widget', BROWSER)).headers.etag;
    out.servers[k] = { root: s.root, startupMs: { first: Math.round(s.firstStart), restarts: starts[k].map(Math.round), median: Math.round(median(starts[k])) }, bytes, ms: {} };
  }

  // ---- response times: one request after another on one connection, in batches that alternate between the servers
  const device = { 'X-Pagebot-Device': randomBytes(16).toString('hex') };
  const question = { message: 'What is this?', page: { url: 'https://example.com/new', title: 'New', text: 'Some page text.' } };
  const timings = {
    '/widget 200 (brotli)': s => ask(s, '/widget', BROWSER),
    '/widget 200 (identity)': s => ask(s, '/widget', { 'Accept-Encoding': 'identity' }),
    '/widget 304': s => ask(s, '/widget', { ...BROWSER, 'If-None-Match': s.etag }),
    '/ (homepage)': s => ask(s, '/', { ...BROWSER, Host: 'pagebot.example.test' }),
    '/api/boot signed out': s => ask(s, '/api/boot', device),
    '/api/boot owner': s => ask(s, '/api/boot', { ...device, ...bearer(s.owner) }),
    '/api/boot account': s => ask(s, '/api/boot', { ...device, ...bearer(s.alice) }),
    '/api/chats owner (of 1,500 chats)': s => ask(s, '/api/chats', { ...BROWSER, ...bearer(s.owner) }),
    '/api/chats account (of 1,500 chats)': s => ask(s, '/api/chats', { ...BROWSER, ...bearer(s.alice) }),
    '/api/chats/:id owner': s => ask(s, `/api/chats/${s.ownerChat}`, { ...BROWSER, ...bearer(s.owner) }),
    '/api/chat first byte, new chat (owner)': s => ask(s, '/api/chat', bearer(s.owner), { method: 'POST', firstByte: true, body: question }),
    '/api/chat first byte, new chat (account)': s => ask(s, '/api/chat', bearer(s.alice), { method: 'POST', firstByte: true, body: question }),
    '/api/chat first byte, follow-up (owner)': s => ask(s, '/api/chat', bearer(s.owner), { method: 'POST', firstByte: true, body: { message: 'And this?', conversationId: s.ownerChat } }),
    '/api/chat first byte, follow-up (account)': s => ask(s, '/api/chat', bearer(s.alice), { method: 'POST', firstByte: true, body: { message: 'And this?', conversationId: s.aliceChat } }),
  };
  const stat = a => { const s = [...a].sort((x, y) => x - y), r = v => Math.round(v * 100) / 100; return { n: s.length, p50: r(s[Math.floor(s.length * 0.5)]), p95: r(s[Math.floor(s.length * 0.95)]), mean: r(s.reduce((x, y) => x + y, 0) / s.length) }; };
  for (const [name, run] of Object.entries(timings)) {
    const ms = servers.map(() => []);
    for (let round = 0; round <= rounds; round++) for (const k of round % 2 ? [...servers.keys()].reverse() : servers.keys()) for (let i = 0; i < BATCH; i++) {
      const r = await run(servers[k]);
      if (r.status !== 200 && r.status !== 304) throw new Error(`${name}: ${r.status} ${r.body.toString().slice(0, 200)}`);
      if (round > 0) ms[k].push(r.ms); // the first round warms the connection, the JIT and the pool
    }
    for (const k of servers.keys()) out.servers[k].ms[name] = stat(ms[k]);
  }

  // ---- the first boot after the server sat idle
  if (idleSeconds > 0) {
    const idle = servers.map(() => ({ owner: [], account: [] }));
    for (let i = 0; i < 3; i++) for (const who of ['account', 'owner']) {
      await sleep(idleSeconds * 1000);
      for (const k of i % 2 ? [...servers.keys()].reverse() : servers.keys()) {
        idle[k][who].push(Math.round((await ask(servers[k], '/api/boot', { ...device, ...bearer(who === 'owner' ? servers[k].owner : servers[k].alice) })).ms * 100) / 100);
        await sleep(300);
      }
    }
    for (const k of servers.keys()) out.servers[k].idleBootMs = { seconds: idleSeconds, ...Object.fromEntries(Object.entries(idle[k]).map(([who, v]) => [who, { samples: v, median: median(v) }])) };
  }
} finally {
  for (const s of servers) {
    await s.stop().catch(() => {});
    s.agent.destroy(); s.proxy?.close();
    await s.db.end().catch(() => {});
    await adminDb.query(`DROP SCHEMA IF EXISTS ${s.schema} CASCADE`).catch(() => {});
  }
  await adminDb.end(); model.close();
}

// ---- the report
const kb = n => (n / 1024).toFixed(1).padStart(6) + ' KB', two = out.servers.length === 2, [a, b] = out.servers;
console.log(`\npagebot server measurements (node ${out.node}${dbDelay ? `, +${dbDelay} ms per database round trip` : ''})`);
for (const [i, s] of out.servers.entries()) console.log(`${two ? (i ? 'after:  ' : 'before: ') : ''}${s.root}`);
console.log(`\nStart to a healthy /health, ms (stopped and started ${restarts} times, taking turns):`);
for (const [i, s] of out.servers.entries()) console.log(`  ${two ? (i ? 'after   ' : 'before  ') : ''}median ${s.startupMs.median}   (${s.startupMs.restarts.join(', ')}; the very first start, which creates the tables: ${s.startupMs.first})`);
console.log('\nBytes on the wire (headers and body), by what the client accepts:');
for (const [i, s] of out.servers.entries()) {
  if (two) console.log(i ? ' after' : ' before');
  for (const [route, e] of Object.entries(s.bytes))
    console.log(`  ${route.padEnd(24)} identity ${kb(e.identity.wire)}   gzip ${kb(e.gzip.wire)}${e.gzip.encoding === 'gzip' ? '' : ' (sent plain)'}   br ${kb(e.br.wire)}${e.br.encoding === 'br' ? '' : ' (sent plain)'}` +
      (e.revalidated ? `   unchanged: ${e.revalidated.status}, ${e.revalidated.wire} bytes` : '') + `   [${e.cache}]`);
}
console.log(`\nResponse time, ms (${rounds} batches of ${BATCH}, one request at a time${two ? ', the two servers taking turns' : ''}):`);
const f = v => String(v.toFixed(2)).padStart(7);
for (const name of Object.keys((b || a).ms)) {
  const x = a.ms[name], y = b?.ms[name];
  console.log(`  ${name.padEnd(42)} ` + (two ? `before p50 ${f(x.p50)} p95 ${f(x.p95)}   after p50 ${f(y.p50)} p95 ${f(y.p95)}   ${(100 * (y.p50 / x.p50 - 1)).toFixed(0).padStart(4)}%` : `p50 ${f(x.p50)}   p95 ${f(x.p95)}   mean ${f(x.mean)}`));
}
if (idleSeconds > 0) {
  console.log(`\nFirst /api/boot after ${idleSeconds} s idle, ms (median of 3):`);
  for (const [i, s] of out.servers.entries()) console.log(`  ${two ? (i ? 'after   ' : 'before  ') : ''}owner ${s.idleBootMs.owner.median} (${s.idleBootMs.owner.samples.join(', ')})   account ${s.idleBootMs.account.median} (${s.idleBootMs.account.samples.join(', ')})`);
}
if (opt('json')) { writeFileSync(opt('json'), JSON.stringify(out, null, 2)); console.log(`\nWrote ${opt('json')}`); }

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// The PDF storage cap, listing and deleting PDFs against a real server, an isolated PostgreSQL schema, and a local mock model server (no real API calls).
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const ADMIN = 'test-admin-token-' + randomBytes(8).toString('hex');
let db, adminDb, app, mock, origin, env, owner, alice, bob, pending;
const ids = {};
const calls = [], counts = [];
const fixture = { count: 4321, countFail: false, cites: null, gate: null }; // gate: a promise the mock model waits for before answering
const CAP_MB = 0.002, CAP = Math.round(CAP_MB * 1048576); // 2,097 bytes, so a few small files fill it
let logs = '', ip = 0;

// a small PDF with `pages` page objects (enough for the server, which only reads its header and counts pages)
const pdfFile = (pages = 2, tag = '') => Buffer.from('%PDF-1.4\n%' + tag + '\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
  `2 0 obj << /Type /Pages /Count ${pages} >> endobj\n` +
  Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n`).join('') +
  'trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
// the same, with its page objects packed into a compressed object stream (as newer PDFs do)
function packedPdf(pages) {
  const body = deflateSync(Buffer.from(Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R >>').join('\n')));
  return Buffer.concat([Buffer.from(`%PDF-1.7\n5 0 obj\n<< /Type /ObjStm /N ${pages} /First 0 /Filter /FlateDecode /Length ${body.length} >>\nstream\r\n`, 'latin1'),
    body, Buffer.from('\r\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1')]);
}

async function api(route, { token = owner, admin, method = 'GET', body } = {}) {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(admin && { 'x-admin-token': ADMIN }), ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, data: r.headers.get('content-type')?.includes('ndjson')
    ? text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(text) };
}
// each upload comes from its own address, so the per-address upload limit doesn't get in the way
async function upload(bytes, { token = owner, name = 'report.pdf', type = 'application/pdf' } = {}) {
  ip++;
  const r = await fetch(`${origin}/api/pdf?name=${encodeURIComponent(name)}`, {
    method: 'POST', body: bytes,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), 'Content-Type': type, 'X-Forwarded-For': `10.77.${ip >> 8 & 255}.${ip & 255}` },
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function chat(body, token = owner) {
  const r = await api('/api/chat', { method: 'POST', body: { message: 'Please help.', ...body }, token });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.at(-1).t, 'done', JSON.stringify(r.data));
  return r.data.at(-1);
}
async function session(userId = null) {
  const token = randomBytes(24).toString('hex');
  await db.query('INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), userId]);
  return token;
}
// a PDF of exactly n bytes (one page), distinct per tag
const sized = (n, tag = '') => { const base = pdfFile(1, tag); return pdfFile(1, tag + 'x'.repeat(Math.max(0, n - base.length))); };
const docs = content => (Array.isArray(content) ? content : []).filter(c => c.type === 'document');
const pdfDocs = body => body.messages.flatMap(m => docs(m.content)).filter(d => d.source?.media_type === 'application/pdf');
const breakpoints = body => body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.cache_control).length;

async function startApp() {
  app = spawn(process.execPath, ['--import', './tests/helpers/local-model.mjs', 'server.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env });
  app.stdout.on('data', chunk => { logs += chunk; });
  app.stderr.on('data', chunk => { logs += chunk; });
  for (let i = 0; i < 100; i++) {
    if (app.exitCode != null) throw new Error(`Test server exited: ${logs}`);
    try { if ((await fetch(origin + '/health')).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server failed to start: ${logs}`);
}
async function stopApp() { if (app && app.exitCode == null) { app.kill(); await once(app, 'exit'); } }

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
      counts.push(body);
      if (fixture.countFail) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Counting is unavailable in this fixture.' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: fixture.count }));
    }
    calls.push({ provider: req.url === '/router' ? 'router' : 'anthropic', body });
    if (fixture.gate) await fixture.gate;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (req.url === '/router') {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A local fixture answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.00001 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    const events = [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A local fixture answer.' } },
      ...(fixture.cites || []).map(citation => ({ type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation } })),
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
  env = { ...process.env, DATABASE_URL: url.href, PGSSL: 'false', PORT: String(port),
    INITIAL_PASSWORD: '', ADMIN_TOKEN: ADMIN, ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: mockOrigin,
    OPENROUTER_API_KEY: 'local-fixture-only', OPENROUTER_MODEL: 'meta/muse-spark-1.3-contributor',
    PAGEBOT_MOCK_MODEL_ORIGIN: mockOrigin, SYSTEM_PROMPT: 'You are a test helper.', TIMEZONE: 'UTC', PDF_STORAGE_MB: String(CAP_MB) };
  await startApp();
  const users = await db.query("INSERT INTO users(username,password_hash,status) VALUES ('alice','fixture-unused','trusted'),('bob','fixture-unused','trusted'),('pending','fixture-unused','pending') RETURNING id");
  [ids.alice, ids.bob, ids.pending] = users.rows.map(r => Number(r.id));
  [owner, alice, bob, pending] = await Promise.all([session(), ...users.rows.map(u => session(u.id))]);
});

after(async () => {
  await stopApp();
  if (mock) await new Promise(resolve => mock.close(resolve));
  await db?.end();
  if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
});

const stored = async uid => Number((await db.query('SELECT COALESCE(SUM(size),0) AS n FROM attachments WHERE user_id IS NOT DISTINCT FROM $1 AND bytes IS NOT NULL', [uid])).rows[0].n);

test('pdf storage cap and deleting', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  const FILE = 900; // two fit under the cap, a third doesn't
  let a1, a2;

  await t.test('the list needs a signed-in, accepted account, and starts empty with the cap', async () => {
    assert.equal((await api('/api/pdf', { token: null })).status, 401);
    assert.equal((await api('/api/pdf', { token: pending })).status, 403);
    assert.equal((await api(`/api/pdf/1`, { token: null, method: 'DELETE' })).status, 401);
    assert.equal((await api(`/api/pdf/1`, { token: pending, method: 'DELETE' })).status, 403);
    const r = await api('/api/pdf', { token: alice });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { used: 0, cap: CAP, pdfs: [] });
  });

  await t.test('uploads under the cap work, and the list shows each with the usage', async () => {
    a1 = (await upload(sized(FILE, 'one'), { token: alice, name: 'one.pdf' })).data;
    a2 = (await upload(sized(FILE, 'two'), { token: alice, name: 'two.pdf' })).data;
    assert.ok(a1.id && a2.id);
    const r = (await api('/api/pdf', { token: alice })).data;
    assert.equal(r.used, 2 * FILE);
    assert.equal(r.cap, CAP);
    assert.deepEqual(r.pdfs.map(p => [p.id, p.name, p.size, p.pages, p.inChat, p.chatId, p.chatTitle]), [
      [a2.id, 'two.pdf', FILE, 1, false, null, null], [a1.id, 'one.pdf', FILE, 1, false, null, null]], 'newest first');
    assert.ok(!Number.isNaN(Date.parse(r.pdfs[0].createdAt)));
    assert.ok(!('bytes' in r.pdfs[0]), 'never the file itself');
  });

  await t.test('the upload that would pass the cap is refused with 413, saying how much is used', async () => {
    const r = await upload(sized(FILE, 'three'), { token: alice, name: 'three.pdf' });
    assert.equal(r.status, 413);
    assert.equal(r.data.storage, true);
    assert.deepEqual([r.data.used, r.data.cap], [2 * FILE, CAP]);
    assert.match(r.data.error, /^You have \d[\d.]* MB of PDFs stored, out of \d[\d.]* MB, and this one is \d[\d.]* MB\./);
    assert.match(r.data.error, /Delete a PDF/);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM attachments WHERE name = 'three.pdf'")).rows[0].n, 0);
    assert.equal(await stored(ids.alice), 2 * FILE);
  });

  await t.test('everyone has their own room: another account and the owner are unaffected', async () => {
    assert.equal((await upload(sized(FILE, 'bob1'), { token: bob, name: 'bob.pdf' })).status, 200);
    assert.equal((await upload(sized(FILE, 'own1'), { name: 'owner.pdf' })).status, 200);
    assert.equal((await upload(sized(FILE, 'own2'), { name: 'owner2.pdf' })).status, 200);
    assert.equal((await upload(sized(FILE, 'own3'), { name: 'owner3.pdf' })).status, 413, 'the owner has a cap too');
    const o = (await api('/api/pdf')).data;
    assert.deepEqual(o.pdfs.map(p => p.name), ['owner2.pdf', 'owner.pdf'], 'the owner doesn’t see accounts’ PDFs');
    assert.equal(o.used, 2 * FILE);
    const b = (await api('/api/pdf', { token: bob })).data;
    assert.deepEqual(b.pdfs.map(p => p.name), ['bob.pdf']);
    assert.equal((await api('/api/pdf', { token: alice })).data.pdfs.length, 2, 'alice’s list is just hers');
  });

  await t.test('a PDF that went into a chat says which one', async () => {
    const d = await chat({ pdf: a1.id, message: 'What does the one-pager say about launch dates?' }, alice);
    const r = (await api('/api/pdf', { token: alice })).data.pdfs.find(p => p.id === a1.id);
    assert.equal(r.inChat, true);
    assert.equal(r.chatId, d.conversationId);
    assert.equal(r.chatTitle, 'What does the one-pager say about launch dates?');
  });

  await t.test('someone else’s id (an account’s, the owner’s, a missing or odd one) is a 404 and changes nothing', async () => {
    const ownerPdf = (await api('/api/pdf')).data.pdfs[0];
    for (const [token, id] of [[bob, a2.id], [alice, ownerPdf.id], [owner, a2.id], [alice, 999999999], [alice, 'abc'], [alice, '0'], [alice, '1e3']]) {
      const r = await api(`/api/pdf/${id}`, { token, method: 'DELETE' });
      assert.equal(r.status, 404, `${id}: ${JSON.stringify(r.data)}`);
    }
    assert.equal(await stored(ids.alice), 2 * FILE);
    assert.equal(await stored(null), 2 * FILE);
  });

  await t.test('deleting a PDF clears its file but keeps the row, frees the room, and a second delete is a 404', async () => {
    const r = await api(`/api/pdf/${a2.id}`, { token: alice, method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { ok: true, used: FILE, cap: CAP });
    const row = (await db.query('SELECT bytes, size, name FROM attachments WHERE id = $1', [a2.id])).rows[0];
    assert.deepEqual([row.bytes, row.size, row.name], [null, FILE, 'two.pdf'], 'the row stays for history');
    assert.deepEqual((await api('/api/pdf', { token: alice })).data.pdfs.map(p => p.id), [a1.id]);
    assert.equal((await api(`/api/pdf/${a2.id}`, { token: alice, method: 'DELETE' })).status, 404);
  });

  await t.test('and the upload that was refused now fits', async () => {
    const r = await upload(sized(FILE, 'three'), { token: alice, name: 'three.pdf' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await api('/api/pdf', { token: alice })).data.used, 2 * FILE);
  });

  await t.test('a deleted PDF in a chat: history shows it gone, and a follow-up carries the note instead of the file', async () => {
    const list = (await api('/api/pdf', { token: alice })).data.pdfs, inChat = list.find(p => p.id === a1.id);
    const before = (await api(`/api/chats/${inChat.chatId}`, { token: alice })).data;
    const q = before.messages.find(m => m.role === 'user');
    assert.deepEqual([q.pdf.id, q.pdf.name, q.pdf.gone], [a1.id, 'one.pdf', false]);
    assert.equal((await api(`/api/pdf/${a1.id}`, { token: alice, method: 'DELETE' })).status, 200);
    const after = (await api(`/api/chats/${inChat.chatId}`, { token: alice })).data;
    assert.deepEqual(after.messages.find(m => m.role === 'user').pdf, { id: a1.id, name: 'one.pdf', pages: 1, gone: true });
    await chat({ conversationId: inChat.chatId, message: 'Still there?' }, alice);
    const body = calls.at(-1).body;
    assert.equal(pdfDocs(body).length, 0, 'no file goes to the model');
    const first = body.messages[0].content;
    const text = typeof first === 'string' ? first : first.find(c => c.type === 'text').text;
    assert.match(text, /^\[A PDF \("one\.pdf"\) was attached to this message; it is no longer available\.\]/);
    const row = await api('/api/pdf', { token: alice });
    assert.ok(!row.data.pdfs.some(p => p.id === a1.id));
  });

  await t.test('deleting the PDF of a chat that is being answered doesn’t break the answer or its billing', async () => {
    const p = (await upload(sized(FILE, 'busy'), { token: bob, name: 'busy.pdf' })).data;
    const before = Number((await db.query('SELECT COUNT(*) AS n FROM messages WHERE user_id = $1', [ids.bob])).rows[0].n);
    let release; fixture.gate = new Promise(resolve => { release = resolve; });
    const asked = calls.length;
    const answer = api('/api/chat', { method: 'POST', body: { message: 'Summarize this.', pdf: p.id }, token: bob });
    try {
      for (let i = 0; i < 100 && calls.length === asked; i++) await new Promise(r => setTimeout(r, 50));
      assert.equal(pdfDocs(calls.at(-1).body).length, 1, 'the model has the file');
      assert.equal((await api(`/api/pdf/${p.id}`, { token: bob, method: 'DELETE' })).status, 200, 'deleted while the model is still answering');
    } finally { fixture.gate = null; release(); }
    const r = await answer;
    assert.equal(r.status, 200);
    assert.equal(r.data.at(-1).t, 'done');
    const rows = (await db.query('SELECT role, attachment_id, input_tokens, output_tokens FROM messages WHERE user_id = $1 ORDER BY id DESC LIMIT 2', [ids.bob])).rows;
    assert.equal(rows.length, 2);
    assert.equal(Number(rows.find(m => m.role === 'user').attachment_id), p.id, 'the question still points at its PDF');
    assert.ok(rows.find(m => m.role === 'assistant').input_tokens > 0, 'and the answer was billed');
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM messages WHERE user_id = $1', [ids.bob])).rows[0].n), before + 2);
  });

  await t.test('parallel uploads can’t both slip under the cap', async () => {
    const who = await db.query("INSERT INTO users(username,password_hash,status) VALUES ('carol','x','trusted') RETURNING id");
    const carol = await session(Number(who.rows[0].id)), cid = Number(who.rows[0].id);
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => upload(sized(FILE, 'par' + i), { token: carol, name: `par-${i}.pdf` })));
    const codes = rs.map(r => r.status).sort();
    assert.deepEqual(codes, [200, 200, 413, 413, 413, 413, 413, 413], JSON.stringify(rs.map(r => r.data)));
    assert.ok(await stored(cid) <= CAP);
    assert.equal(await stored(cid), 2 * FILE);
  });

  await t.test('an upload waits for that person’s storage lock, so check and insert can’t interleave', async () => {
    const who = await db.query("INSERT INTO users(username,password_hash,status) VALUES ('erin','x','trusted') RETURNING id");
    const erin = await session(Number(who.rows[0].id)), uid = Number(who.rows[0].id);
    const held = await db.connect();
    try {
      await held.query('BEGIN');
      await held.query(`SELECT pg_advisory_xact_lock(hashtextextended('pdf_storage:' || $1::text, 0))`, [uid]);
      let settled = false;
      const up = upload(sized(FILE, 'lock'), { token: erin }).then(r => { settled = true; return r; });
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(settled, false, 'blocked while someone else holds the lock');
      await held.query('COMMIT');
      assert.equal((await up).status, 200);
    } finally { held.release(); }
  });

  await t.test('files cleared by the retention sweep stop counting, and size is left as it was', async () => {
    const dave = (await db.query("INSERT INTO users(username,password_hash,status) VALUES ('dave','x','trusted') RETURNING id")).rows[0].id;
    const tok = await session(Number(dave));
    const p1 = (await upload(sized(FILE, 'old1'), { token: tok, name: 'old1.pdf' })).data, p2 = (await upload(sized(FILE, 'old2'), { token: tok, name: 'old2.pdf' })).data;
    assert.equal((await upload(sized(FILE, 'old3'), { token: tok })).status, 413);
    await db.query("UPDATE attachments SET conversation_id = (SELECT id FROM conversations ORDER BY id LIMIT 1), created_at = now() - interval '31 days' WHERE id = $1", [p1.id]);
    await stopApp(); await startApp(); // the sweep runs at startup
    const row = (await db.query('SELECT bytes IS NOT NULL AS stored, size FROM attachments WHERE id = $1', [p1.id])).rows[0];
    assert.deepEqual([row.stored, row.size], [false, FILE]);
    const r = (await api('/api/pdf', { token: tok })).data;
    assert.deepEqual([r.used, r.pdfs.map(p => p.id)], [FILE, [p2.id]]);
    assert.equal((await upload(sized(FILE, 'old3'), { token: tok })).status, 200, 'the room came back');
  });

  await t.test('the admin dashboard has each person’s stored count and size, and the cap', async () => {
    const r = (await api('/api/admin/users', { admin: true })).data;
    assert.equal(r.pdfCap, CAP);
    const alice2 = r.users.find(x => x.id === ids.alice);
    assert.deepEqual(alice2.pdfs, { count: 1, bytes: FILE }, 'alice has only three.pdf left');
    assert.deepEqual(r.owner.pdfs, { count: 2, bytes: 2 * FILE });
    assert.equal(r.users.find(x => x.id === ids.pending).pdfs.count, 0);
  });
});

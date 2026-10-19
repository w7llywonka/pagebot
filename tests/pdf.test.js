import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// PDF uploads against a real server, an isolated PostgreSQL schema, and a local mock model server (no real API calls).
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const ADMIN = 'test-admin-token-' + randomBytes(8).toString('hex');
let db, adminDb, app, mock, origin, env, owner, alice, bob, pending;
const ids = {};
const calls = [], counts = [];
const fixture = { count: 4321, countFail: false, cites: null };
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
    PAGEBOT_MOCK_MODEL_ORIGIN: mockOrigin, SYSTEM_PROMPT: 'You are a test helper.', TIMEZONE: 'UTC' };
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

test('pdf uploads', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  let firstConv, firstPdf;

  await t.test('needs a signed-in, accepted account', async () => {
    assert.equal((await upload(pdfFile(), { token: null })).status, 401);
    assert.equal((await upload(pdfFile(), { token: pending })).status, 403);
  });

  await t.test('accepts a PDF, stores it, and counts its tokens with the API', async () => {
    const bytes = pdfFile(2, 'first');
    const r = await upload(bytes, { name: '../../etc/Quarterly\nreport.pdf' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual({ ...r.data, id: 0 }, { id: 0, name: '.. .. etc Quarterly report.pdf', size: bytes.length, pages: 2, tokens: 4321 });
    const sent = counts.at(-1).messages[0].content[0];
    assert.equal(sent.type, 'document');
    assert.deepEqual(sent.source, { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') });
    const row = (await db.query('SELECT * FROM attachments WHERE id = $1', [r.data.id])).rows[0];
    assert.equal(row.user_id, null, 'the owner’s uploads have no user id');
    assert.equal(row.conversation_id, null);
    assert.ok(row.bytes.equals(bytes));
  });

  await t.test('falls back to counting pages, including ones packed in object streams', async () => {
    fixture.countFail = true;
    try {
      const r = await upload(packedPdf(7), { name: 'packed.pdf' });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.pages, 7);
      assert.equal(r.data.tokens, 7 * 2500);
      assert.equal((await upload(pdfFile(3))).data.tokens, 3 * 2500);
    } finally { fixture.countFail = false; }
  });

  await t.test('rejects anything that isn’t a PDF, whatever its content type says', async () => {
    const notes = await upload(Buffer.from('Just some notes, not a PDF at all.'), { name: 'notes.pdf' });
    assert.equal(notes.status, 415);
    assert.match(notes.data.error, /Only PDF files/);
    assert.equal((await upload(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { name: 'image.pdf' })).status, 415);
    assert.equal((await upload(pdfFile(), { type: 'text/plain' })).status, 415, 'a real PDF still has to be sent as one');
    assert.equal((await upload(pdfFile(), { type: 'application/json' })).status, 415);
    assert.equal((await upload(Buffer.alloc(0))).status, 415);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM attachments WHERE name IN ('notes.pdf', 'image.pdf')")).rows[0].n, 0);
  });

  await t.test('refuses files over 10 MB and PDFs over 100 pages', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 - 8, 0x20)]);
    const r = await upload(big);
    assert.equal(r.status, 413);
    assert.match(r.data.error, /up to 10 MB/);
    const long = await upload(pdfFile(101));
    assert.equal(long.status, 413);
    assert.match(long.data.error, /101 pages.*up to 100 pages/);
    assert.equal((await upload(pdfFile(100))).status, 200, '100 pages is fine');
  });

  await t.test('allow_pdf off, or a restriction, refuses uploads; new accounts start with the default', async () => {
    assert.equal((await api(`/api/admin/users/${ids.alice}`, { admin: true, method: 'POST', body: { allowPdf: false } })).status, 200);
    const off = await upload(pdfFile(), { token: alice });
    assert.equal(off.status, 403);
    assert.match(off.data.error, /aren’t turned on/);
    assert.equal((await api('/api/boot', { token: alice })).data.user.allowPdf, false);
    assert.equal((await api('/api/admin/users', { admin: true })).data.users.find(u => u.id === ids.alice).allowPdf, false);
    await api(`/api/admin/users/${ids.alice}`, { admin: true, method: 'POST', body: { allowPdf: true } });
    assert.equal((await upload(pdfFile(), { token: alice })).status, 200);

    const rst = await api(`/api/admin/users/${ids.alice}/ban`, { admin: true, method: 'POST', body: { kind: 'restrict', hours: 1, noPdf: true, reason: 'Too many PDFs' } });
    assert.equal(rst.status, 200, JSON.stringify(rst.data));
    assert.deepEqual(rst.data.ban.limits, { noPdf: true });
    assert.equal((await upload(pdfFile(), { token: alice })).status, 403);
    const b = (await api('/api/boot', { token: alice })).data;
    assert.equal(b.user.allowPdf, false);
    assert.equal(b.restriction.limits.noPdf, true);
    await api(`/api/admin/users/${ids.alice}/ban?kind=restrict`, { admin: true, method: 'DELETE' });
    assert.equal((await upload(pdfFile(), { token: alice })).status, 200);

    const d = await api('/api/admin/accounts', { admin: true, method: 'POST', body: { defaults: { allowPdf: false } } });
    assert.equal(d.data.defaults.allowPdf, false);
    assert.equal((await api(`/api/admin/users/${ids.pending}`, { admin: true, method: 'POST', body: { status: 'trusted' } })).status, 200);
    assert.equal((await db.query('SELECT allow_pdf FROM users WHERE id = $1', [ids.pending])).rows[0].allow_pdf, false);
    assert.equal((await upload(pdfFile(), { token: pending })).status, 403);
    await api('/api/admin/accounts', { admin: true, method: 'POST', body: { defaults: { allowPdf: true } } });
  });

  await t.test('sends the PDF as a cached, citable document with the first question and every follow-up', async () => {
    const bytes = pdfFile(4, 'cited');
    firstPdf = (await upload(bytes, { name: 'report.pdf' })).data;
    fixture.cites = [
      { type: 'page_location', cited_text: 'Revenue grew 12% in the third quarter.', document_index: 1, document_title: 'report.pdf', start_page_number: 2, end_page_number: 3 },
      { type: 'page_location', cited_text: 'Costs were flat.', document_index: 1, document_title: 'report.pdf', start_page_number: 3, end_page_number: 5 },
      { type: 'char_location', cited_text: 'From the page', document_index: 0, document_title: 'Example', start_char_index: 0, end_char_index: 13 },
    ];
    let done;
    try {
      done = await chat({ pdf: firstPdf.id, message: 'What does this say about revenue?', page: { url: 'https://example.com/a', title: 'Example', text: 'From the page.' } });
    } finally { fixture.cites = null; }
    firstConv = done.conversationId;
    const first = calls.at(-1).body;
    const content = first.messages.at(-1).content;
    assert.deepEqual(content.map(c => c.type), ['document', 'document', 'text']);
    assert.deepEqual(content[1], {
      type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') },
      title: 'report.pdf', citations: { enabled: true }, cache_control: { type: 'ephemeral' },
    });
    assert.deepEqual(content[0].citations, { enabled: true }, 'the API needs citations on every document or none');
    // this panel can't find page quotes, so only the PDF's come back, with their pages
    assert.deepEqual(done.quotes, ['Revenue grew 12% in the third quarter.', 'Costs were flat.']);
    assert.deepEqual(done.pdfPages, [{ name: 'report.pdf', from: 2, to: 2 }, { name: 'report.pdf', from: 3, to: 4 }]);
    assert.deepEqual(done.cites, [{ at: 'A local fixture answer.'.length, q: [0, 1] }]);

    const followUp = await chat({ conversationId: firstConv, message: 'And costs?' });
    const again = calls.at(-1).body;
    assert.equal(followUp.conversationId, firstConv);
    assert.equal(again.messages.length, 3);
    assert.deepEqual(pdfDocs(again).map(d => d.source.data), [bytes.toString('base64')], 'the PDF goes again, once');
    assert.deepEqual(docs(again.messages[0].content).at(-1).cache_control, { type: 'ephemeral' });
    assert.equal(typeof again.messages[2].content.find(c => c.type === 'text').text, 'string');
    assert.equal(docs(again.messages[2].content).length, 0, 'the follow-up itself carries no new PDF');
    const att = (await db.query('SELECT conversation_id FROM attachments WHERE id = $1', [firstPdf.id])).rows[0];
    assert.equal(Number(att.conversation_id), firstConv);
    const msgs = (await db.query("SELECT attachment_id FROM messages WHERE conversation_id = $1 AND role = 'user' ORDER BY id", [firstConv])).rows;
    assert.deepEqual(msgs.map(m => m.attachment_id && Number(m.attachment_id)), [firstPdf.id, null]);

    // with a panel that finds page quotes, both kinds come back, in order
    fixture.cites = [
      { type: 'char_location', cited_text: 'From the page', document_index: 0, document_title: 'Example', start_char_index: 0, end_char_index: 13 },
      { type: 'page_location', cited_text: 'Costs were flat.', document_index: 1, document_title: 'report.pdf', start_page_number: 3, end_page_number: 4 },
    ];
    try {
      const both = await chat({ conversationId: firstConv, cite: true, page: { url: 'https://example.com/a', title: 'Example', text: 'From the page.' } });
      assert.deepEqual(both.quotes, ['From the page', 'Costs were flat.']);
      assert.deepEqual(both.pdfPages, [null, { name: 'report.pdf', from: 3, to: 3 }]);
    } finally { fixture.cites = null; }

    const onlyPdf = (await upload(pdfFile(1))).data;
    await chat({ pdf: onlyPdf.id, message: '' });
    assert.equal(calls.at(-1).body.messages[0].content.at(-1).text, 'Summarize this PDF.');
  });

  await t.test('takes only your own PDFs, unused or already in this chat', async () => {
    const mine = (await upload(pdfFile(2, 'alice'), { token: alice })).data;
    for (const token of [bob, owner]) {
      const r = await api('/api/chat', { method: 'POST', body: { message: 'Read it.', pdf: mine.id }, token });
      assert.equal(r.status, 404, 'someone else’s PDF id');
    }
    assert.equal((await api('/api/chat', { method: 'POST', body: { message: 'Read it.', pdf: 'abc' }, token: alice })).status, 400);
    const conv = (await chat({ pdf: mine.id, message: 'Read it.' }, alice)).conversationId;
    const elsewhere = await api('/api/chat', { method: 'POST', body: { message: 'Again.', pdf: mine.id }, token: alice });
    assert.equal(elsewhere.status, 409, 'a PDF stays with the chat it went into');
    const n = calls.length;
    await chat({ conversationId: conv, pdf: mine.id, message: 'Again, in the same chat.' }, alice);
    assert.equal(calls.length, n + 1);
    assert.equal(pdfDocs(calls.at(-1).body).length, 1, 'sending it again in its own chat doesn’t add a second copy');
    // a conversation that isn't yours is a new chat, and the PDF can't follow into it
    assert.equal((await api('/api/chat', { method: 'POST', body: { message: 'Hi', conversationId: conv, pdf: mine.id }, token: bob })).status, 404);
  });

  await t.test('the ◆ OpenRouter model can’t take a PDF', async () => {
    const p = (await upload(pdfFile())).data;
    const n = calls.length;
    const r = await api('/api/chat', { method: 'POST', body: { message: 'Read this.', pdf: p.id, model: 'openrouter' } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /can’t read PDFs\. Pick Haiku or Sonnet/);
    const f = await api('/api/chat', { method: 'POST', body: { message: 'More?', conversationId: firstConv, model: 'openrouter' } });
    assert.equal(f.status, 400, 'nor a follow-up in a chat that has one');
    assert.equal(calls.length, n, 'no model was asked');
    assert.equal((await db.query('SELECT conversation_id FROM attachments WHERE id = $1', [p.id])).rows[0].conversation_id, null);
    await chat({ pdf: p.id, model: 'sonnet' });
    assert.equal(pdfDocs(calls.at(-1).body).length, 1, 'the refused PDF still works on another model');
  });

  await t.test('a PDF too big for what’s left of today’s limit is turned down before asking the model', async () => {
    await api(`/api/admin/users/${ids.bob}`, { admin: true, method: 'POST', body: { limitKind: 'tokens', limitValue: 100000 } });
    fixture.count = 150_000;
    let p;
    try { p = (await upload(pdfFile(60), { token: bob })).data; } finally { fixture.count = 4321; }
    assert.equal(p.tokens, 150_000);
    const n = calls.length;
    const r = await api('/api/chat', { method: 'POST', body: { message: 'Summarize it.', pdf: p.id }, token: bob });
    assert.equal(r.status, 429);
    assert.match(r.data.error, /left of today’s limit/);
    assert.match(r.data.error, /The PDF in this chat is about 150K tokens on its own\. Try a smaller PDF/);
    assert.equal(calls.length, n);
    assert.equal((await db.query('SELECT conversation_id FROM attachments WHERE id = $1', [p.id])).rows[0].conversation_id, null, 'it stays free to use');
    const small = (await upload(pdfFile(1), { token: bob })).data;
    await chat({ pdf: small.id }, bob);
    await api(`/api/admin/users/${ids.bob}`, { admin: true, method: 'POST', body: { limitKind: 'none' } });
  });

  await t.test('a chat holds three PDFs, within four cache breakpoints', async () => {
    let conv = null;
    for (let i = 0; i < 3; i++) {
      const p = (await upload(pdfFile(1, 'set' + i), { name: `part-${i}.pdf` })).data;
      conv = (await chat({ conversationId: conv, pdf: p.id, message: `Part ${i}` })).conversationId;
    }
    const body = calls.at(-1).body;
    assert.deepEqual(pdfDocs(body).map(d => d.title), ['part-0.pdf', 'part-1.pdf', 'part-2.pdf']);
    assert.ok(breakpoints(body) <= 4, `${breakpoints(body)} cache breakpoints`);
    const fourth = (await upload(pdfFile(1))).data;
    const r = await api('/api/chat', { method: 'POST', body: { conversationId: conv, pdf: fourth.id, message: 'One more' } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /A chat can hold 3 PDFs/);
  });

  await t.test('the admin Activity tab names the PDF that went with a question', async () => {
    const rows = (await api('/api/admin/activity?days=1&limit=200', { admin: true })).data.rows;
    const row = rows.find(r => r.conversationId === firstConv && r.pdf);
    assert.equal(row.pdf, 'report.pdf');
    const detail = (await api(`/api/admin/activity/${row.id}`, { admin: true })).data;
    assert.deepEqual({ ...detail.pdf, size: 0 }, { name: 'report.pdf', size: 0, pages: 4, stored: true });
  });

  await t.test('follow-ups send a note once the file is gone; the sweep clears old files at startup', async () => {
    await db.query('UPDATE attachments SET bytes = NULL WHERE id = $1', [firstPdf.id]);
    await chat({ conversationId: firstConv, message: 'Still there?' });
    const body = calls.at(-1).body;
    assert.equal(pdfDocs(body).length, 0);
    const first = body.messages[0].content;
    const text = typeof first === 'string' ? first : first.find(c => c.type === 'text').text;
    assert.match(text, /^\[A PDF \("report\.pdf"\) was attached to this message; it is no longer available\.\]/);
    const activity = (await api('/api/admin/activity?days=1&limit=200', { admin: true })).data.rows.find(r => r.conversationId === firstConv && r.pdf);
    assert.equal((await api(`/api/admin/activity/${activity.id}`, { admin: true })).data.pdf.stored, false);

    const add = (uid, conv, age) => db.query(`INSERT INTO attachments(user_id, conversation_id, name, bytes, size, tokens, created_at)
      VALUES ($1, $2, 'old.pdf', '\\x25504446', 4, 10, now() - $3::interval) RETURNING id`, [uid, conv, age]).then(r => r.rows[0].id);
    const unusedOld = await add(ids.alice, null, '25 hours');
    const unusedNew = await add(ids.alice, null, '2 hours');
    const usedOld = await add(null, firstConv, '31 days');
    const usedNew = await add(null, firstConv, '29 days');
    const ghost = (await db.query("INSERT INTO users(username,password_hash,status) VALUES ('ghost','x','trusted') RETURNING id")).rows[0].id;
    const orphan = await add(ghost, firstConv, '1 hour');
    await db.query('DELETE FROM users WHERE id = $1', [ghost]);
    await stopApp();
    await startApp();
    const rows = new Map((await db.query('SELECT id, bytes IS NOT NULL AS stored FROM attachments WHERE id = ANY($1)', [[unusedOld, unusedNew, usedOld, usedNew, orphan]])).rows.map(r => [r.id, r.stored]));
    assert.equal(rows.has(unusedOld), false, 'an upload never sent goes after a day');
    assert.equal(rows.get(unusedNew), true);
    assert.equal(rows.get(usedOld), false, 'a 30-day-old file is cleared, its row stays');
    assert.equal(rows.get(usedNew), true);
    assert.equal(rows.get(orphan), false, 'a deleted account’s files are cleared');
  });
});

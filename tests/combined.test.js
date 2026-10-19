import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Where the features meet (PDF uploads, page actions, chat history), against a real server, an isolated PostgreSQL
// schema and a local mock model server (no real API calls).
const database = process.env.PAGEBOT_TEST_DATABASE_URL;
const schema = `pagebot_test_${randomBytes(8).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const ADMIN = 'combined-test-admin-token-0123456789';
let db, adminDb, app, mock, origin, owner, alice, carol, dave;
const ids = {};
const calls = [];
let script = null, logs = '', ip = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pdfFile = (pages = 3, tag = '') => Buffer.from('%PDF-1.4\n%' + tag + '\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
  `2 0 obj << /Type /Pages /Count ${pages} >> endobj\n` +
  Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`).join('') + 'trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
// one model reply: optional text (with PDF citations) or tool calls
function sse(res, body, spec = {}) {
  const ev = [{ type: 'message_start', message: { id: 'msg_' + randomBytes(4).toString('hex'), type: 'message', role: 'assistant', content: [], model: body.model,
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }];
  let i = 0;
  if (spec.text || !spec.tools?.length) {
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: spec.text || 'A local fixture answer.' } },
      ...(spec.cites || []).map(citation => ({ type: 'content_block_delta', index: i, delta: { type: 'citations_delta', citation } })),
      { type: 'content_block_stop', index: i });
    i++;
  }
  for (const t of spec.tools || []) {
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'toolu_' + randomBytes(6).toString('hex'), name: t.name, input: {} } },
      { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input || {}) } },
      { type: 'content_block_stop', index: i });
    i++;
  }
  ev.push({ type: 'message_delta', delta: { stop_reason: spec.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of ev) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}
async function api(route, { token = owner, admin, method = 'GET', body } = {}) {
  const r = await fetch(origin + route, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(admin && { 'x-admin-token': ADMIN }), ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, data: r.headers.get('content-type')?.includes('ndjson')
    ? text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(text || '{}') };
}
async function upload(bytes, { token = owner, name = 'report.pdf' } = {}) {
  ip++;
  const r = await fetch(`${origin}/api/pdf?name=${encodeURIComponent(name)}`, { method: 'POST', body: bytes,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), 'Content-Type': 'application/pdf', 'X-Forwarded-For': `10.88.${ip >> 8 & 255}.${ip & 255}` } });
  return { status: r.status, data: await r.json().catch(() => null) };
}
// a chat with page actions on; onAct answers each {t:'act'} the way the panel would
async function chat(body = {}, { token = owner, onAct } = {}) {
  const r = await fetch(origin + '/api/chat', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Please help.', ...body }) });
  if (!r.headers.get('content-type')?.includes('ndjson')) return { status: r.status, events: [], error: (await r.json()).error };
  const events = [], reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      events.push(ev);
      if (ev.t === 'act' && onAct) await onAct(ev);
    }
  }
  return { status: r.status, events, done: events.find(e => e.t === 'done'), acts: events.filter(e => e.t === 'act'), error: events.find(e => e.t === 'err')?.v };
}
const answerAct = ev => api('/api/chat/act', { method: 'POST', body: { id: ev.id, note: 'Read the page again', result: { url: 'https://x.example/', title: 'X', text: 'Fresh page text.' } } });
async function session(userId = null) {
  const token = randomBytes(24).toString('hex');
  await db.query('INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), userId]);
  return token;
}
const pdfDocs = body => body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'document' && c.source?.media_type === 'application/pdf');

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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 1234 }));
    }
    const n = calls.push({ body }) - 1;
    sse(res, body, script ? script(body, n) : {});
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
      INITIAL_PASSWORD: '', ADMIN_TOKEN: ADMIN, ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: mockOrigin,
      OPENROUTER_API_KEY: 'local-fixture-only', OPENROUTER_MODEL: 'meta/muse-spark-1.3-contributor',
      PAGEBOT_MOCK_MODEL_ORIGIN: mockOrigin, SYSTEM_PROMPT: 'You are a test helper.', TIMEZONE: 'UTC', PAGEBOT_TEST_ACT_WAIT_SCALE: '0.1' },
  });
  app.stdout.on('data', chunk => { logs += chunk; });
  app.stderr.on('data', chunk => { logs += chunk; });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (app.exitCode != null) throw new Error(`Test server exited: ${logs}`);
    try { ready = (await fetch(origin + '/health')).ok; } catch { /* starting */ }
    if (!ready) await sleep(100);
  }
  assert.ok(ready, `Server failed to start: ${logs}`);
  const users = await db.query(`INSERT INTO users(username,password_hash,status) VALUES ('alice','x','trusted'),('carol','x','trusted'),('dave','x','trusted') RETURNING id, username`);
  for (const u of users.rows) ids[u.username] = Number(u.id);
  [owner, alice, carol, dave] = await Promise.all([session(), ...['alice', 'carol', 'dave'].map(n => session(ids[n]))]);
});

after(async () => {
  if (app && app.exitCode == null) { app.kill(); await once(app, 'exit'); }
  if (mock) await new Promise(resolve => mock.close(resolve));
  await db?.end();
  if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
});

test('features together', { skip: !database && 'Set PAGEBOT_TEST_DATABASE_URL to run PostgreSQL integration tests.' }, async t => {
  let conv, pdfId;

  await t.test('a chat with a PDF and page actions: both go to the model, and both are kept', async () => {
    pdfId = (await upload(pdfFile(3, 'one'), { name: 'Annual report.pdf' })).data.id;
    const base = calls.length;
    script = (body, n) => [{ tools: [{ name: 'read_page', input: {} }] },
      { text: 'Revenue grew 12%. Costs were flat.', cites: [
        { type: 'page_location', cited_text: 'Revenue grew 12% in the third quarter.', document_index: 1, document_title: 'Annual report.pdf', start_page_number: 2, end_page_number: 3 }] }][n - base] || {};
    const r = await chat({ pdf: pdfId, actions: true, page: { url: 'https://x.example/', title: 'X', text: 'A page.' } }, { onAct: answerAct });
    assert.equal(r.status, 200, JSON.stringify(r.events));
    assert.ok(r.done, JSON.stringify(r.events));
    conv = r.done.conversationId;
    assert.equal(r.acts.length, 1);
    assert.ok(calls[base].body.tools.some(x => x.name === 'click'), 'page tools go along');
    assert.equal(pdfDocs(calls[base].body).length, 1);
    assert.equal(pdfDocs(calls[base + 1].body).length, 1, 'the PDF goes again in the next round');
    const row = (await db.query("SELECT * FROM messages WHERE conversation_id=$1 AND role='user'", [conv])).rows[0];
    assert.equal(Number(row.attachment_id), pdfId);
    const ans = (await db.query("SELECT * FROM messages WHERE conversation_id=$1 AND role='assistant'", [conv])).rows[0];
    assert.equal(JSON.parse(ans.steps).length, 1);
    assert.deepEqual(JSON.parse(ans.meta).pdfPages, [{ name: 'Annual report.pdf', from: 2, to: 2 }]);
  });

  await t.test('reopening the chat from history shows the PDF, the answer’s steps and its PDF page quotes', async () => {
    const r = await api('/api/chats/' + conv);
    assert.equal(r.status, 200);
    const [q, a] = r.data.messages;
    assert.deepEqual({ ...q.pdf, id: 0 }, { id: 0, name: 'Annual report.pdf', pages: 3, gone: false });
    assert.deepEqual(a.steps.map(s => [s.tool, s.outcome]), [['read_page', 'done']]);
    assert.equal(a.steps[0].text, 'Read the page again');
    assert.deepEqual(a.quotes, ['Revenue grew 12% in the third quarter.']);
    assert.deepEqual(a.pdfPages, [{ name: 'Annual report.pdf', from: 2, to: 2 }]);
    assert.equal((await api('/api/chats/' + conv, { token: alice })).status, 404, 'someone else’s chat looks like one that isn’t there');
  });

  await t.test('a follow-up resends the PDF and says what the page steps were', async () => {
    const base = calls.length;
    script = () => ({ text: 'Follow-up answer.' });
    const r = await chat({ conversationId: conv, message: 'And the costs?' });
    assert.ok(r.done, JSON.stringify(r.events));
    const body = calls[base].body;
    assert.equal(pdfDocs(body).length, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.ok(Array.isArray(body.messages[0].content) && body.messages[0].content.some(c => c.type === 'document'), 'the PDF rides on the first question');
    assert.match(JSON.stringify(body.messages[1]), /Page actions I took in this answer/);
  });

  await t.test('once the PDF’s file is cleared, the chat still names it, greyed out', async () => {
    await db.query('UPDATE attachments SET bytes = NULL WHERE id = $1', [pdfId]);
    const r = await api('/api/chats/' + conv);
    assert.deepEqual({ ...r.data.messages[0].pdf, id: 0 }, { id: 0, name: 'Annual report.pdf', pages: 3, gone: true });
    const base = calls.length;
    await chat({ conversationId: conv, message: 'Again?' });
    assert.equal(pdfDocs(calls[base].body).length, 0);
    assert.match(JSON.stringify(calls[base].body.messages[0]), /was attached to this message; it is no longer available/);
  });

  await t.test('the Activity tab tags a question with a PDF, page actions and the chat’s removal together, and its detail still opens', async () => {
    assert.equal((await api('/api/chats/' + conv, { method: 'DELETE' })).status, 200);
    const list = (await api('/api/admin/activity?days=7', { admin: true, token: null })).data.rows.filter(x => x.conversationId === conv);
    const first = list.at(-1);
    assert.equal(first.pdf, 'Annual report.pdf');
    assert.equal(first.acted, true);
    assert.equal(first.removed, true);
    const d = (await api('/api/admin/activity/' + first.id, { admin: true, token: null })).data;
    assert.equal(d.pdf.name, 'Annual report.pdf');
    assert.equal(d.steps.length, 1);
    assert.equal((await api('/api/chats/' + conv)).status, 404);
  });

  await t.test('allow_pdf off refuses PDFs but not page actions', async () => {
    const mine = (await upload(pdfFile(2, 'alice'), { token: alice })).data.id;
    assert.equal((await api(`/api/admin/users/${ids.alice}`, { admin: true, token: null, method: 'POST', body: { allowPdf: false } })).status, 200);
    assert.equal((await upload(pdfFile(), { token: alice })).status, 403);
    const withPdf = await chat({ pdf: mine }, { token: alice });
    assert.equal(withPdf.status, 400);
    assert.match(withPdf.error, /PDF uploads aren’t turned on/);
    const base = calls.length;
    script = () => ({ text: 'No tools needed.' });
    const r = await chat({ actions: true, page: { url: 'https://x.example/', title: 'X', text: 'A page.' } }, { token: alice });
    assert.ok(r.done, JSON.stringify(r.events));
    assert.ok(calls[base].body.tools.some(x => x.name === 'read_page'), 'page actions still work');
    const boot = (await api('/api/boot', { token: alice })).data.user;
    assert.deepEqual([boot.allowPdf, boot.allowActions], [false, true]);
  });

  await t.test('allow_actions off refuses page tools but not PDFs', async () => {
    await db.query('UPDATE users SET allow_actions = false WHERE id = $1', [ids.carol]);
    const up = await upload(pdfFile(2, 'carol'), { token: carol });
    assert.equal(up.status, 200);
    const base = calls.length;
    script = () => ({ text: 'Plain answer.' });
    const r = await chat({ pdf: up.data.id, actions: true }, { token: carol });
    assert.ok(r.done, JSON.stringify(r.events));
    assert.equal(calls[base].body.tools, undefined, 'no page tools');
    assert.equal(pdfDocs(calls[base].body).length, 1, 'the PDF still goes');
    const boot = (await api('/api/boot', { token: carol })).data.user;
    assert.deepEqual([boot.allowPdf, boot.allowActions], [true, false]);
  });

  await t.test('a restriction can take away PDFs and page actions together, with Sonnet and web search', async () => {
    const rst = await api(`/api/admin/users/${ids.dave}/ban`, { admin: true, token: null, method: 'POST',
      body: { kind: 'restrict', hours: 1, reason: 'Testing', noSonnet: true, noWeb: true, noPdf: true, noActions: true, junk: true } });
    assert.equal(rst.status, 200, JSON.stringify(rst.data));
    assert.deepEqual(rst.data.ban.limits, { noSonnet: true, noWeb: true, noPdf: true, noActions: true });
    const boot = (await api('/api/boot', { token: dave })).data;
    assert.deepEqual([boot.user.allowSonnet, boot.user.allowWeb, boot.user.allowPdf, boot.user.allowActions], [false, false, false, false]);
    assert.deepEqual(boot.restriction.limits, { noSonnet: true, noWeb: true, noPdf: true, noActions: true });
    assert.equal((await upload(pdfFile(), { token: dave })).status, 403);
    const base = calls.length;
    script = () => ({ text: 'Plain answer.' });
    const r = await chat({ actions: true, web: true, model: 'sonnet' }, { token: dave });
    assert.ok(r.done, JSON.stringify(r.events));
    assert.equal(calls[base].body.tools, undefined, 'no page tools and no web search');
    assert.match(calls[base].body.model, /haiku/i);
    const list = (await api('/api/admin/users', { admin: true, token: null })).data.users.find(u => u.id === ids.dave);
    assert.equal(list.restriction.limits.noPdf, true);
    await api(`/api/admin/users/${ids.dave}/ban?kind=restrict`, { admin: true, token: null, method: 'DELETE' });
    assert.equal((await upload(pdfFile(), { token: dave })).status, 200, 'back to normal when it ends');
  });
});

import express from 'express';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, 'public');

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || 'claude-haiku-5-5';
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 2048;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const BUDGET = Number(process.env.TOKEN_BUDGET) || 200_000_000;
const TIMEZONE = process.env.TIMEZONE || 'America/Denver';
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 30;
const SYSTEM = process.env.SYSTEM_PROMPT ||
  `You are a fast, concise helper running in a small chat panel on top of whatever web page the user is viewing.
The user may attach the page's text (<page>), text they highlighted (<highlighted_text>), and/or a screenshot.
Lead with the answer. Keep it short unless asked for detail. Use light markdown (bold, lists, code blocks) only when it helps.
If the attached content doesn't contain what's needed, say so briefly.`;

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) console.warn('ANTHROPIC_API_KEY is not set — chat will fail.');
if (ADMIN_TOKEN.length < 16) console.warn('ADMIN_TOKEN is missing or under 16 chars — /admin stays locked until you set it.');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 5,
});
const anthropic = new Anthropic(); // ANTHROPIC_API_KEY from env

// ---------- db ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversations (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  page_url TEXT,
  page_title TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  had_image BOOLEAN NOT NULL DEFAULT false,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages (conversation_id, id);
CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at);
`;

async function getSetting(key) {
  const r = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
  return r.rows[0]?.value ?? null;
}
async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
    [key, value]);
}

async function initDb() {
  for (let i = 0; ; i++) {
    try { await pool.query(SCHEMA); break; }
    catch (e) {
      if (i >= 14) throw e;
      console.log(`Database not ready (${e.message}), retrying…`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (process.env.INITIAL_PASSWORD && !(await getSetting('password_hash'))) {
    await setSetting('password_hash', await hashPw(process.env.INITIAL_PASSWORD));
    console.log('Access password seeded from INITIAL_PASSWORD.');
  }
}

// ---------- crypto helpers ----------
const scrypt = promisify(crypto.scrypt);
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPw(pw, stored) {
  const [, s, k] = String(stored).split('$');
  if (!s || !k) return false;
  const key = await scrypt(pw, Buffer.from(s, 'base64'), 64);
  const want = Buffer.from(k, 'base64');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}
function adminOk(req) {
  if (ADMIN_TOKEN.length < 16) return false;
  const a = Buffer.from(sha256(req.get('x-admin-token') || ''), 'hex');
  const b = Buffer.from(sha256(ADMIN_TOKEN), 'hex');
  return crypto.timingSafeEqual(a, b);
}

// ---------- middleware ----------
const hits = new Map();
const limit = (max, bucket) => (req, res, next) => {
  const key = bucket + ':' + req.ip, now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < 60_000);
  if (arr.length >= max) return res.status(429).json({ error: 'Too many requests — wait a minute.' });
  arr.push(now); hits.set(key, arr); next();
};
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60_000)) hits.delete(k); }, 300_000).unref();

async function auth(req, res, next) {
  const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!tok) return res.status(401).json({ error: 'Not logged in' });
  const r = await pool.query(
    `UPDATE sessions SET last_used=now() WHERE token_hash=$1 AND last_used > now() - make_interval(days => $2) RETURNING 1`,
    [sha256(tok), SESSION_DAYS]);
  if (!r.rowCount) return res.status(401).json({ error: 'Session expired' });
  next();
}
function admin(req, res, next) {
  if (adminOk(req)) return next();
  res.status(401).json({ error: ADMIN_TOKEN.length < 16 ? 'ADMIN_TOKEN env var is not set on the server (min 16 chars).' : 'Wrong admin token' });
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));

const publicOrigin = req =>
  (process.env.PUBLIC_URL || '').replace(/\/+$/, '') ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `${req.protocol}://${req.get('host')}`);

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bookmarkletSrc = fs.readFileSync(path.join(__dirname, 'bookmarklet.js'), 'utf8');
const installTpl = fs.readFileSync(path.join(PUB, 'install.html'), 'utf8');

app.get(['/', '/install'], (req, res) => {
  const origin = publicOrigin(req);
  const code = bookmarkletSrc.replaceAll('__ORIGIN__', origin).replace(/\n\s*/g, '');
  const href = 'javascript:' + encodeURIComponent(code);
  res.set('Cache-Control', 'no-cache').type('html').send(
    installTpl.replaceAll('{{HREF}}', () => escHtml(href)).replaceAll('{{ORIGIN}}', () => escHtml(origin)));
});

app.get('/widget', (req, res) => {
  res.set({ 'Content-Security-Policy': 'frame-ancestors *', 'Cache-Control': 'no-cache' });
  res.sendFile(path.join(PUB, 'widget.html'));
});

app.get('/chat', (req, res) => {
  res.set({ 'Content-Security-Policy': "frame-ancestors 'none'", 'Cache-Control': 'no-cache' });
  res.sendFile(path.join(PUB, 'widget.html'));
});

app.get('/admin', (req, res) => {
  res.set({ 'Content-Security-Policy': "frame-ancestors 'none'", 'Cache-Control': 'no-cache' });
  res.sendFile(path.join(PUB, 'admin.html'));
});

app.get('/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, model: MODEL });
});

// login with the access password -> session token
app.post('/api/login', limit(10, 'login'), async (req, res) => {
  const password = String(req.body?.password || '');
  const stored = await getSetting('password_hash');
  if (!stored) return res.status(503).json({ error: 'No password set yet — set one at /admin.' });
  if (!password || !(await verifyPw(password, stored))) return res.status(401).json({ error: 'Wrong password' });
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO sessions(token_hash) VALUES($1)', [sha256(token)]);
  res.json({ token });
});

app.post('/api/logout', auth, async (req, res) => {
  const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(tok)]);
  res.json({ ok: true });
});

// chat (streams NDJSON: {t:'d',v:text} ... {t:'done',...} | {t:'err',v})
app.post('/api/chat', limit(60, 'chat'), auth, async (req, res) => {
  const b = req.body || {};
  const message = String(b.message || '').slice(0, 8000);
  const page = b.page && typeof b.page === 'object' ? {
    url: String(b.page.url || '').slice(0, 2000),
    title: String(b.page.title || '').slice(0, 300),
    text: String(b.page.text || '').slice(0, 30000),
  } : null;
  const selection = String(b.selection || '').slice(0, 8000);

  let image = null;
  if (b.image) {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image));
    if (!m) return res.status(400).json({ error: 'Bad image data' });
    if (m[2].length > 8_000_000) return res.status(413).json({ error: 'Screenshot too large' });
    image = { media_type: m[1], data: m[2] };
  }
  if (!message && !image && !page && !selection) return res.status(400).json({ error: 'Empty message' });

  // load or create conversation
  let convId = Number.isSafeInteger(b.conversationId) ? b.conversationId : null;
  let history = [];
  if (convId) {
    const c = await pool.query('SELECT 1 FROM conversations WHERE id=$1', [convId]);
    if (c.rowCount) {
      history = (await pool.query(
        'SELECT role, content, had_image FROM messages WHERE conversation_id=$1 ORDER BY id', [convId])).rows;
    } else convId = null;
  }
  if (!convId) {
    const r = await pool.query('INSERT INTO conversations(page_url,page_title) VALUES($1,$2) RETURNING id',
      [page?.url || null, page?.title || null]);
    convId = Number(r.rows[0].id);
  }

  // build this turn's text
  const attr = s => s.replace(/"/g, '&quot;');
  const parts = [];
  if (page) parts.push(`<page url="${attr(page.url)}" title="${attr(page.title)}">\n${page.text}\n</page>`);
  if (selection) parts.push(`<highlighted_text>\n${selection}\n</highlighted_text>`);
  parts.push(message || (image ? 'Help me with what is in this screenshot.' : selection ? 'Explain the highlighted text.' : 'Summarize this page.'));
  const userText = parts.join('\n\n');

  // old screenshots are not resent (saves tokens) — a note stands in for them
  const messages = history.map(h => ({
    role: h.role,
    content: h.had_image ? `[A screenshot was attached to this message; it is no longer available.]\n\n${h.content}` : h.content,
  }));
  const cur = [];
  if (image) cur.push({ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } });
  cur.push({ type: 'text', text: userText, cache_control: { type: 'ephemeral' } });
  messages.push({ role: 'user', content: cur });

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  const out = o => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + '\n'); };

  const stream = anthropic.messages.stream({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages });
  res.on('close', () => { if (!res.writableFinished) stream.abort(); }); // panel closed -> stop spending tokens
  stream.on('text', t => out({ t: 'd', v: t }));

  try {
    const final = await stream.finalMessage();
    const reply = final.content.filter(c => c.type === 'text').map(c => c.text).join('') || '(no answer)';
    const u = final.usage || {};
    const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const outTok = u.output_tokens || 0;
    await pool.query(
      `INSERT INTO messages(conversation_id, role, content, had_image, input_tokens, output_tokens)
       VALUES ($1,'user',$2,$3,0,0), ($1,'assistant',$4,false,$5,$6)`,
      [convId, userText, !!image, reply, inTok, outTok]);
    out({ t: 'done', conversationId: convId, usage: { in: inTok, out: outTok }, stop: final.stop_reason });
  } catch (e) {
    if (e?.name !== 'APIUserAbortError') console.error('chat error:', e?.status, e?.message);
    out({ t: 'err', v: friendly(e) });
  }
  res.end();
});

function friendly(e) {
  const s = e?.status;
  if (s === 401) return 'Anthropic API key is invalid (check ANTHROPIC_API_KEY).';
  if (s === 404) return `Model "${MODEL}" not found (check MODEL).`;
  if (s === 429) return 'Rate limited by the API — try again in a moment.';
  if (s === 529 || s === 503) return 'The API is overloaded — try again in a moment.';
  return (e?.error?.error?.message || e?.message || 'Something went wrong').slice(0, 300);
}

// ---------- admin ----------
app.post('/api/admin/check', limit(20, 'admin'), admin, async (req, res) => {
  res.json({ ok: true, passwordSet: !!(await getSetting('password_hash')) });
});

app.get('/api/admin/stats', limit(30, 'admin'), admin, async (req, res) => {
  const todayStart = `date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1`;
  const m = (await pool.query(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total,
      COALESCE(SUM(input_tokens), 0)::bigint AS input,
      COALESCE(SUM(output_tokens), 0)::bigint AS output,
      COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE created_at >= ${todayStart}), 0)::bigint AS today,
      COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE created_at >= now() - interval '7 days'), 0)::bigint AS week,
      COUNT(*) FILTER (WHERE role = 'user')::bigint AS questions,
      COUNT(*) FILTER (WHERE role = 'user' AND created_at >= ${todayStart})::bigint AS questions_today
    FROM messages`, [TIMEZONE])).rows[0];
  const sessions = (await pool.query('SELECT COUNT(*)::bigint AS n FROM sessions')).rows[0].n;
  const n = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));
  res.json({ ...n(m), sessions: Number(sessions), budget: BUDGET, model: MODEL, passwordSet: !!(await getSetting('password_hash')) });
});

app.post('/api/admin/password', limit(20, 'admin'), admin, async (req, res) => {
  const pw = String(req.body?.password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  await setSetting('password_hash', await hashPw(pw));
  const r = await pool.query('DELETE FROM sessions');
  res.json({ ok: true, signedOut: r.rowCount });
});

app.post('/api/admin/signout-all', limit(20, 'admin'), admin, async (req, res) => {
  const r = await pool.query('DELETE FROM sessions');
  res.json({ ok: true, signedOut: r.rowCount });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Server error' });
});

await initDb();
app.listen(PORT, () => console.log(`pagebot listening on :${PORT} (model ${MODEL})`));

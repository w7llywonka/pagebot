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
// the two models the panel can switch between; web search tool versions differ per model
const MODELS = {
  haiku: { id: process.env.HAIKU_MODEL || process.env.MODEL || 'claude-haiku-5-5', label: 'Haiku 5.5', search: 'web_search_20250305' },
  sonnet: { id: process.env.SONNET_MODEL || 'claude-sonnet-5-5', label: 'Sonnet 5.5', search: 'web_search_20260209', fallback: process.env.SONNET_FALLBACK !== 'off' },
};
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// both models think by default and thinking counts toward max_tokens; low effort keeps chat replies quick
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'].includes(process.env.EFFORT) ? process.env.EFFORT : 'low';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const BUDGET = Number(process.env.TOKEN_BUDGET) || 200_000_000;
const TIMEZONE = process.env.TIMEZONE || 'America/Denver';
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 30;
const SYSTEM = process.env.SYSTEM_PROMPT ||
  `You are a fast, concise helper running in a small chat panel on top of whatever web page the user is viewing.
The user may attach the page's text (<page>), text they highlighted (<highlighted_text>), and/or a screenshot.
Lead with the answer. Keep it short unless asked for detail. Use light markdown (bold, lists, code blocks) only when it helps.
If the attached content doesn't contain what's needed, say so briefly.`;

// prefs are what the panel changes; limits cap each question. Both live in the settings table.
const THEMES = ['auto', 'ember', 'paper', 'midnight', 'forest', 'dusk', 'sakura', 'terminal'];
const DEFAULT_PREFS = { theme: 'ember', model: 'haiku', web: false };
const LIMIT_RANGES = { maxTokens: [256, 64000], pageTokens: [500, 50000], maxSearches: [1, 10] };
const DEFAULT_LIMITS = { maxTokens: clampInt(process.env.MAX_TOKENS || 2048, ...LIMIT_RANGES.maxTokens), pageTokens: 5000, maxSearches: 3 };
const LOCK_CHOICES = [0, 1, 5, 15, 30, 60, 240, 1440]; // passcode auto-lock after N idle minutes (0 = never)
const MAX_PASSCODE_FAILS = 10; // then only the full password can unlock

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) console.warn('ANTHROPIC_API_KEY is not set — chat will fail.');
if (ADMIN_TOKEN.length < 16) console.warn('ADMIN_TOKEN is missing or under 16 chars — /admin stays locked until you set it.');
if (process.env.PUBLIC_URL) console.warn('PUBLIC_URL is no longer used (the bookmarklet uses the address you open the homepage from). You can delete it.');

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
ALTER TABLE messages ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS web_searches INT NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS refused BOOLEAN NOT NULL DEFAULT false;
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
async function getSettings(keys) {
  const r = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [keys]);
  return Object.fromEntries(r.rows.map(x => [x.key, x.value]));
}
// merges into a JSON setting atomically, so two quick changes can't overwrite each other
async function mergeJSON(key, obj) {
  const r = await pool.query(
    `INSERT INTO settings(key,value) VALUES($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = (settings.value::jsonb || EXCLUDED.value::jsonb)::text RETURNING value`,
    [key, JSON.stringify(obj)]);
  return parseJSON(r.rows[0].value);
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

// ---------- settings ----------
function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
}
function parseJSON(s) {
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function cleanPrefs(p = {}) {
  const o = {};
  if (THEMES.includes(p.theme)) o.theme = p.theme;
  if (typeof p.model === 'string' && Object.hasOwn(MODELS, p.model)) o.model = p.model;
  if (typeof p.web === 'boolean') o.web = p.web;
  return o;
}
function cleanLimits(l = {}) {
  const o = {};
  for (const [k, [lo, hi]] of Object.entries(LIMIT_RANGES)) {
    if (l[k] == null || l[k] === '') continue;
    const n = clampInt(l[k], lo, hi);
    if (n != null) o[k] = n;
  }
  return o;
}
async function loadConfig() {
  const s = await getSettings(['prefs', 'limits', 'password_hash', 'passcode_hash', 'passcode_fails', 'lock_minutes']);
  const minutes = Number(s.lock_minutes ?? 15);
  return {
    prefs: { ...DEFAULT_PREFS, ...cleanPrefs(parseJSON(s.prefs)) },
    limits: { ...DEFAULT_LIMITS, ...cleanLimits(parseJSON(s.limits)) },
    passwordSet: !!s.password_hash,
    lock: {
      on: !!s.passcode_hash,
      hash: s.passcode_hash || null,
      minutes: LOCK_CHOICES.includes(minutes) ? minutes : 15,
      fails: Number(s.passcode_fails) || 0,
    },
  };
}
const modelList = () => Object.entries(MODELS).map(([key, m]) => ({ key, label: m.label }));

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

const bearer = req => (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

// With a passcode set, a session locks after `lock.minutes` idle; otherwise it lasts SESSION_DAYS idle.
async function touchSession(tok, lock) {
  if (!tok) return false;
  const mins = lock.on && lock.minutes ? lock.minutes : SESSION_DAYS * 1440;
  const r = await pool.query(
    `UPDATE sessions SET last_used=now() WHERE token_hash=$1 AND last_used > now() - make_interval(mins => $2) RETURNING 1`,
    [sha256(tok), mins]);
  return r.rowCount > 0;
}
async function auth(req, res, next) {
  const tok = bearer(req);
  if (!tok) return res.status(401).json({ error: 'Not logged in' });
  req.cfg = await loadConfig();
  if (!(await touchSession(tok, req.cfg.lock)))
    return res.status(401).json({ error: req.cfg.lock.on ? 'Locked' : 'Session expired', locked: req.cfg.lock.on });
  next();
}
function admin(req, res, next) {
  if (adminOk(req)) return next();
  res.status(401).json({ error: ADMIN_TOKEN.length < 16 ? 'ADMIN_TOKEN env var is not set on the server (min 16 chars).' : 'Wrong admin token' });
}

setInterval(() => {
  pool.query('DELETE FROM sessions WHERE last_used < now() - make_interval(days => $1)', [SESSION_DAYS]).catch(() => {});
}, 6 * 3600_000).unref();

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));

// The bookmarklet points back at the address you opened the homepage from, which always reaches this server.
const publicOrigin = req => `${req.protocol}://${req.host || process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost'}`;

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
  res.json({ ok: true, models: Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, m.id])) });
});

// everything the panel needs to start: theme and lock type for anyone, prefs once logged in
app.get('/api/boot', limit(60, 'boot'), async (req, res) => {
  const cfg = await loadConfig();
  const tok = bearer(req);
  const authed = !!tok && await touchSession(tok, cfg.lock);
  res.set('Cache-Control', 'no-store').json({
    theme: cfg.prefs.theme,
    lock: cfg.lock.on ? 'passcode' : cfg.passwordSet ? 'password' : 'none',
    passwordSet: cfg.passwordSet,
    lockMinutes: cfg.lock.on ? cfg.lock.minutes : 0,
    authed,
    ...(authed && { prefs: cfg.prefs, limits: cfg.limits, models: modelList() }),
  });
});

// login with the access password or the 5-digit passcode -> session token
app.post('/api/login', limit(10, 'login'), async (req, res) => {
  const b = req.body || {};
  const cfg = await loadConfig();
  if (b.passcode != null) {
    if (!cfg.lock.on) return res.status(400).json({ error: 'No passcode is set — use your password.' });
    const code = String(b.passcode);
    if (!/^\d{5}$/.test(code)) return res.status(400).json({ error: 'Enter all 5 digits.' });
    // count the attempt before checking it, so parallel guesses can't slip past the cap
    const r = await pool.query(
      `INSERT INTO settings(key,value) VALUES('passcode_fails','1')
       ON CONFLICT (key) DO UPDATE SET value = (COALESCE(NULLIF(settings.value,'')::int, 0) + 1)::text RETURNING value`);
    const n = Number(r.rows[0].value);
    if (n > MAX_PASSCODE_FAILS)
      return res.status(423).json({ error: 'Too many wrong passcodes. Unlock with your password.', usePassword: true });
    if (!(await verifyPw(code, cfg.lock.hash))) {
      const left = MAX_PASSCODE_FAILS - n;
      return res.status(401).json({
        error: left <= 0 ? 'Too many wrong passcodes. Unlock with your password.'
          : left <= 3 ? `Wrong passcode — ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Wrong passcode',
        left, usePassword: left <= 0,
      });
    }
  } else {
    const password = String(b.password || '');
    const stored = await getSetting('password_hash');
    if (!stored) return res.status(503).json({ error: 'No password set yet — set one at /admin.' });
    if (!password || !(await verifyPw(password, stored))) return res.status(401).json({ error: 'Wrong password' });
  }
  await setSetting('passcode_fails', '0');
  const old = bearer(req);
  if (old) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(old)]);
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO sessions(token_hash) VALUES($1)', [sha256(token)]);
  res.json({ token });
});

// also used by the panel to lock itself, so an already-expired token is fine here
app.post('/api/logout', limit(30, 'logout'), async (req, res) => {
  const tok = bearer(req);
  if (tok) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(tok)]);
  res.json({ ok: true });
});

// keeps a passcode-locked session alive while the user is typing or scrolling in the panel
app.post('/api/ping', limit(30, 'ping'), auth, (req, res) => res.json({ ok: true }));

app.post('/api/prefs', limit(60, 'prefs'), auth, async (req, res) => {
  const b = req.body || {};
  const p = cleanPrefs(b), l = cleanLimits({ maxTokens: b.maxTokens });
  const prefs = Object.keys(p).length ? { ...DEFAULT_PREFS, ...cleanPrefs(await mergeJSON('prefs', p)) } : req.cfg.prefs;
  const limits = Object.keys(l).length ? { ...DEFAULT_LIMITS, ...cleanLimits(await mergeJSON('limits', l)) } : req.cfg.limits;
  res.json({ prefs, limits });
});

const today = () => new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, dateStyle: 'full' }).format(new Date());
const searchNote = () => `

You can search the web with the web_search tool. The current date is ${today()}. Your training data ends well before today's date. Records, office holders, prices, versions, rules and anything "latest" may have changed since then, so search for those before you answer, even when you feel sure. Facts that can't change need no search. When the answer depends on where the user is, put the user's country or region in the search query.`;

// "claude-sonnet-5-5" -> "Sonnet 5.5"
const modelLabel = id => {
  for (const m of Object.values(MODELS)) if (m.id === id) return m.label;
  const [name, ...v] = String(id || '').replace(/^claude-/, '').split('-');
  return name ? name[0].toUpperCase() + name.slice(1) + (v.length ? ' ' + v.join('.') : '') : 'Claude';
};

function addUsage(tot, u = {}) {
  // with a server-side fallback, iterations holds every attempt; the top level only the last one
  const parts = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u];
  for (const x of parts) {
    tot.in += (x.input_tokens || 0) + (x.cache_read_input_tokens || 0) + (x.cache_creation_input_tokens || 0);
    tot.out += x.output_tokens || 0;
  }
  tot.searches += u.server_tool_use?.web_search_requests || 0;
}

// chat (streams NDJSON: {t:'d',v:text} | {t:'s',q?} search started/query | {t:'done',...} | {t:'err',v})
app.post('/api/chat', limit(60, 'chat'), auth, async (req, res) => {
  const b = req.body || {};
  const { prefs, limits } = req.cfg;
  const modelKey = typeof b.model === 'string' && Object.hasOwn(MODELS, b.model) ? b.model : prefs.model;
  const m = MODELS[modelKey];
  const web = typeof b.web === 'boolean' ? b.web : prefs.web;
  const message = String(b.message || '').slice(0, 8000);
  const page = b.page && typeof b.page === 'object' ? {
    url: String(b.page.url || '').slice(0, 2000),
    title: String(b.page.title || '').slice(0, 300),
    text: String(b.page.text || '').slice(0, limits.pageTokens * 4), // ~4 characters per token
  } : null;
  const selection = String(b.selection || '').slice(0, 8000);

  let image = null;
  if (b.image) {
    const mt = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image));
    if (!mt) return res.status(400).json({ error: 'Bad image data' });
    if (mt[2].length > 8_000_000) return res.status(413).json({ error: 'Screenshot too large' });
    image = { media_type: mt[1], data: mt[2] };
  }
  if (!message && !image && !page && !selection) return res.status(400).json({ error: 'Empty message' });

  // load or create conversation
  let convId = Number.isSafeInteger(b.conversationId) ? b.conversationId : null;
  let history = [];
  if (convId) {
    const c = await pool.query('SELECT 1 FROM conversations WHERE id=$1', [convId]);
    if (c.rowCount) {
      history = (await pool.query(
        'SELECT role, content, had_image FROM messages WHERE conversation_id=$1 AND NOT refused ORDER BY id', [convId])).rows;
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

  const params = {
    model: m.id, max_tokens: limits.maxTokens, system: SYSTEM + (web ? searchNote() : ''), messages,
    output_config: { effort: EFFORT },
  };
  if (web) params.tools = [{ type: m.search, name: 'web_search', max_uses: limits.maxSearches }];
  // Sonnet 5.5 can decline some requests; the API then retries them on the model Anthropic recommends
  const api = m.fallback ? anthropic.beta.messages : anthropic.messages;
  if (m.fallback) Object.assign(params, { betas: [FALLBACK_BETA], fallbacks: 'default' });

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  const out = o => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + '\n'); };

  let stream = null, closed = false;
  res.on('close', () => { if (!res.writableFinished) { closed = true; stream?.abort(); } }); // panel closed -> stop spending tokens

  const tot = { in: 0, out: 0, searches: 0 };
  const sources = new Map();
  let reply = '', final = null;
  try {
    // a long server-side search loop can pause the turn; resend it as-is to let it continue
    for (let hop = 0; hop < 4 && !closed; hop++) {
      stream = api.stream(params);
      stream.on('text', t => { reply += t; out({ t: 'd', v: t }); });
      stream.on('streamEvent', ev => {
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use' && ev.content_block.name === 'web_search') out({ t: 's' });
      });
      stream.on('contentBlock', blk => {
        if (blk.type === 'server_tool_use' && blk.name === 'web_search') {
          const q = blk.input?.query;
          if (q) out({ t: 's', q: String(q).slice(0, 200) });
        }
      });
      final = await stream.finalMessage();
      addUsage(tot, final.usage);
      for (const blk of final.content) {
        if (blk.type !== 'text') continue;
        for (const c of blk.citations || []) {
          if (c.type === 'web_search_result_location' && /^https?:\/\//.test(c.url || '') && !sources.has(c.url))
            sources.set(c.url, String(c.title || '').slice(0, 200));
        }
      }
      if (final.stop_reason !== 'pause_turn') break;
      params.messages = [...params.messages, { role: 'assistant', content: final.content }];
    }
    if (!final) return void res.end();
    const refused = final.stop_reason === 'refusal';
    const replyText = reply.trim() ? reply : refused ? '[declined]' : '(no answer)';
    await pool.query(
      `INSERT INTO messages(conversation_id, role, content, had_image, input_tokens, output_tokens, model, web_searches, refused)
       VALUES ($1,'user',$2,$3,0,0,NULL,0,$4), ($1,'assistant',$5,false,$6,$7,$8,$9,$4)`,
      [convId, userText, !!image, refused, replyText, tot.in, tot.out, final.model || m.id, tot.searches]);
    out({
      t: 'done', conversationId: convId, usage: { in: tot.in, out: tot.out }, stop: final.stop_reason,
      model: modelLabel(final.model || m.id), fallback: !!final.model && final.model !== m.id,
      searches: tot.searches, sources: [...sources].slice(0, 8).map(([url, title]) => ({ url, title })),
      ...(refused && { refusal: final.stop_details?.category || null }),
    });
  } catch (e) {
    if (e?.name !== 'APIUserAbortError') console.error('chat error:', e?.status, e?.message);
    out({ t: 'err', v: friendly(e, m.id) });
  }
  res.end();
});

function friendly(e, model) {
  const s = e?.status;
  if (s === 401) return 'Anthropic API key is invalid (check ANTHROPIC_API_KEY).';
  if (s === 404) return `Model "${model}" not found (check HAIKU_MODEL / SONNET_MODEL).`;
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
      COUNT(*) FILTER (WHERE role = 'user' AND created_at >= ${todayStart})::bigint AS questions_today,
      COALESCE(SUM(web_searches), 0)::bigint AS searches
    FROM messages`, [TIMEZONE])).rows[0];
  const sessions = (await pool.query('SELECT COUNT(*)::bigint AS n FROM sessions')).rows[0].n;
  const cfg = await loadConfig();
  const n = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));
  res.json({
    ...n(m), sessions: Number(sessions), budget: BUDGET, effort: EFFORT,
    models: Object.values(MODELS).map(x => ({ label: x.label, id: x.id })),
    passwordSet: cfg.passwordSet, limits: cfg.limits, limitRanges: LIMIT_RANGES,
    lock: { on: cfg.lock.on, minutes: cfg.lock.minutes, fails: cfg.lock.fails, maxFails: MAX_PASSCODE_FAILS, choices: LOCK_CHOICES },
  });
});

// daily token usage for the chart, in TIMEZONE days
app.get('/api/admin/usage', limit(30, 'admin'), admin, async (req, res) => {
  const days = clampInt(req.query.days || 30, 1, 365);
  const r = await pool.query(`
    WITH bounds AS (SELECT (date_trunc('day', now() AT TIME ZONE $1) - make_interval(days => $2 - 1)) AS start),
    m AS (
      SELECT (created_at AT TIME ZONE $1)::date AS day, role, input_tokens, output_tokens, web_searches, COALESCE(model, '') AS model
      FROM messages WHERE created_at >= (SELECT start FROM bounds) AT TIME ZONE $1
    )
    SELECT d.day::date::text AS day,
      COALESCE(SUM(m.input_tokens), 0)::bigint AS input,
      COALESCE(SUM(m.output_tokens), 0)::bigint AS output,
      COUNT(m.role) FILTER (WHERE m.role = 'user')::bigint AS questions,
      COALESCE(SUM(m.web_searches), 0)::bigint AS searches,
      COALESCE(SUM(m.input_tokens + m.output_tokens) FILTER (WHERE m.model LIKE '%sonnet%'), 0)::bigint AS sonnet
    FROM generate_series((SELECT start FROM bounds), date_trunc('day', now() AT TIME ZONE $1), interval '1 day') AS d(day)
    LEFT JOIN m ON m.day = d.day::date
    GROUP BY d.day ORDER BY d.day`, [TIMEZONE, days]);
  res.json({
    timezone: TIMEZONE,
    days: r.rows.map(x => ({ day: x.day, input: +x.input, output: +x.output, questions: +x.questions, searches: +x.searches, sonnet: +x.sonnet })),
  });
});

app.post('/api/admin/password', limit(20, 'admin'), admin, async (req, res) => {
  const pw = String(req.body?.password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  await setSetting('password_hash', await hashPw(pw));
  const r = await pool.query('DELETE FROM sessions');
  res.json({ ok: true, signedOut: r.rowCount });
});

// set or remove the 5-digit passcode, and/or change how long until the panel locks itself
app.post('/api/admin/passcode', limit(20, 'admin'), admin, async (req, res) => {
  const b = req.body || {};
  if (b.lockMinutes != null) {
    const mins = Number(b.lockMinutes);
    if (!LOCK_CHOICES.includes(mins)) return res.status(400).json({ error: 'Pick one of the listed auto-lock times.' });
    await setSetting('lock_minutes', String(mins));
  }
  if (b.passcode === null) {
    await pool.query(`DELETE FROM settings WHERE key IN ('passcode_hash', 'passcode_fails')`);
  } else if (b.passcode != null) {
    const code = String(b.passcode);
    if (!/^\d{5}$/.test(code)) return res.status(400).json({ error: 'The passcode must be exactly 5 digits.' });
    await setSetting('passcode_hash', await hashPw(code));
    await setSetting('passcode_fails', '0');
  }
  const { lock } = await loadConfig();
  res.json({ ok: true, on: lock.on, minutes: lock.minutes });
});

app.post('/api/admin/limits', limit(20, 'admin'), admin, async (req, res) => {
  const l = cleanLimits(req.body || {});
  if (!Object.keys(l).length) return res.status(400).json({ error: 'Nothing to change.' });
  const limits = { ...DEFAULT_LIMITS, ...cleanLimits(await mergeJSON('limits', l)) };
  res.json({ ok: true, limits });
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
app.listen(PORT, () => console.log(`pagebot listening on :${PORT} (${Object.values(MODELS).map(m => m.id).join(', ')}, effort ${EFFORT})`));

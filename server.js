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
// a third model that runs on your OpenRouter credits instead of Anthropic's; it only shows up once OPENROUTER_API_KEY is set
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
if (OPENROUTER_KEY) {
  const id = process.env.OPENROUTER_MODEL || 'meta/muse-spark-1.3-contributor';
  MODELS.openrouter = { id, label: process.env.OPENROUTER_MODEL ? modelLabel(id) : 'Muse Spark 1.3', openrouter: true };
}
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// both models think by default and thinking counts toward max_tokens; low effort keeps chat replies quick
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'].includes(process.env.EFFORT) ? process.env.EFFORT : 'low';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const BUDGET = Number(process.env.TOKEN_BUDGET) || 200_000_000;
const TIMEZONE = process.env.TIMEZONE || 'America/Denver';
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 30;
const SYSTEM = process.env.SYSTEM_PROMPT ||
  `You are a fast, concise helper running in a small chat panel on top of whatever web page the user is viewing.
The user may attach the page they're viewing (as a document), text they highlighted (<highlighted_text>), and/or a screenshot.
Lead with the answer. Keep it short unless asked for detail. Use light markdown (bold, lists, code blocks) only when it helps.
If the attached content doesn't contain what's needed, say so briefly.`;

// USD per million tokens, from the Anthropic pricing page (October 2026). Used for $ limits and estimates.
const PRICES = {
  'claude-haiku-5-5': { in: 0.10, write: 0.125, read: 0.01, out: 0.50, long: { over: 100_000, in: 0.50, write: 0.625, read: 0.05, out: 2.50 } },
  'claude-sonnet-5-5': { in: 2, write: 2.50, read: 0.10, out: 10 },
  'claude-sonnet-5': { in: 2, write: 2.50, read: 0.20, out: 10 },
  // OpenRouter's price (October 2026). OpenRouter reports what each answer actually cost; this is for estimates.
  'meta/muse-spark-1.3-contributor': { in: 0.10, write: 0.10, read: 0.002, out: 0.20 },
};
const SEARCH_USD = 0.01; // $10 per 1,000 web searches
const SEARCH_TOKENS = 3000; // rough prompt tokens one search's results add, for estimates

// prefs are what the panel changes; limits cap each question. Both live in the settings table.
const THEMES = ['auto', 'ember', 'paper', 'midnight', 'forest', 'dusk', 'sakura', 'terminal', 'glass', 'clear'];
const DEFAULT_PREFS = { theme: 'ember', model: 'haiku', web: false };
const LIMIT_RANGES = { maxTokens: [256, 100000], pageTokens: [500, 50000], maxSearches: [1, 10] }; // no answer may exceed 100,000 tokens
const DEFAULT_LIMITS = { maxTokens: clampInt(process.env.MAX_TOKENS || 2048, ...LIMIT_RANGES.maxTokens), pageTokens: 5000, maxSearches: 3 };
const LOCK_CHOICES = [0, 1, 5, 15, 30, 60, 240, 1440]; // passcode auto-lock after N idle minutes (0 = never)
const MAX_PASSCODE_FAILS = 10; // wrong passcodes within PASSCODE_WINDOW; then only the full password can unlock (the owner's and each account's count separately)
const PASSCODE_WINDOW = 24 * 3600_000; // a right passcode doesn't wipe earlier wrong ones; they expire after a day
const LOGIN_FAILS_PER_IP = 30; // wrong logins one address gets per hour (on top of 10 tries a minute)
const OWNER_FAILS_PER_HOUR = 200; // wrong owner passwords from everywhere before password logins pause
const MAX_ANNOUNCEMENT = 500;

// other people's accounts: they sign up, wait for approval, then use pagebot within a daily limit
const DEFAULT_ACCOUNT = { limitKind: 'tokens', limitValue: 100_000, allowSonnet: true, allowWeb: true };
const DAILY_RANGES = { tokens: [1_000, 100_000_000], usd: [0.01, 1000] };
const RESERVED_NAMES = new Set(['owner', 'admin', 'root', 'pagebot', 'system', 'support']);
const MAX_PENDING = 200;

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
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  admin_note TEXT,
  limit_kind TEXT,
  limit_value NUMERIC,
  allow_sonnet BOOLEAN NOT NULL DEFAULT true,
  allow_web BOOLEAN NOT NULL DEFAULT true,
  prefs TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  last_seen TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS users_name_idx ON users (lower(username));
ALTER TABLE users ADD COLUMN IF NOT EXISTS passcode_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS passcode_fails INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS passcode_fails_at TIMESTAMPTZ; -- when the current run of wrong passcodes started
ALTER TABLE users ADD COLUMN IF NOT EXISTS lock_minutes INT NOT NULL DEFAULT 15;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ann_seen BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS announcements (
  id BIGSERIAL PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hidden_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
CREATE TABLE IF NOT EXISTS conversations (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  page_url TEXT,
  page_title TEXT
);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id BIGINT;
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
ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(14,6);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS incomplete BOOLEAN NOT NULL DEFAULT false;
-- the page sent with a question, as JSON {url, title, text}, so follow-ups can resend it as a citable document
ALTER TABLE messages ADD COLUMN IF NOT EXISTS page_doc TEXT;
-- the theme in use when a question was asked (for Wrapped)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS theme TEXT;
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages (conversation_id, id);
CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at);
CREATE INDEX IF NOT EXISTS messages_user_idx ON messages (user_id, created_at);
-- rough cost for rows saved before costs were tracked (cache reads were counted as plain input then)
UPDATE messages SET cost_usd = CASE WHEN COALESCE(model, '') LIKE '%sonnet%'
    THEN (input_tokens * 2 + output_tokens * 10) / 1e6 ELSE (input_tokens * 0.10 + output_tokens * 0.50) / 1e6 END
  + web_searches * ${SEARCH_USD}
  WHERE cost_usd IS NULL;
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
// a daily limit is { kind: 'tokens' | 'usd', value } or no limit (kind null)
function cleanDaily(kind, value) {
  if (kind == null || kind === '' || kind === 'none') return { kind: null, value: null };
  if (!Object.hasOwn(DAILY_RANGES, kind)) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const [lo, hi] = DAILY_RANGES[kind];
  const v = Math.min(hi, Math.max(lo, n));
  return { kind, value: kind === 'usd' ? Math.round(v * 100) / 100 : Math.round(v) };
}
function cleanAccountDefaults(d = {}) {
  const o = {};
  if ('limitKind' in d) {
    const l = cleanDaily(d.limitKind, d.limitValue);
    if (l) { o.limitKind = l.kind; o.limitValue = l.value; }
  }
  if (typeof d.allowSonnet === 'boolean') o.allowSonnet = d.allowSonnet;
  if (typeof d.allowWeb === 'boolean') o.allowWeb = d.allowWeb;
  return o;
}
// stored as "count:first wrong guess (ms)"; once the cap is hit it stays until a password login
function passcodeFails(v) {
  const [n, since] = String(v || '').split(':').map(Number);
  return n >= MAX_PASSCODE_FAILS || since > Date.now() - PASSCODE_WINDOW ? n || 0 : 0;
}
async function loadConfig() {
  const s = await getSettings(['prefs', 'limits', 'password_hash', 'passcode_hash', 'passcode_fails', 'lock_minutes', 'signup', 'account_defaults']);
  const minutes = Number(s.lock_minutes ?? 15);
  return {
    prefs: { ...DEFAULT_PREFS, ...cleanPrefs(parseJSON(s.prefs)) },
    limits: { ...DEFAULT_LIMITS, ...cleanLimits(parseJSON(s.limits)) },
    passwordSet: !!s.password_hash,
    lock: {
      on: !!s.passcode_hash,
      hash: s.passcode_hash || null,
      minutes: LOCK_CHOICES.includes(minutes) ? minutes : 15,
      fails: passcodeFails(s.passcode_fails),
    },
    signup: s.signup !== '0',
    accountDefaults: { ...DEFAULT_ACCOUNT, ...cleanAccountDefaults(parseJSON(s.account_defaults)) },
  };
}
const modelList = () => Object.entries(MODELS).map(([key, m]) => ({ key, label: m.label }));

// ---------- accounts ----------
function toUser(r) {
  return {
    id: Number(r.id), name: r.username, status: r.status, note: r.note || '', adminNote: r.admin_note || '',
    limitKind: r.limit_kind || null, limitValue: r.limit_value == null ? null : Number(r.limit_value),
    allowSonnet: r.allow_sonnet, allowWeb: r.allow_web, prefs: parseJSON(r.prefs),
    createdAt: r.created_at, approvedAt: r.approved_at, lastSeen: r.last_seen,
    passcode: !!r.passcode_hash, lockMinutes: LOCK_CHOICES.includes(Number(r.lock_minutes)) ? Number(r.lock_minutes) : 15,
    annSeen: Number(r.ann_seen) || 0,
  };
}
// what the panel shows for an account (never the owner's private note)
const publicUser = u => ({ name: u.name, status: u.status, allowSonnet: u.allowSonnet, allowWeb: u.allowWeb, passcode: u.passcode, lockMinutes: u.lockMinutes });
// an account with a passcode locks after its own idle time, like the owner's panel
const userLockMinutes = u => u?.passcode ? u.lockMinutes : 0;
// accounts get their own theme/model/web/answer length; their answer length can't go past the owner's limit
function prefsFor(cfg, u) {
  if (!u) return cfg.prefs;
  const p = { ...DEFAULT_PREFS, theme: cfg.prefs.theme, ...cleanPrefs(u.prefs) };
  if (!u.allowSonnet) p.model = 'haiku';
  if (!u.allowWeb) p.web = false;
  return p;
}
function limitsFor(cfg, u) {
  const cap = u ? cfg.limits.maxTokens : LIMIT_RANGES.maxTokens[1];
  const mine = u ? clampInt(u.prefs.maxTokens ?? cfg.limits.maxTokens, LIMIT_RANGES.maxTokens[0], cap) : cfg.limits.maxTokens;
  return { ...cfg.limits, maxTokens: mine, maxTokensCap: cap };
}
const modelsFor = u => modelList().map(m => ({ ...m, locked: !!u && m.key === 'sonnet' && !u.allowSonnet }));

const todayStartSQL = `date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2`;
async function usageToday(userId) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens, COALESCE(SUM(cost_usd), 0)::float8 AS usd,
       COUNT(*) FILTER (WHERE role = 'user')::int AS questions
     FROM messages WHERE user_id = $1 AND created_at >= ${todayStartSQL}`, [userId, TIMEZONE]);
  return { tokens: Number(r.rows[0].tokens), usd: Number(r.rows[0].usd), questions: r.rows[0].questions };
}
// how much of today's limit an account has used (null when it has no limit)
function quota(u, used) {
  if (!u?.limitKind) return null;
  const spent = u.limitKind === 'usd' ? used.usd : used.tokens;
  return { kind: u.limitKind, limit: u.limitValue, used: spent, left: Math.max(0, u.limitValue - spent) };
}
const fmtLimit = (kind, v) => kind === 'usd' ? `$${Number(v).toFixed(2)}` : `${v >= 1000 ? Math.round(v / 100) / 10 + 'K' : v} tokens`;

// Announcements: everyone with an account sees the newest one until they dismiss it.
// Posting a new one replaces it; taking it down hides it without bringing back an older one.
async function currentAnnouncement() {
  const a = (await pool.query('SELECT id, body, created_at, hidden_at FROM announcements ORDER BY id DESC LIMIT 1')).rows[0];
  return a && !a.hidden_at ? { id: Number(a.id), body: a.body, createdAt: a.created_at } : null;
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
// checked against unknown usernames too, so response times don't reveal which accounts exist
const dummyHash = hashPw(crypto.randomBytes(16).toString('hex'));
function adminOk(req) {
  if (ADMIN_TOKEN.length < 16) return false;
  const a = Buffer.from(sha256(req.get('x-admin-token') || ''), 'hex');
  const b = Buffer.from(sha256(ADMIN_TOKEN), 'hex');
  return crypto.timingSafeEqual(a, b);
}

// ---------- middleware ----------
// sliding-window counters (in memory): requests per address, and wrong logins
const hits = new Map();
function take(key, max, win) { // counts a hit unless the window is already full
  const now = Date.now(), e = hits.get(key) || { win, t: [] };
  e.t = e.t.filter(t => now - t < win);
  hits.set(key, e);
  if (e.t.length >= max) return false;
  e.t.push(now); return true;
}
const recent = key => { const e = hits.get(key), now = Date.now(); return e ? e.t.filter(t => now - t < e.win).length : 0; };
const limit = (max, bucket, win = 60_000) => (req, res, next) => take(bucket + ':' + req.ip, max, win) ? next()
  : res.status(429).json({ error: win > 60_000 ? 'Too many requests from here — try again later.' : 'Too many requests — wait a minute.' });
setInterval(() => { const now = Date.now(); for (const [k, e] of hits) if (!e.t.some(t => now - t < e.win)) hits.delete(k); }, 300_000).unref();

// wrong passwords and passcodes: each address gets LOGIN_FAILS_PER_IP an hour, and a flood of wrong owner
// passwords from many addresses pauses owner password logins until it dies down
const tooManyFails = req => recent('fail:' + req.ip) >= LOGIN_FAILS_PER_IP;
function noteFail(req, owner) {
  take('fail:' + req.ip, Infinity, 3600_000);
  if (owner) take('fail:owner', Infinity, 3600_000);
}
const FAILS_MSG = 'Too many wrong tries from here. Try again later.';

const bearer = req => (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

// Sessions with a passcode behind them (the owner's, or an account's) lock after that passcode's idle time;
// everything else stays signed in for SESSION_DAYS.
// Returns { user } (null user = the owner), or null when the token is unknown or expired.
async function touchSession(tok, lock) {
  if (!tok) return null;
  const ownerMins = lock.on && lock.minutes ? lock.minutes : SESSION_DAYS * 1440;
  const r = await pool.query(
    `UPDATE sessions s SET last_used=now() WHERE s.token_hash=$1
       AND s.last_used > now() - make_interval(mins => CASE WHEN s.user_id IS NULL THEN $2::int ELSE COALESCE(
         (SELECT u.lock_minutes FROM users u WHERE u.id = s.user_id AND u.passcode_hash IS NOT NULL AND u.lock_minutes > 0), $3::int) END)
     RETURNING user_id`, [sha256(tok), ownerMins, SESSION_DAYS * 1440]);
  if (!r.rowCount) return null;
  const uid = r.rows[0].user_id;
  if (uid == null) return { user: null };
  const u = await pool.query('UPDATE users SET last_seen=now() WHERE id=$1 RETURNING *', [uid]);
  return u.rowCount ? { user: toUser(u.rows[0]) } : null;
}
async function newSession(userId = null) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO sessions(token_hash, user_id) VALUES($1, $2)', [sha256(token), userId]);
  return token;
}
async function auth(req, res, next) {
  const tok = bearer(req);
  if (!tok) return res.status(401).json({ error: 'Not logged in' });
  req.cfg = await loadConfig();
  const s = await touchSession(tok, req.cfg.lock);
  if (!s) return res.status(401).json({ error: req.cfg.lock.on ? 'Locked' : 'Session expired', locked: req.cfg.lock.on });
  req.user = s.user;
  next();
}
// asking questions needs the owner or an approved ("trusted") account
function trusted(req, res, next) {
  const u = req.user;
  if (!u || u.status === 'trusted') return next();
  res.status(403).json({
    error: u.status === 'blocked' ? 'Your access has been turned off.' : 'You’re waiting to be accepted into the program.',
    status: u.status,
  });
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
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
// small bodies everywhere; a question with a screenshot can be big, so /api/chat reads its body only after checking the login
const chatJson = express.json({ limit: '12mb' }), smallJson = express.json({ limit: '64kb' });
app.use((req, res, next) => req.path === '/api/chat' ? next() : smallJson(req, res, next));

// The bookmarklet points back at the address you opened the homepage from, which always reaches this server.
// Only a plain host name is accepted, and the page isn't stored by caches, so a forged header only affects its own response.
const HOST_RE = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/i;
const publicOrigin = req => `${req.protocol === 'https' ? 'https' : 'http'}://${HOST_RE.test(req.host || '') ? req.host : process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost'}`;

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bookmarkletSrc = fs.readFileSync(path.join(__dirname, 'bookmarklet.js'), 'utf8');

// Pages run only their own inline scripts (allowed by hash), talk only to this server, and load images only from here,
// so even if a page or a model's answer slipped markup into the panel it couldn't run code or send anything out.
const pageCache = new Map();
function page(file) {
  const p = path.join(PUB, file), mtime = fs.statSync(p).mtimeMs;
  let c = pageCache.get(file);
  if (!c || c.mtime !== mtime) {
    const html = fs.readFileSync(p, 'utf8');
    const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
    c = { mtime, html, scripts: hashes.join(' ') || "'none'" };
    pageCache.set(file, c);
  }
  return c;
}
function sendPage(res, file, { frames = "'none'", html = s => s, headers = {} } = {}) {
  const c = page(file);
  res.set({
    'Content-Security-Policy': `default-src 'self'; script-src ${c.scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; ` +
      `media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${frames}`,
    'Cache-Control': 'no-cache',
    ...(frames === "'none'" && { 'Cross-Origin-Opener-Policy': 'same-origin' }),
    ...headers,
  }).type('html').send(html(c.html));
}

app.get(['/', '/install'], (req, res) => {
  const origin = publicOrigin(req);
  const code = bookmarkletSrc.replaceAll('__ORIGIN__', origin).replace(/\n\s*/g, '');
  const href = 'javascript:' + encodeURIComponent(code);
  sendPage(res, 'install.html', {
    headers: { 'Cache-Control': 'no-store', Vary: 'Host, X-Forwarded-Host, X-Forwarded-Proto' },
    html: s => s.replaceAll('{{HREF}}', () => escHtml(href)).replaceAll('{{ORIGIN}}', () => escHtml(origin)),
  });
});
// the panel loads inside any site's page (that's what the bookmarklet does); everything else refuses to be framed
app.get('/widget', (req, res) => sendPage(res, 'widget.html', { frames: '*' }));
app.get('/chat', (req, res) => sendPage(res, 'widget.html'));
app.get('/admin', (req, res) => sendPage(res, 'admin.html'));

app.get('/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, models: Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, m.id])) });
});

// everything the panel needs to start: theme and how to unlock for anyone, the rest once signed in
app.get('/api/boot', limit(60, 'boot'), async (req, res) => {
  const cfg = await loadConfig();
  const tok = bearer(req);
  const s = tok ? await touchSession(tok, cfg.lock) : null;
  const u = s?.user || null;
  const accountsExist = cfg.signup || (await pool.query(`SELECT 1 FROM users WHERE status <> 'pending' LIMIT 1`)).rowCount > 0;
  const out = {
    theme: prefsFor(cfg, u).theme,
    lock: cfg.lock.on ? 'passcode' : cfg.passwordSet ? 'password' : 'none',
    passwordSet: cfg.passwordSet,
    accounts: { on: accountsExist, signup: cfg.signup },
    authed: !!s,
  };
  res.set('Cache-Control', 'no-store');
  if (!s) return res.json(out);
  if (!u) return res.json({ ...out, who: 'owner', lockMinutes: cfg.lock.on ? cfg.lock.minutes : 0, prefs: cfg.prefs, limits: limitsFor(cfg, null), models: modelList() });
  out.who = 'user'; out.lockMinutes = userLockMinutes(u); out.lockChoices = LOCK_CHOICES; out.user = publicUser(u);
  if (u.status === 'trusted') {
    const a = await currentAnnouncement();
    Object.assign(out, {
      prefs: prefsFor(cfg, u), limits: limitsFor(cfg, u), models: modelsFor(u), quota: quota(u, await usageToday(u.id)),
      announcement: a && a.id > u.annSeen ? a : null,
    });
  }
  res.json(out);
});

// anyone can ask to join; the account waits until the owner approves it in /admin
app.post('/api/signup', limit(5, 'signup'), limit(30, 'signup-hour', 3600_000), async (req, res) => {
  const cfg = await loadConfig();
  if (!cfg.signup) return res.status(403).json({ error: 'Sign-ups are closed right now.' });
  const b = req.body || {};
  const name = String(b.username || '').trim();
  const pw = String(b.password || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,23}$/.test(name))
    return res.status(400).json({ error: 'Pick a username of 3–24 letters, numbers, dots, dashes or underscores.' });
  if (RESERVED_NAMES.has(name.toLowerCase())) return res.status(400).json({ error: 'That username is taken.' });
  if (pw.length < 6 || pw.length > 200) return res.status(400).json({ error: 'Use a password with at least 6 characters.' });
  const pending = (await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE status = 'pending'`)).rows[0].n;
  if (pending >= MAX_PENDING) return res.status(429).json({ error: 'Too many people are waiting already. Try again later.' });
  let id;
  try {
    id = (await pool.query('INSERT INTO users(username, password_hash, note) VALUES($1, $2, $3) RETURNING id',
      [name, await hashPw(pw), String(b.note || '').trim().slice(0, 300) || null])).rows[0].id;
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is taken.' });
    throw e;
  }
  res.json({ token: await newSession(Number(id)) });
});

function wrongPasscode(res, n) {
  const left = MAX_PASSCODE_FAILS - n;
  return res.status(401).json({
    error: left <= 0 ? 'Too many wrong passcodes. Unlock with your password.'
      : left <= 3 ? `Wrong passcode — ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Wrong passcode',
    left, usePassword: left <= 0,
  });
}
const tooManyPasscodes = res => res.status(423).json({ error: 'Too many wrong passcodes. Unlock with your password.', usePassword: true });

// log in with the owner's password or passcode, or with an account's username and its password or passcode
app.post('/api/login', limit(10, 'login'), async (req, res) => {
  if (tooManyFails(req)) return res.status(429).json({ error: FAILS_MSG });
  const b = req.body || {};
  const old = bearer(req);
  if (b.username) {
    const r = await pool.query('SELECT id, password_hash, passcode_hash, status FROM users WHERE lower(username) = lower($1)', [String(b.username).trim()]);
    const u = r.rows[0];
    if (b.passcode != null) {
      const code = String(b.passcode);
      if (!/^\d{5}$/.test(code)) return res.status(400).json({ error: 'Enter all 5 digits.' });
      if (!u?.passcode_hash) { noteFail(req); return res.status(401).json({ error: 'There’s no passcode on this account. Sign in with your password.', usePassword: true }); }
      // Same rules as the owner's passcode: count the attempt before checking it, so parallel guesses can't slip past
      // the cap, and wrong guesses stay on record for a day even if the right passcode is used in between.
      const n = (await pool.query(
        `UPDATE users SET
           passcode_fails = CASE WHEN passcode_fails_at > now() - $2::float8 * interval '1 millisecond' OR passcode_fails >= $3 THEN passcode_fails + 1 ELSE 1 END,
           passcode_fails_at = CASE WHEN passcode_fails_at > now() - $2::float8 * interval '1 millisecond' OR passcode_fails >= $3 THEN COALESCE(passcode_fails_at, now()) ELSE now() END
         WHERE id = $1 RETURNING passcode_fails`, [u.id, PASSCODE_WINDOW, MAX_PASSCODE_FAILS])).rows[0].passcode_fails;
      if (n > MAX_PASSCODE_FAILS) return tooManyPasscodes(res);
      if (!(await verifyPw(code, u.passcode_hash))) { noteFail(req); return wrongPasscode(res, n); }
      // the right passcode: take back this attempt's count, but keep the wrong ones
      await pool.query('UPDATE users SET passcode_fails = GREATEST(passcode_fails - 1, 0) WHERE id = $1', [u.id]);
    } else {
      const ok = await verifyPw(String(b.password || ''), u?.password_hash || await dummyHash);
      if (!u || !ok) { noteFail(req); return res.status(401).json({ error: 'Wrong username or password.' }); }
    }
    if (u.status === 'blocked') return res.status(403).json({ error: 'This account has been turned off.' });
    if (b.passcode == null) await pool.query('UPDATE users SET passcode_fails = 0, passcode_fails_at = NULL WHERE id = $1', [u.id]); // the password clears wrong passcodes
    if (old) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(old)]);
    return res.json({ token: await newSession(Number(u.id)) });
  }
  const cfg = await loadConfig();
  if (b.passcode != null) {
    if (!cfg.lock.on) return res.status(400).json({ error: 'No passcode is set — use your password.', usePassword: true });
    const code = String(b.passcode);
    if (!/^\d{5}$/.test(code)) return res.status(400).json({ error: 'Enter all 5 digits.' });
    // Count the attempt before checking it, so parallel guesses can't slip past the cap. Wrong guesses stay on
    // record for a day even if the right passcode is used in between; hitting the cap needs the password.
    const now = Date.now();
    const r = await pool.query(
      `INSERT INTO settings(key, value) VALUES ('passcode_fails', '1:' || $1)
       ON CONFLICT (key) DO UPDATE SET value = CASE
         WHEN COALESCE(NULLIF(split_part(settings.value, ':', 2), '')::bigint, 0) > $2::bigint
           OR COALESCE(NULLIF(split_part(settings.value, ':', 1), '')::int, 0) >= $3::int
         THEN (COALESCE(NULLIF(split_part(settings.value, ':', 1), '')::int, 0) + 1)::text || ':' || COALESCE(NULLIF(split_part(settings.value, ':', 2), ''), $1)
         ELSE '1:' || $1 END
       RETURNING value`, [String(now), now - PASSCODE_WINDOW, MAX_PASSCODE_FAILS]);
    const n = parseInt(r.rows[0].value, 10);
    if (n > MAX_PASSCODE_FAILS) return tooManyPasscodes(res);
    if (!(await verifyPw(code, cfg.lock.hash))) { noteFail(req); return wrongPasscode(res, n); }
    // the right passcode: take back this attempt's count, but keep the wrong ones
    await pool.query(
      `UPDATE settings SET value = (split_part(value, ':', 1)::int - 1)::text || ':' || split_part(value, ':', 2)
       WHERE key = 'passcode_fails' AND CASE WHEN split_part(value, ':', 1) ~ '^[0-9]+$' THEN split_part(value, ':', 1)::int > 0 ELSE false END`);
  } else {
    if (recent('fail:owner') >= OWNER_FAILS_PER_HOUR)
      return res.status(429).json({ error: 'Password logins are paused after a lot of wrong tries. Try again later, or use your passcode.' });
    const password = String(b.password || '');
    const stored = await getSetting('password_hash');
    if (!stored) return res.status(503).json({ error: 'No password set yet — set one at /admin.' });
    if (!password || !(await verifyPw(password, stored))) { noteFail(req, true); return res.status(401).json({ error: 'Wrong password' }); }
    await setSetting('passcode_fails', '0'); // the password clears wrong passcodes
  }
  if (old) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(old)]);
  res.json({ token: await newSession() });
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
  const b = req.body || {}, u = req.user, cfg = req.cfg;
  if (!u) { // the owner's settings apply everywhere, and the answer limit is the shared one
    const p = cleanPrefs(b), l = cleanLimits({ maxTokens: b.maxTokens });
    if (Object.keys(p).length) cfg.prefs = { ...DEFAULT_PREFS, ...cleanPrefs(await mergeJSON('prefs', p)) };
    if (Object.keys(l).length) cfg.limits = { ...DEFAULT_LIMITS, ...cleanLimits(await mergeJSON('limits', l)) };
    return res.json({ prefs: cfg.prefs, limits: limitsFor(cfg, null) });
  }
  const p = cleanPrefs(b);
  if (p.model === 'sonnet' && !u.allowSonnet) delete p.model;
  if (p.web && !u.allowWeb) delete p.web;
  if (b.maxTokens != null) {
    const n = clampInt(b.maxTokens, LIMIT_RANGES.maxTokens[0], cfg.limits.maxTokens);
    if (n != null) p.maxTokens = n;
  }
  if (Object.keys(p).length) {
    const r = await pool.query('UPDATE users SET prefs = (prefs::jsonb || $2::jsonb)::text WHERE id = $1 RETURNING prefs', [u.id, JSON.stringify(p)]);
    u.prefs = parseJSON(r.rows[0].prefs);
  }
  res.json({ prefs: prefsFor(cfg, u), limits: limitsFor(cfg, u) });
});

// accounts can change their own password (other devices get signed out)
app.post('/api/account/password', limit(10, 'login'), auth, async (req, res) => {
  if (tooManyFails(req)) return res.status(429).json({ error: FAILS_MSG });
  const u = req.user;
  if (!u) return res.status(400).json({ error: 'Change the owner password in /admin.' });
  const b = req.body || {};
  const pw = String(b.password || '');
  if (pw.length < 6 || pw.length > 200) return res.status(400).json({ error: 'Use a password with at least 6 characters.' });
  const row = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [u.id])).rows[0];
  if (!(await verifyPw(String(b.current || ''), row.password_hash))) { noteFail(req); return res.status(401).json({ error: 'Your current password is wrong.' }); }
  // the passcode goes too: it would otherwise sign the devices this signs out straight back in
  const r = await pool.query('UPDATE users SET password_hash=$2, passcode_hash=NULL, passcode_fails=0, passcode_fails_at=NULL WHERE id=$1 RETURNING *',
    [u.id, await hashPw(pw)]);
  await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash <> $2', [u.id, sha256(bearer(req))]);
  const nu = toUser(r.rows[0]);
  res.json({ ok: true, user: publicUser(nu), lockMinutes: userLockMinutes(nu) });
});

// accounts can have their own passcode, like the owner's: 5 digits instead of the password, plus an idle lock.
// Setting or changing it takes the account password; turning it off or changing the lock time doesn't.
app.post('/api/account/passcode', limit(10, 'login'), auth, trusted, async (req, res) => {
  if (tooManyFails(req)) return res.status(429).json({ error: FAILS_MSG });
  const u = req.user;
  if (!u) return res.status(400).json({ error: 'Set the owner passcode in /admin.' });
  const b = req.body || {};
  const set = {};
  if (b.lockMinutes != null) {
    const mins = Number(b.lockMinutes);
    if (!LOCK_CHOICES.includes(mins)) return res.status(400).json({ error: 'Pick one of the listed auto-lock times.' });
    set.lock_minutes = mins;
  }
  if (b.passcode === null) Object.assign(set, { passcode_hash: null, passcode_fails: 0, passcode_fails_at: null });
  else if (b.passcode != null) {
    const code = String(b.passcode);
    if (!/^\d{5}$/.test(code)) return res.status(400).json({ error: 'The passcode must be exactly 5 digits.' });
    const row = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [u.id])).rows[0];
    // 400, not 401: the panel treats 401 as "signed out"
    if (!(await verifyPw(String(b.current || ''), row.password_hash))) { noteFail(req); return res.status(400).json({ error: 'Your password is wrong.' }); }
    Object.assign(set, { passcode_hash: await hashPw(code), passcode_fails: 0, passcode_fails_at: null });
  }
  const keys = Object.keys(set);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to change.' });
  const r = await pool.query(`UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [u.id, ...keys.map(k => set[k])]);
  const nu = toUser(r.rows[0]);
  res.json({ ok: true, user: publicUser(nu), lockMinutes: userLockMinutes(nu) });
});

// an account closed the announcement banner (older ones count as seen too)
app.post('/api/announcements/seen', limit(30, 'prefs'), auth, async (req, res) => {
  const id = clampInt(req.body?.id, 0, Number.MAX_SAFE_INTEGER);
  if (req.user && id) await pool.query('UPDATE users SET ann_seen = GREATEST(ann_seen, $2) WHERE id = $1', [req.user.id, id]);
  res.json({ ok: true });
});

const today = () => new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, dateStyle: 'full' }).format(new Date());
const searchNote = () => `

You can search the web with the web_search tool. The current date is ${today()}. Your training data ends well before today's date. Records, office holders, prices, versions, rules and anything "latest" may have changed since then, so search for those before you answer, even when you feel sure. Facts that can't change need no search. When the answer depends on where the user is, put the user's country or region in the search query.`;

// "claude-sonnet-5-5" -> "Sonnet 5.5"; OpenRouter's "meta/muse-spark-1.3" -> "Muse Spark 1.3"
function modelLabel(id) {
  for (const m of Object.values(MODELS)) if (m.id === id) return m.label;
  const s = String(id || '');
  if (s.includes('/')) return s.split('/').pop().split(/[-_]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  const [name, ...v] = s.replace(/^claude-/, '').split('-');
  return name ? name[0].toUpperCase() + name.slice(1) + (v.length ? ' ' + v.join('.') : '') : 'Claude';
}

const priceFor = id => PRICES[id] || (/haiku/.test(id) ? PRICES['claude-haiku-5-5'] : /sonnet-5$/.test(id) ? PRICES['claude-sonnet-5'] : PRICES['claude-sonnet-5-5']);
function tokenCost(model, x) {
  let p = priceFor(model);
  const prompt = (x.input_tokens || 0) + (x.cache_read_input_tokens || 0) + (x.cache_creation_input_tokens || 0);
  if (p.long && prompt > p.long.over) p = p.long; // Haiku 5.5 costs more once a prompt passes 100K tokens
  return ((x.input_tokens || 0) * p.in + (x.cache_creation_input_tokens || 0) * p.write
    + (x.cache_read_input_tokens || 0) * p.read + (x.output_tokens || 0) * p.out) / 1e6;
}
// tokens and dollars for one API response; with a fallback, `iterations` lists every attempt
function addUsage(tot, msg, requested) {
  const u = msg.usage || {};
  const parts = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u];
  for (const x of parts) {
    tot.in += (x.input_tokens || 0) + (x.cache_read_input_tokens || 0) + (x.cache_creation_input_tokens || 0);
    tot.out += x.output_tokens || 0;
    tot.usd += tokenCost(x.model || (x.type === 'fallback_message' ? msg.model : requested), x);
  }
  const searches = u.server_tool_use?.web_search_requests || 0;
  tot.searches += searches;
  tot.usd += searches * SEARCH_USD;
}
// Usage for a response cut short, from the SDK's snapshot of it. The prompt's tokens came with message_start, but
// output and searches are only totaled at the end, so they're estimated from what streamed in: about 3 characters
// a token, plus the searches that finished, each adding SEARCH_TOKENS of results to the prompt.
function cutUsage(msg) {
  if (msg.stop_reason) return msg; // the closing message_delta arrived, so the totals are in
  let chars = 0, searches = 0;
  for (const b of msg.content) {
    if (b.type === 'text') chars += (b.text || '').length;
    else if (b.type === 'thinking') chars += (b.thinking || '').length;
    else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) searches++; // failed searches aren't billed
  }
  const u = msg.usage || {};
  return {
    usage: {
      input_tokens: (u.input_tokens || 0) + searches * SEARCH_TOKENS,
      cache_creation_input_tokens: u.cache_creation_input_tokens, cache_read_input_tokens: u.cache_read_input_tokens,
      output_tokens: Math.max(u.output_tokens || 0, Math.ceil(chars / 3)),
      server_tool_use: { web_search_requests: searches },
    },
  };
}

// OpenRouter reports its own charge (`cost`, in dollars, searches included) with the usage
function addRouterUsage(tot, u, model) {
  const i = u.prompt_tokens || 0, o = u.completion_tokens || 0, searches = u.server_tool_use?.web_search_requests || 0;
  tot.in += i; tot.out += o; tot.searches += searches;
  tot.usd += typeof u.cost === 'number' ? u.cost : tokenCost(model, { input_tokens: i, output_tokens: o }) + searches * SEARCH_USD;
}
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ROUTER_STOP = { stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal' };
const routerError = (status, body) => Object.assign(new Error(String(body?.error?.message || `OpenRouter error ${status}`)), { status, router: true });
// One answer from OpenRouter: OpenAI-style chat completions, streamed as server-sent events. `s` fills in as it
// streams (whether it got going, its usage, the web pages it cites), so an answer that breaks off still counts.
async function askRouter(body, signal, s, onText) {
  const r = await fetch(OPENROUTER_URL, {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'pagebot' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!r.ok) throw routerError(r.status, await r.json().catch(() => null));
  s.started = true;
  const dec = new TextDecoder();
  let buf = '', finish = null;
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue; // blank lines and ": OPENROUTER PROCESSING" keep-alives
      const data = line.slice(5).trim();
      let ev;
      try { ev = JSON.parse(data); } catch { continue; } // the closing [DONE] too
      if (ev.error) throw routerError(ev.error.code, ev); // an error after the answer started comes as an event
      if (ev.usage) s.usage = ev.usage; // with the last event
      const c = ev.choices?.[0];
      if (c?.finish_reason) finish = c.finish_reason;
      for (const a of c?.delta?.annotations || []) if (a?.type === 'url_citation' && a.url_citation) s.sources.push(a.url_citation);
      if (c?.delta?.content) onText(c.delta.content);
    }
  }
  return { model: body.model, stop_reason: ROUTER_STOP[finish] || finish || 'end_turn' };
}

// chat (streams NDJSON: {t:'id',conversationId} first | {t:'d',v:text} | {t:'s',q?} search started/query | {t:'done',...} | {t:'err',v,conversationId?})
// Accounts get one answer at a time, so a burst of parallel questions can't all slip under the daily limit.
const answering = new Set();
app.post('/api/chat', limit(60, 'chat'), auth, trusted, chatJson, async (req, res) => {
  const id = req.user?.id;
  if (id != null) {
    if (answering.has(id)) return res.status(429).json({ error: 'Your last question is still being answered. Try again once it finishes.' });
    answering.add(id);
  }
  try { await chat(req, res); } finally { if (id != null) answering.delete(id); }
});

// highlighted text can't open or close the tags that mark where it starts and ends
const fence = s => s.replace(/<(\/?)(page|highlighted_text)\b/gi, '&lt;$1$2');

async function chat(req, res) {
  const b = req.body || {}, u = req.user, cfg = req.cfg;
  const prefs = prefsFor(cfg, u), limits = limitsFor(cfg, u);
  let modelKey = typeof b.model === 'string' && Object.hasOwn(MODELS, b.model) ? b.model : prefs.model;
  if (u && modelKey === 'sonnet' && !u.allowSonnet) modelKey = 'haiku';
  const m = MODELS[modelKey];
  const web = (typeof b.web === 'boolean' ? b.web : prefs.web) && (!u || u.allowWeb);

  // accounts with a daily limit stop once today's usage reaches it (it resets at midnight in TIMEZONE)
  const used = u?.limitKind ? await usageToday(u.id) : null;
  const q0 = used && quota(u, used);
  if (q0 && q0.left <= 0)
    return res.status(429).json({ error: `You’ve used today’s limit of ${fmtLimit(q0.kind, q0.limit)}. It resets at midnight.`, quota: q0 });

  const message = String(b.message || '').slice(0, 8000);
  const page = b.page && typeof b.page === 'object' ? {
    url: String(b.page.url || '').slice(0, 2000),
    title: String(b.page.title || '').slice(0, 300),
    text: String(b.page.text || '').slice(0, limits.pageTokens * 4), // ~4 characters per token; it goes in a document block
  } : null;
  const selection = fence(String(b.selection || '').slice(0, 8000));

  let image = null;
  if (b.image) {
    const mt = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image));
    if (!mt) return res.status(400).json({ error: 'Bad image data' });
    if (mt[2].length > 8_000_000) return res.status(413).json({ error: 'Screenshot too large' });
    image = { media_type: mt[1], data: mt[2] };
  }
  if (!message && !image && !page && !selection) return res.status(400).json({ error: 'Empty message' });

  // load the conversation (only your own)
  const uid = u?.id ?? null; // null = the owner
  let convId = Number.isSafeInteger(b.conversationId) ? b.conversationId : null;
  let history = [];
  if (convId) {
    const c = await pool.query('SELECT 1 FROM conversations WHERE id=$1 AND user_id IS NOT DISTINCT FROM $2', [convId, uid]);
    if (c.rowCount) {
      history = (await pool.query(
        'SELECT role, content, had_image, page_doc FROM messages WHERE conversation_id=$1 AND NOT refused ORDER BY id', [convId])).rows;
    } else convId = null;
  }

  // The page goes in as a document so answers can quote it. With `cite` (bookmarklets that can find text on the
  // page), the API marks which passages back each part of the answer, and the panel can point at them.
  const cite = b.cite === true;
  const doc = page?.text.trim() ? page : null;
  const attr = s => s.replace(/"/g, '&quot;');
  // OpenRouter models take the page as plain text in <page> tags instead (no citations there)
  const docBlock = d => m.openrouter ? { type: 'text', text: `<page url="${attr(d.url || '')}" title="${attr(d.title || '')}">\n${fence(d.text)}\n</page>` } : {
    type: 'document', source: { type: 'text', media_type: 'text/plain', data: d.text },
    title: (d.title || d.url || 'Web page').slice(0, 300), ...(d.url && { context: `URL: ${d.url}` }),
    citations: { enabled: cite },
  };

  // build this turn's text
  const parts = [];
  if (page && !doc) parts.push(`<page url="${attr(page.url)}" title="${attr(page.title)}"></page>`);
  if (selection) parts.push(`<highlighted_text>\n${selection}\n</highlighted_text>`);
  parts.push(message || (image ? 'Help me with what is in this screenshot.' : selection ? 'Explain the highlighted text.' : 'Summarize this page.'));
  const userText = parts.join('\n\n');

  // old screenshots are not resent (saves tokens) — a note stands in for them. Pages are resent as documents.
  const messages = history.map(h => {
    const text = h.had_image ? `[A screenshot was attached to this message; it is no longer available.]\n\n${h.content}` : h.content;
    const d = h.page_doc && parseJSON(h.page_doc);
    return { role: h.role, content: d?.text ? [docBlock(d), { type: 'text', text }] : text };
  });
  const cur = [];
  if (image) cur.push(m.openrouter ? { type: 'image_url', image_url: { url: `data:${image.media_type};base64,${image.data}` } }
    : { type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } });
  if (doc) cur.push(docBlock(doc));
  cur.push({ type: 'text', text: userText, ...(!m.openrouter && { cache_control: { type: 'ephemeral' } }) });
  messages.push({ role: 'user', content: cur });

  const system = SYSTEM + (web ? searchNote() : '');
  let maxTokens = limits.maxTokens;
  // the prompt's size, estimated on the high side at 3 characters a token, plus the screenshot
  const chars = system.length + userText.length + (doc ? doc.text.length : 0) +
    history.reduce((n, h) => n + h.content.length + (h.page_doc ? h.page_doc.length : 0), 0);
  const promptEst = Math.ceil(chars / 3) + (image ? 1600 : 0);
  if (q0) {
    // Make sure the whole question fits in what's left today: the prompt and any search results, plus the answer,
    // whose length gets capped to fit.
    const estIn = promptEst + (web ? limits.maxSearches * SEARCH_TOKENS : 0);
    let room;
    if (q0.kind === 'tokens') room = q0.left - estIn;
    else {
      const p0 = priceFor(m.id), p = p0.long && estIn > p0.long.over ? p0.long : p0;
      room = (q0.left - estIn * p.in / 1e6 - (web ? limits.maxSearches * SEARCH_USD : 0)) / (p.out / 1e6);
    }
    if (room < 256) {
      return res.status(429).json({ quota: q0, error: `That’s more than what’s left of today’s limit (${q0.kind === 'usd' ? '$' + q0.left.toFixed(2) : fmtLimit('tokens', Math.floor(q0.left))} left). ` +
        (history.length ? 'Start a new chat (+ at the top), or ask something shorter.' : 'Try a shorter question, or leave out the page or web search.') });
    }
    maxTokens = Math.min(maxTokens, Math.floor(room));
  }

  if (!convId) {
    const r = await pool.query('INSERT INTO conversations(page_url, page_title, user_id) VALUES($1,$2,$3) RETURNING id',
      [page?.url || null, page?.title || null, uid]);
    convId = Number(r.rows[0].id);
  }

  const params = { model: m.id, max_tokens: maxTokens, system, messages, output_config: { effort: EFFORT } };
  if (web) params.tools = [{ type: m.search, name: 'web_search', max_uses: limits.maxSearches }];
  // Sonnet 5.5 can decline some requests; the API then retries them on the model Anthropic recommends
  const api = m.fallback ? anthropic.beta.messages : anthropic.messages;
  if (m.fallback) Object.assign(params, { betas: [FALLBACK_BETA], fallbacks: 'default' });

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
  });
  const out = o => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + '\n'); };
  // the panel learns which chat this is right away, so an answer you stop still belongs to it for follow-ups
  out({ t: 'id', conversationId: convId });

  // the panel went away mid-answer (closed, reloaded, or stopped): stop spending tokens. What was used so far still counts.
  let stream = null, closed = false;
  res.on('close', () => { if (!res.writableFinished) { closed = true; stream?.abort(); } });
  if (res.destroyed) closed = true; // it went away while the chat was loading, before there was anything to listen to

  const tot = { in: 0, out: 0, usd: 0, searches: 0 };
  const sources = new Map();
  // quoted passages of the page, and where in the reply each group of them backs up what was just said
  const quotes = [], quoteIdx = new Map(), cites = [];
  let reply = '', final = null, failed = null, cut = null;
  const rs = m.openrouter ? { started: false, usage: null, sources: [] } : null;
  try {
    if (m.openrouter && !closed) {
      stream = new AbortController(); // so stream.abort() above stops it too
      final = await askRouter({
        model: m.id, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...messages],
        reasoning: { effort: EFFORT, exclude: true }, // it always thinks first; the thinking isn't shown, but counts toward max_tokens
        ...(web && { tools: [{ type: 'openrouter:web_search', parameters: { max_uses: limits.maxSearches } }], max_tool_calls: limits.maxSearches }),
      }, stream.signal, rs, t => { reply += t; out({ t: 'd', v: t }); });
      addRouterUsage(tot, rs.usage || { prompt_tokens: promptEst, completion_tokens: Math.ceil(reply.length / 3) }, m.id);
      for (const c of rs.sources) {
        if (/^https?:\/\//.test(c.url || '') && !sources.has(c.url)) sources.set(c.url, String(c.title || '').slice(0, 200));
      }
    }
    // a long server-side search loop can pause the turn; resend it as-is to let it continue
    for (let i = 0; i < 4 && !closed && !m.openrouter; i++) {
      stream = api.stream(params);
      stream.on('text', t => { reply += t; out({ t: 'd', v: t }); });
      stream.on('streamEvent', ev => {
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use' && ev.content_block.name === 'web_search') out({ t: 's' });
      });
      stream.on('contentBlock', blk => {
        if (blk.type === 'server_tool_use' && blk.name === 'web_search') {
          const q = blk.input?.query;
          if (q) out({ t: 's', q: String(q).slice(0, 200) });
        } else if (blk.type === 'text' && blk.citations?.length) {
          // the block's text has all streamed by now, so reply.length is where its marker goes
          const qs = [];
          for (const c of blk.citations) {
            const text = c.type === 'char_location' ? String(c.cited_text || '').trim() : '';
            if (!text) continue;
            if (!quoteIdx.has(text) && quotes.length < 30) { quoteIdx.set(text, quotes.length); quotes.push(text.slice(0, 2000)); }
            const i = quoteIdx.get(text);
            if (i != null && !qs.includes(i)) qs.push(i);
          }
          if (qs.length) cites.push({ at: reply.length, q: qs });
        }
      });
      final = await stream.finalMessage();
      addUsage(tot, final, m.id);
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
  } catch (e) {
    failed = e;
    if (!(e instanceof Anthropic.APIUserAbortError) && e?.name !== 'AbortError') console.error('chat error:', e?.status, e?.message);
    // a request cut short is still billed for what it used; the SDK keeps the message as far as it got
    cut = stream?.currentMessage;
    if (cut) addUsage(tot, cutUsage(cut), cut.model || m.id);
    // OpenRouter only totals usage at the end, so estimate it from the prompt and what streamed in
    else if (rs?.started) addRouterUsage(tot, rs.usage || { prompt_tokens: promptEst, completion_tokens: Math.ceil(reply.length / 3) }, m.id);
  }
  // Stopped before the model said anything: the panel already shows the question, and the page and screenshot it
  // sent won't be sent again, so keep the question in the chat with an empty, stopped answer.
  if (closed && !failed && !final) failed = new Anthropic.APIUserAbortError();
  if (!final && !tot.in && !closed) { // nothing reached the model
    if (failed) out({ t: 'err', v: friendly(failed, m.id) });
    return void res.end();
  }

  const refused = (failed ? cut : final)?.stop_reason === 'refusal';
  const replyText = reply.trim() ? reply : refused ? '[declined]' : failed ? '(stopped)' : '(no answer)';
  // an answer that broke off still counts toward usage, and stays in the chat as far as it got, for follow-ups
  await pool.query(
    `INSERT INTO messages(conversation_id, role, content, had_image, input_tokens, output_tokens, model, web_searches, refused, user_id, cost_usd, incomplete, page_doc, theme)
     VALUES ($1,'user',$2,$3,0,0,NULL,0,$4,$10,0,$12,$13,$14), ($1,'assistant',$5,false,$6,$7,$8,$9,$4,$10,$11,$12,NULL,NULL)`,
    [convId, userText, !!image, refused, replyText, tot.in, tot.out, (cut || final)?.model || m.id, tot.searches, uid, tot.usd, !!failed,
      doc ? JSON.stringify({ url: doc.url, title: doc.title, text: doc.text }) : null, prefs.theme]);
  if (failed) {
    out({ t: 'err', v: friendly(failed, m.id), conversationId: convId });
    return void res.end();
  }
  out({
    t: 'done', conversationId: convId, usage: { in: tot.in, out: tot.out, usd: tot.usd }, stop: final.stop_reason,
    model: modelLabel(final.model || m.id), fallback: !!final.model && final.model !== m.id,
    searches: tot.searches, sources: [...sources].slice(0, 8).map(([url, title]) => ({ url, title })),
    ...(cites.length && !refused && { quotes, cites }),
    ...(refused && { refusal: final.stop_details?.category || null }),
    ...(used && { quota: quota(u, { tokens: used.tokens + tot.in + tot.out, usd: used.usd + tot.usd }) }),
  });
  res.end();
}

function friendly(e, model) {
  const s = e?.status;
  if (e?.router && s === 401) return 'OpenRouter API key is invalid (check OPENROUTER_API_KEY).';
  if (e?.router && s === 402) return 'Your OpenRouter account is out of credits.';
  if (e?.router && s === 404) return `Model "${model}" not found on OpenRouter (check OPENROUTER_MODEL).`;
  if (s === 401) return 'Anthropic API key is invalid (check ANTHROPIC_API_KEY).';
  if (s === 404) return `Model "${model}" not found (check HAIKU_MODEL / SONNET_MODEL).`;
  if (s === 429) return 'Rate limited by the API — try again in a moment.';
  if (s === 529 || s === 503) return 'The API is overloaded — try again in a moment.';
  return (e?.error?.error?.message || e?.message || 'Something went wrong').slice(0, 300);
}

// ---------- wrapped: a year of your questions ----------
// The panel sends its own timezone so hours and streaks follow the viewer's clock.
const validTz = tz => {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
};
// one calendar year (back = 0 is this year) of one person's questions: uid null = the owner
async function wrappedFor(uid, tz, back) {
  const span = (await pool.query(
    `SELECT extract(year from now() AT TIME ZONE $1)::int - $2 AS year,
       (date_trunc('year', now() AT TIME ZONE $1) - make_interval(years => $2)) AT TIME ZONE $1 AS start,
       (date_trunc('year', now() AT TIME ZONE $1) - make_interval(years => $2 - 1)) AT TIME ZONE $1 AS stop`, [tz, back])).rows[0];
  // "= $1" (or IS NULL for the owner) so Postgres can use messages_user_idx; $1 stays in the query either way
  const mine = `${uid == null ? 'm.user_id IS NULL AND $1::bigint IS NULL' : 'm.user_id = $1'} AND m.created_at >= $2 AND m.created_at < $3`;
  const p3 = [uid, span.start, span.stop], p4 = [...p3, tz];
  const db = await pool.connect(); // the six queries share one connection, so a big year can't take the whole pool
  let tot, sites, hours, models, theme, streak;
  try {
    [tot, sites, hours, models, theme, streak] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS questions, COUNT(DISTINCT (m.created_at AT TIME ZONE $4)::date)::int AS days
        FROM messages m WHERE ${mine} AND m.role = 'user'`, p4),
      db.query(`SELECT site, COUNT(*)::int AS n FROM (
          SELECT lower(regexp_replace(substring(c.page_url from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/:?#]+)'), '^www\\.', '')) AS site
          FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE ${mine} AND m.role = 'user') x
        WHERE site <> '' GROUP BY site ORDER BY n DESC, site LIMIT 5`, p3),
      db.query(`SELECT extract(hour from m.created_at AT TIME ZONE $4)::int AS h, COUNT(*)::int AS n
        FROM messages m WHERE ${mine} AND m.role = 'user' GROUP BY h`, p4),
      db.query(`SELECT m.model, COUNT(*)::int AS n FROM messages m
        WHERE ${mine} AND m.role = 'assistant' AND m.model IS NOT NULL GROUP BY m.model`, p3),
      db.query(`SELECT m.theme, COUNT(*)::int AS n FROM messages m
        WHERE ${mine} AND m.role = 'user' AND m.theme IS NOT NULL GROUP BY m.theme ORDER BY n DESC, m.theme LIMIT 1`, p3),
      // longest run of days in a row with at least one question (days minus their rank stay equal within a run)
      db.query(`WITH d AS (SELECT DISTINCT (m.created_at AT TIME ZONE $4)::date AS day FROM messages m WHERE ${mine} AND m.role = 'user'),
          g AS (SELECT day, day - (ROW_NUMBER() OVER (ORDER BY day))::int AS grp FROM d)
        SELECT COUNT(*)::int AS days, MIN(day)::text AS start, MAX(day)::text AS stop FROM g
        GROUP BY grp ORDER BY days DESC, MAX(day) DESC LIMIT 1`, p4),
    ]);
  } finally { db.release(); }
  const byHour = Array(24).fill(0);
  for (const r of hours.rows) byHour[r.h] = r.n;
  const byModel = new Map();
  for (const r of models.rows) { const l = modelLabel(r.model); byModel.set(l, (byModel.get(l) || 0) + r.n); }
  return {
    year: span.year, questions: tot.rows[0].questions, days: tot.rows[0].days,
    sites: sites.rows, hours: byHour,
    models: [...byModel].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n),
    theme: theme.rows[0]?.theme || null,
    streak: streak.rows[0] || { days: 0, start: null, stop: null },
  };
}

app.get('/api/wrapped', limit(20, 'wrapped'), auth, trusted, async (req, res) => {
  const uid = req.user?.id ?? null;
  let tz = validTz(String(req.query.tz || '')) || TIMEZONE, w;
  try { w = await wrappedFor(uid, tz, 0); }
  catch (e) { // Postgres may not know a newer timezone name; fall back to the server's
    if (e?.code !== '22023' || tz === TIMEZONE) throw e;
    tz = TIMEZONE; w = await wrappedFor(uid, tz, 0);
  }
  if (!w.questions) { const last = await wrappedFor(uid, tz, 1); if (last.questions) w = last; } // early in a new year, show the one before
  res.set('Cache-Control', 'no-store');
  // themes were only recorded from this version on; until then, show the current one
  res.json({ ...w, theme: w.theme || prefsFor(req.cfg, req.user).theme, themeIsCurrent: !w.theme, timezone: tz });
});

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
      COALESCE(SUM(web_searches), 0)::bigint AS searches,
      COALESCE(SUM(cost_usd), 0)::float8 AS total_usd,
      COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= ${todayStart}), 0)::float8 AS today_usd,
      COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= now() - interval '7 days'), 0)::float8 AS week_usd
    FROM messages`, [TIMEZONE])).rows[0];
  const sessions = (await pool.query('SELECT COUNT(*)::bigint AS n FROM sessions')).rows[0].n;
  const cfg = await loadConfig();
  const n = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));
  res.json({
    ...n(m), sessions: Number(sessions), budget: BUDGET, effort: EFFORT,
    models: Object.values(MODELS).map(x => ({ label: x.label, id: x.id, openrouter: !!x.openrouter })),
    passwordSet: cfg.passwordSet, limits: cfg.limits, limitRanges: LIMIT_RANGES,
    lock: { on: cfg.lock.on, minutes: cfg.lock.minutes, fails: Math.min(cfg.lock.fails, MAX_PASSCODE_FAILS), maxFails: MAX_PASSCODE_FAILS, choices: LOCK_CHOICES },
  });
});

// daily token usage for the chart, in TIMEZONE days (OpenRouter's model ids are the ones with a slash); `user` narrows it to 'owner' or one account id
app.get('/api/admin/usage', limit(30, 'admin'), admin, async (req, res) => {
  const days = clampInt(req.query.days || 30, 1, 365);
  const who = req.query.user === 'owner' ? 'owner' : /^\d+$/.test(String(req.query.user || '')) ? String(req.query.user) : 'all';
  const r = await pool.query(`
    WITH bounds AS (SELECT (date_trunc('day', now() AT TIME ZONE $1) - make_interval(days => $2 - 1)) AS start),
    m AS (
      SELECT (created_at AT TIME ZONE $1)::date AS day, role, input_tokens, output_tokens, web_searches,
        COALESCE(model, '') AS model, COALESCE(cost_usd, 0) AS usd
      FROM messages
      WHERE created_at >= (SELECT start FROM bounds) AT TIME ZONE $1
        AND ($3 = 'all' OR ($3 = 'owner' AND user_id IS NULL) OR user_id::text = $3)
    )
    SELECT d.day::date::text AS day,
      COALESCE(SUM(m.input_tokens), 0)::bigint AS input,
      COALESCE(SUM(m.output_tokens), 0)::bigint AS output,
      COUNT(m.role) FILTER (WHERE m.role = 'user')::bigint AS questions,
      COALESCE(SUM(m.web_searches), 0)::bigint AS searches,
      COALESCE(SUM(m.input_tokens + m.output_tokens) FILTER (WHERE m.model LIKE '%sonnet%' AND m.model NOT LIKE '%/%'), 0)::bigint AS sonnet,
      COALESCE(SUM(m.input_tokens + m.output_tokens) FILTER (WHERE m.model LIKE '%/%'), 0)::bigint AS router,
      COALESCE(SUM(m.usd), 0)::float8 AS usd,
      COALESCE(SUM(m.usd) FILTER (WHERE m.model LIKE '%sonnet%' AND m.model NOT LIKE '%/%'), 0)::float8 AS sonnet_usd,
      COALESCE(SUM(m.usd) FILTER (WHERE m.model LIKE '%/%'), 0)::float8 AS router_usd
    FROM generate_series((SELECT start FROM bounds), date_trunc('day', now() AT TIME ZONE $1), interval '1 day') AS d(day)
    LEFT JOIN m ON m.day = d.day::date
    GROUP BY d.day ORDER BY d.day`, [TIMEZONE, days, who]);
  res.json({
    timezone: TIMEZONE,
    days: r.rows.map(x => ({
      day: x.day, input: +x.input, output: +x.output, questions: +x.questions, searches: +x.searches,
      sonnet: +x.sonnet, router: +x.router, usd: +x.usd, sonnetUsd: +x.sonnet_usd, routerUsd: +x.router_usd,
    })),
  });
});

// every account with its usage; the owner's own usage comes along for comparison
app.get('/api/admin/users', limit(60, 'admin'), admin, async (req, res) => {
  const cfg = await loadConfig();
  const r = await pool.query(`
    WITH t AS (
      SELECT user_id,
        SUM(input_tokens + output_tokens) FILTER (WHERE created_at >= ${todayStartSQL.replaceAll('$2', '$1')}) AS today_tokens,
        SUM(cost_usd) FILTER (WHERE created_at >= ${todayStartSQL.replaceAll('$2', '$1')}) AS today_usd,
        COUNT(*) FILTER (WHERE role = 'user' AND created_at >= ${todayStartSQL.replaceAll('$2', '$1')}) AS today_q,
        SUM(input_tokens + output_tokens) FILTER (WHERE created_at >= now() - interval '7 days') AS week_tokens,
        SUM(cost_usd) FILTER (WHERE created_at >= now() - interval '7 days') AS week_usd,
        SUM(input_tokens + output_tokens) AS total_tokens, SUM(cost_usd) AS total_usd,
        COUNT(*) FILTER (WHERE role = 'user') AS total_q
      FROM messages GROUP BY user_id
    )
    SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id)::int AS devices,
      t.today_tokens, t.today_usd, t.today_q, t.week_tokens, t.week_usd, t.total_tokens, t.total_usd, t.total_q
    FROM users u LEFT JOIN t ON t.user_id = u.id
    ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'trusted' THEN 1 ELSE 2 END, u.created_at DESC`, [TIMEZONE]);
  const own = (await pool.query(`
    SELECT SUM(input_tokens + output_tokens) FILTER (WHERE created_at >= ${todayStartSQL.replaceAll('$2', '$1')}) AS today_tokens,
      SUM(cost_usd) FILTER (WHERE created_at >= ${todayStartSQL.replaceAll('$2', '$1')}) AS today_usd,
      SUM(input_tokens + output_tokens) AS total_tokens, SUM(cost_usd) AS total_usd
    FROM messages WHERE user_id IS NULL`, [TIMEZONE])).rows[0];
  res.json({
    signup: cfg.signup, defaults: cfg.accountDefaults, ranges: DAILY_RANGES, timezone: TIMEZONE,
    owner: { today: { tokens: +own.today_tokens || 0, usd: +own.today_usd || 0 }, total: { tokens: +own.total_tokens || 0, usd: +own.total_usd || 0 } },
    users: r.rows.map(adminUser),
  });
});
function adminUser(x) {
  const u = toUser(x);
  delete u.prefs;
  return {
    ...u, devices: x.devices ?? 0,
    today: { tokens: +x.today_tokens || 0, usd: +x.today_usd || 0, questions: +x.today_q || 0 },
    week: { tokens: +x.week_tokens || 0, usd: +x.week_usd || 0 },
    total: { tokens: +x.total_tokens || 0, usd: +x.total_usd || 0, questions: +x.total_q || 0 },
  };
}

// approve, block, set limits and access, leave a note, reset the password, or sign an account out
app.post('/api/admin/users/:id', limit(60, 'admin'), admin, async (req, res) => {
  const id = clampInt(req.params.id, 1, Number.MAX_SAFE_INTEGER);
  const cur = id && (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'No such user.' });
  const b = req.body || {}, cfg = await loadConfig();
  const set = {};
  let signOut = !!b.signout;
  if (b.status != null) {
    if (!['trusted', 'blocked', 'pending'].includes(b.status)) return res.status(400).json({ error: 'Unknown status.' });
    set.status = b.status;
    if (b.status === 'trusted' && cur.status === 'pending') {
      // first approval: start from the defaults for new accounts
      const d = cfg.accountDefaults;
      Object.assign(set, { approved_at: new Date(), limit_kind: d.limitKind, limit_value: d.limitValue, allow_sonnet: d.allowSonnet, allow_web: d.allowWeb });
    }
    if (b.status === 'blocked') signOut = true;
  }
  if ('limitKind' in b) {
    const l = cleanDaily(b.limitKind, b.limitValue);
    if (!l) return res.status(400).json({ error: 'Enter a number for the daily limit.' });
    set.limit_kind = l.kind; set.limit_value = l.value;
  }
  if (typeof b.allowSonnet === 'boolean') set.allow_sonnet = b.allowSonnet;
  if (typeof b.allowWeb === 'boolean') set.allow_web = b.allowWeb;
  if (typeof b.adminNote === 'string') set.admin_note = b.adminNote.trim().slice(0, 300) || null;
  if (b.password != null) {
    const pw = String(b.password);
    if (pw.length < 6 || pw.length > 200) return res.status(400).json({ error: 'The new password needs at least 6 characters.' });
    // a reset also removes their passcode, which would otherwise still sign them in
    Object.assign(set, { password_hash: await hashPw(pw), passcode_hash: null, passcode_fails: 0, passcode_fails_at: null });
    signOut = true;
  }
  const keys = Object.keys(set);
  if (keys.length) {
    await pool.query(`UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map(k => set[k])]);
  }
  if (signOut) await pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
  res.json({ ok: true });
});

// deleting a waiting account is how a request gets turned down; usage history stays in the totals
app.delete('/api/admin/users/:id', limit(60, 'admin'), admin, async (req, res) => {
  const id = clampInt(req.params.id, 1, Number.MAX_SAFE_INTEGER);
  const r = await pool.query('DELETE FROM users WHERE id=$1', [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'No such user.' });
  res.json({ ok: true });
});

// open or close sign-ups, and set what newly approved accounts start with
app.post('/api/admin/accounts', limit(20, 'admin'), admin, async (req, res) => {
  const b = req.body || {};
  if (typeof b.signup === 'boolean') await setSetting('signup', b.signup ? '1' : '0');
  if (b.defaults && typeof b.defaults === 'object') {
    const d = cleanAccountDefaults(b.defaults);
    if ('limitKind' in b.defaults && !('limitKind' in d)) return res.status(400).json({ error: 'Enter a number for the daily limit.' });
    await mergeJSON('account_defaults', d);
  }
  const cfg = await loadConfig();
  res.json({ ok: true, signup: cfg.signup, defaults: cfg.accountDefaults });
});

// the announcement everyone with an account sees, and how many accepted people have closed it
app.get('/api/admin/announcement', limit(30, 'admin'), admin, async (req, res) => {
  const a = await currentAnnouncement();
  const c = (await pool.query(`SELECT COUNT(*)::int AS people, COUNT(*) FILTER (WHERE ann_seen >= $1)::int AS seen
    FROM users WHERE status = 'trusted'`, [a?.id ?? 0])).rows[0];
  res.json({ announcement: a, people: c.people, seen: a ? c.seen : 0, max: MAX_ANNOUNCEMENT });
});

// posting replaces whatever was showing
app.post('/api/admin/announcement', limit(20, 'admin'), admin, async (req, res) => {
  const body = String(req.body?.body ?? '').trim();
  if (!body) return res.status(400).json({ error: 'Write something first.' });
  if (body.length > MAX_ANNOUNCEMENT) return res.status(400).json({ error: `Keep it under ${MAX_ANNOUNCEMENT} characters.` });
  await pool.query('INSERT INTO announcements(body) VALUES($1)', [body]);
  res.json({ ok: true });
});

app.delete('/api/admin/announcement', limit(20, 'admin'), admin, async (req, res) => {
  await pool.query('UPDATE announcements SET hidden_at = now() WHERE hidden_at IS NULL');
  res.json({ ok: true });
});

app.post('/api/admin/password', limit(20, 'admin'), admin, async (req, res) => {
  const pw = String(req.body?.password || '');
  // this password unlocks unlimited use from anywhere, so it gets a longer minimum than account passwords
  if (pw.length < 8 || pw.length > 200) return res.status(400).json({ error: 'Use at least 8 characters for the owner password.' });
  await setSetting('password_hash', await hashPw(pw));
  const r = await pool.query('DELETE FROM sessions WHERE user_id IS NULL'); // only devices using the owner password
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

// How pages and big JSON answers leave the server: which encoding a browser gets, the validators that go with it, and
// the compressed copies of each page, made once per version of its file. Nothing here knows about accounts or the
// database, so it can be tested on its own.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const Z = zlib.constants;
const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);
// `best` is for pages, which are compressed once and sent thousands of times: brotli 11 takes about a second for the
// panel. Everything else gets settings that take a millisecond or two.
const pack = {
  br: (buf, best) => brotli(buf, { params: { [Z.BROTLI_PARAM_MODE]: Z.BROTLI_MODE_TEXT, [Z.BROTLI_PARAM_QUALITY]: best ? Z.BROTLI_MAX_QUALITY : 5, [Z.BROTLI_PARAM_SIZE_HINT]: buf.length } }),
  gzip: (buf, best) => gzip(buf, { level: best ? Z.Z_BEST_COMPRESSION : 6 }),
};
export const ENCODINGS = ['br', 'gzip']; // what we can send besides the plain bytes, best first

// ---------- what the browser asked for ----------
// An Accept-Encoding header as weights (RFC 9110, 12.5.3): each coding's q, "*" for the ones it doesn't name, and q=0 for
// "never send me this". The plain bytes ("identity") are fine unless the header turns them down, but they come last:
// IMPLIED is the weight they get when the header doesn't mention them.
const IMPLIED = 0.0001;
export function encodingWeights(header) {
  const named = new Map();
  if (typeof header === 'string') for (const part of header.split(',')) {
    const [name, ...params] = part.split(';'), coding = name.trim().toLowerCase();
    if (!coding) continue;
    let q = 1;
    for (const p of params) {
      if (!/^\s*q\s*=/i.test(p)) continue;
      const m = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/i.exec(p);
      q = m ? Number(m[1]) : 0; // a q we can't read is a coding we don't send
    }
    named.set(coding, Math.min(q, named.get(coding) ?? 1)); // named twice: the more careful reading wins
  }
  const star = named.get('*');
  return {
    br: named.get('br') ?? star ?? 0,
    gzip: named.get('gzip') ?? named.get('x-gzip') ?? star ?? 0,
    identity: named.get('identity') ?? star ?? IMPLIED,
  };
}
// The encoding to answer with, out of the ones on hand (`have`, best first). No header at all means the client said
// nothing, and the plain bytes are the one thing every client reads. A header that turns down everything we have,
// identity included, still gets the plain bytes: a page it may not want beats no page.
export function pickEncoding(header, have = ENCODINGS) {
  if (header == null) return 'identity';
  const w = encodingWeights(header);
  let best = 'identity', top = w.identity;
  for (const enc of have) if (w[enc] > 0 && (w[enc] > top || (w[enc] === top && best === 'identity'))) { best = enc; top = w[enc]; }
  return best;
}

// ---------- validators ----------
// Does an If-None-Match header name this ETag? Compared the weak way (RFC 9110, 13.1.2 and 8.8.3.2): W/ is ignored.
export function etagListed(header, etag) {
  if (typeof header !== 'string' || !etag) return false;
  if (header.trim() === '*') return true;
  const want = etag.replace(/^W\//, '');
  for (const m of header.matchAll(/(?:W\/)?("[^"]*")/g)) if (m[1] === want) return true;
  return false;
}
// One page version has one tag and a validator per encoding. They are weak validators: each encoding decodes to the
// same page, and a proxy that re-encodes one may keep it.
export const etagFor = (tag, enc) => `W/"${tag}${enc === 'identity' ? '' : enc === 'gzip' ? '.gz' : '.br'}"`;
export const shortHash = (...parts) => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p).update('\0'); return h.digest('base64url').slice(0, 22); };

// ---------- compressing off the request path ----------
// One job at a time, on zlib's worker threads: a request never waits for one, and a burst of them (a deploy, a flood of
// made-up Host names) can't take over the thread pool that logins and DNS share. Quick jobs go first, so every page has
// its gzip a few milliseconds after the server starts and its brotli a second or two later.
const quick = [], slow = [], MAX_WAITING = 32;
let working = null;
function squeeze(v, enc, best, live) {
  if (v[enc] || v.queued.has(enc) || (!best && quick.length >= MAX_WAITING)) return; // (a copy that isn't made now is asked for again by the next request)
  v.queued.add(enc);
  (best && enc === 'br' ? slow : quick).push({ v, enc, best, live });
  working ||= (async () => {
    // (wait a turn first: a queue holding only jobs that are no longer wanted would otherwise run to its end before
    // `working` is even set, leave it set to a finished promise, and nothing would be compressed again)
    await null;
    for (let j; (j = quick.shift() || slow.shift());) {
      try { if (j.live()) j.v[j.enc] = await pack[j.enc](j.v.buf, j.best); }
      catch (e) { console.error('compression error:', e?.message || e); } // the page still goes out, just plain
      j.v.queued.delete(j.enc);
    }
    working = null;
  })();
}
// resolves once nothing is waiting to be compressed (for tests)
export const settled = async () => { while (working) await working; };

const variant = buf => ({ buf, br: null, gzip: null, queued: new Set() });

// ---------- pages ----------
// The pages in `dir`, each read once and kept until its file changes (the mtime is checked on every request, so an edit
// shows on the next reload). With each page come the hashes of its inline scripts, for the Content-Security-Policy, and
// its compressed copies, made in the background: until one is ready the page goes out in whatever is.
// `origins`: how many filled-in copies of a templated page are kept (see `filled`).
export function createPages(dir, { origins = 8 } = {}) {
  const cache = new Map();
  function get(file) {
    const p = path.join(dir, file), mtime = fs.statSync(p).mtimeMs;
    let c = cache.get(file);
    if (!c || c.mtime !== mtime) {
      const html = fs.readFileSync(p, 'utf8');
      const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
      const page = variant(Buffer.from(html, 'utf8'));
      c = { file, mtime, scripts: hashes.join(' ') || "'none'", page, tag: shortHash(page.buf), filled: new Map(), memo: new Map() };
      cache.set(file, c);
    }
    // Its copies are asked for until both are there: a new version's at once, and one whose job failed (it went out in
    // the next best encoding meanwhile) on the next request. Once both are made this is two lookups.
    if (!c.page.gzip || !c.page.br) { const made = c; for (const enc of ['gzip', 'br']) squeeze(made.page, enc, true, () => cache.get(file) === made); }
    return c;
  }
  // A page (`c`, from get) with something filled in per `key`: the homepage, per address it is opened from. The key
  // comes from the request, so only the last few are kept, and a new one is never waited for: it goes out plain while
  // its compressed copies are made, with the quick settings.
  function filled(c, key, fill) {
    let v = c.filled.get(key);
    if (v) c.filled.delete(key); // (and back in below, as the most recently used)
    else v = variant(Buffer.from(fill(c.page.buf.toString('utf8')), 'utf8'));
    c.filled.set(key, v);
    if (c.filled.size > origins) c.filled.delete(c.filled.keys().next().value);
    for (const enc of ['gzip', 'br']) squeeze(v, enc, false, () => cache.get(c.file) === c && c.filled.get(key) === v);
    return v;
  }
  return { get, filled };
}

// ---------- sending ----------
// The validator the browser already holds for this version, if it names one (If-None-Match) in an encoding it still
// takes. That includes an encoding whose copy isn't built yet (just after a restart): nothing has to be compressed to
// say "you have it". A reload that insists on a fresh copy (Cache-Control: no-cache) gets one.
function heldValidator(req, tag) {
  const inm = req.headers['if-none-match'];
  if (!inm || /(?:^|,)\s*no-cache\s*(?:,|$)/i.test(req.headers['cache-control'] || '')) return null;
  if (inm.trim() === '*') return '*';
  const w = encodingWeights(req.headers['accept-encoding'] ?? '');
  return [...ENCODINGS.filter(e => w[e] > 0), 'identity'].map(e => etagFor(tag, e)).find(t => etagListed(inm, t)) || null;
}
// Sends one of a page's copies: the best encoding the browser takes out of the ones that are ready, or a 304 when the
// browser already holds this version. `tag` identifies the version (the page and the headers that must travel with it);
// without one the response gets no validator (pages that are never stored).
export function sendEncoded(req, res, v, headers, tag) {
  const enc = pickEncoding(req.headers['accept-encoding'], ENCODINGS.filter(e => v[e]));
  for (const k in headers) if (k !== 'Content-Type' && k !== 'Vary') res.setHeader(k, headers[k]);
  res.setHeader('Vary', headers.Vary ? `${headers.Vary}, Accept-Encoding` : 'Accept-Encoding');
  if (tag) {
    const held = heldValidator(req, tag);
    res.setHeader('ETag', held && held !== '*' ? held : etagFor(tag, enc));
    // a 304 carries the validator, Vary, Cache-Control and the policy headers (all set by now), and no body
    if (held) { res.statusCode = 304; return void res.end(); }
  }
  const body = enc === 'identity' ? v.buf : v[enc];
  if (enc !== 'identity') res.setHeader('Content-Encoding', enc);
  res.setHeader('Content-Type', headers['Content-Type'] || 'text/html; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.statusCode = 200;
  req.method === 'HEAD' ? res.end() : res.end(body);
}

// JSON that can be big (a long chat, a table of activity): compressed with the quick settings when it is at least `min`
// bytes and the browser takes an encoding. Smaller answers fit in one packet either way. Compression runs on zlib's
// worker threads, so other requests are served meanwhile.
// Only for answers without secrets in them: a compressed length gives away a little about what is inside, which matters
// when a token sits next to text someone else could have chosen.
export async function sendJson(req, res, value, min = 1024) {
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  const enc = plain.length >= min && !res.getHeader('Content-Encoding') ? pickEncoding(req.headers['accept-encoding']) : 'identity';
  let body = plain;
  if (enc !== 'identity') {
    try { body = await pack[enc](plain, false); } catch (e) { console.error('compression error:', e?.message || e); }
    if (res.destroyed || res.headersSent) return; // the browser went away while we worked
    if (body.length < plain.length) res.setHeader('Content-Encoding', enc); else body = plain;
  }
  res.setHeader('Content-Length', body.length);
  req.method === 'HEAD' ? res.end() : res.end(body);
}

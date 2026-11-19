import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createPages, encodingWeights, etagFor, etagListed, pickEncoding, sendEncoded, sendJson, settled, shortHash } from '../lib/delivery.js';

// How pages and big JSON answers leave the server (lib/delivery.js), without a database: which encoding a browser gets,
// the validators and 304s that go with it, and the compressed copies of each page, remade when its file changes.
const dir = mkdtempSync(path.join(tmpdir(), 'pagebot-delivery-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const sha = s => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
const decoded = (enc, body) => enc === 'br' ? zlib.brotliDecompressSync(body) : enc === 'gzip' ? zlib.gunzipSync(body) : body;
// a page long enough that compressing it shows, with two inline scripts and some text outside ASCII
const pageHtml = (mark = 'one') => `<!doctype html><meta charset="utf-8"><title>pagebot</title>\n<script>window.first = '${mark}';</script>\n<p>` +
  Array.from({ length: 400 }, (_, i) => `It’s line ${i} of a page that says “${mark}”. `).join('') + `</p>\n<script>\n  window.second = ${JSON.stringify(mark)};\n</script>\n`;
// writes a page so that its modified time is surely different from the last one (some filesystems keep whole seconds)
let clock = Date.now() / 1000 - 1000;
function write(file, html) {
  const p = path.join(dir, file);
  writeFileSync(p, html);
  clock += 10; utimesSync(p, clock, clock);
  return statSync(p).mtimeMs;
}

test('Accept-Encoding: the best encoding the browser takes, by its q values', () => {
  const cases = [
    [undefined, 'identity', 'no header: the client said nothing'],
    ['', 'identity', 'an empty header asks for no encoding'],
    ['gzip', 'gzip'],
    ['gzip, deflate, br, zstd', 'br', 'what browsers send'],
    ['br, gzip', 'br'],
    ['GZIP, BR', 'br', 'names are case-insensitive'],
    ['deflate, zstd', 'identity', 'nothing we have'],
    ['br;q=0, gzip', 'gzip', 'q=0 means never'],
    ['br;q=0.000, gzip;q=0.001', 'gzip'],
    ['gzip;q=0.5, br;q=0.4', 'gzip', 'the browser’s order beats ours'],
    ['gzip;q=1.0, br;q=1', 'br', 'a tie goes to the smaller one'],
    ['br ; q=0.2 , gzip ; q = 0.9', 'gzip', 'spaces are allowed'],
    ['*', 'br', '* stands for everything not named'],
    ['*;q=0.3, gzip;q=0.2', 'br'],
    ['br;q=0, *', 'gzip'],
    ['*;q=0', 'identity', 'everything turned down still gets the page'],
    ['identity', 'identity'],
    ['identity;q=1, br;q=0.9', 'identity', 'plain bytes when the browser prefers them'],
    ['identity;q=0.5, gzip;q=0.5', 'gzip', 'a tie with identity goes to the encoding'],
    ['identity;q=0, gzip', 'gzip'],
    ['identity;q=0', 'identity', 'refusing the only thing we have still gets it'],
    ['x-gzip', 'gzip', 'the old name for gzip'],
    ['br;q=fast, gzip', 'gzip', 'a q that is not a number is not a yes'],
    ['br;q=1.5, gzip', 'gzip'],
    ['br;q=0, br, gzip', 'gzip', 'named twice: the refusal counts'],
    ['br;level=4;q=0.1, gzip;q=0.2', 'gzip', 'other parameters are skipped'],
    [',, gzip ,', 'gzip', 'empty list entries are skipped'],
  ];
  for (const [header, want, why] of cases) assert.equal(pickEncoding(header), want, `${JSON.stringify(header)}${why ? ` (${why})` : ''}`);
  // only encodings whose copy exists are offered
  assert.equal(pickEncoding('br, gzip', ['gzip']), 'gzip');
  assert.equal(pickEncoding('br', ['gzip']), 'identity');
  assert.equal(pickEncoding('br, gzip', []), 'identity');
  assert.deepEqual(encodingWeights('br;q=0.5, identity;q=0'), { br: 0.5, gzip: 0, identity: 0 });
  assert.equal(encodingWeights('gzip').identity > 0, true, 'plain bytes stay acceptable unless turned down');
});

test('If-None-Match: weak comparison over a list, and *', () => {
  const tag = etagFor('abc', 'br');
  assert.equal(tag, 'W/"abc.br"');
  assert.deepEqual(['identity', 'gzip', 'br'].map(e => etagFor('abc', e)), ['W/"abc"', 'W/"abc.gz"', 'W/"abc.br"'], 'one validator per encoding');
  assert.equal(etagListed('W/"abc.br"', tag), true);
  assert.equal(etagListed('"abc.br"', tag), true, 'a strong spelling of the same tag matches');
  assert.equal(etagListed('"x", W/"abc.br" , "y"', tag), true);
  assert.equal(etagListed('*', tag), true);
  assert.equal(etagListed(' * ', tag), true);
  assert.equal(etagListed('W/"abc"', tag), false, 'another encoding’s validator is another validator');
  assert.equal(etagListed('W/"abc.brx", "abc.b", "a,b"', tag), false);
  assert.equal(etagListed('abc.br', tag), false, 'not a quoted tag');
  assert.equal(etagListed(undefined, tag), false);
  assert.equal(etagListed('', tag), false);
});

test('a page is read once, with the hashes of its inline scripts and compressed copies that decode to it', async () => {
  const html = pageHtml();
  write('page.html', html);
  const pages = createPages(dir), c = pages.get('page.html');
  assert.equal(pages.get('page.html'), c, 'the same file, unchanged, is the same entry');
  assert.equal(c.page.buf.toString('utf8'), html);
  assert.equal(c.scripts, [sha(`window.first = 'one';`), sha(`\n  window.second = "one";\n`)].join(' '), 'a hash per inline script, over exactly what is between the tags');
  assert.equal(c.tag, shortHash(Buffer.from(html)), 'the version tag comes from the page’s bytes');
  await settled();
  assert.ok(c.page.gzip && c.page.br, 'both copies are made in the background');
  assert.deepEqual(zlib.gunzipSync(c.page.gzip), c.page.buf);
  assert.deepEqual(zlib.brotliDecompressSync(c.page.br), c.page.buf);
  assert.ok(c.page.br.length < c.page.gzip.length && c.page.gzip.length < c.page.buf.length / 5, `brotli ${c.page.br.length} < gzip ${c.page.gzip.length} < plain ${c.page.buf.length}`);
  // maximum settings: the same bytes as zlib at its best gives
  assert.equal(c.page.gzip.length, zlib.gzipSync(c.page.buf, { level: 9 }).length);
  assert.equal(c.page.br.length, zlib.brotliCompressSync(c.page.buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: c.page.buf.length } }).length);

  write('bare.html', '<!doctype html><p>No scripts here.</p>');
  assert.equal(pages.get('bare.html').scripts, "'none'", 'a page without scripts allows none');
  assert.throws(() => pages.get('missing.html'), { code: 'ENOENT' });
});

test('a changed file is a new version at once: new bytes, new hashes, new tag, and the old copies are never sent for it', async () => {
  write('live.html', pageHtml('one'));
  const pages = createPages(dir), old = pages.get('live.html');
  await settled();
  assert.ok(old.page.br);
  const html = pageHtml('two');
  write('live.html', html);
  const c = pages.get('live.html');
  assert.notEqual(c, old);
  assert.equal(c.page.buf.toString('utf8'), html);
  assert.notEqual(c.tag, old.tag);
  assert.notEqual(c.scripts, old.scripts);
  assert.equal(c.scripts, [sha(`window.first = 'two';`), sha(`\n  window.second = "two";\n`)].join(' '));
  assert.equal(c.page.br, null, 'the new version has no compressed copy yet (it is not waited for)');
  assert.equal(c.page.gzip, null);
  assert.equal(c.memo.size, 0, 'nothing worked out for the old version is carried over');
  await settled();
  assert.deepEqual(zlib.brotliDecompressSync(c.page.br), Buffer.from(html));
  assert.deepEqual(zlib.gunzipSync(c.page.gzip), Buffer.from(html));
  // the same content written again (a new modified time) is read again and comes out the same
  write('live.html', html);
  const again = pages.get('live.html');
  assert.notEqual(again, c);
  assert.equal(again.tag, c.tag);
  await settled();
});

test('a file replaced while its copies are being made does not get the old copies', async () => {
  write('race.html', pageHtml('before'));
  const pages = createPages(dir), old = pages.get('race.html');
  write('race.html', pageHtml('after')); // before anything was compressed
  const c = pages.get('race.html');
  await settled();
  assert.deepEqual(zlib.brotliDecompressSync(c.page.br).toString(), pageHtml('after'));
  assert.equal(old.page.br, null, 'the replaced version was not compressed for nothing');
});

test('a copy whose compression failed is made on the next request for the page, not never', async () => {
  // a fresh copy of the module, made while brotli is set to fail once (the module keeps the function it was given)
  const real = zlib.brotliCompress;
  let failures = 1;
  zlib.brotliCompress = (buf, opts, cb) => failures-- > 0 ? process.nextTick(cb, new Error('simulated: out of memory')) : real(buf, opts, cb);
  let fresh;
  try { fresh = await import('../lib/delivery.js?brotli-fails-once'); } finally { zlib.brotliCompress = real; }
  write('flaky.html', pageHtml('flaky'));
  const pages = fresh.createPages(dir), c = pages.get('flaky.html');
  await fresh.settled();
  assert.equal(failures, 0, 'brotli was tried, and failed');
  assert.equal(c.page.br, null, 'so there is no brotli copy (the page goes out as gzip meanwhile)');
  assert.deepEqual(zlib.gunzipSync(c.page.gzip), c.page.buf);
  assert.equal(pages.get('flaky.html'), c, 'the next request is for the same version...');
  await fresh.settled();
  assert.ok(c.page.br, '...and asks for its brotli copy again');
  assert.deepEqual(zlib.brotliDecompressSync(c.page.br), c.page.buf);
  assert.equal(failures, -1, 'once');
  pages.get('flaky.html');
  await fresh.settled();
  assert.equal(failures, -1, 'with both copies made, nothing more is asked for');
});

test('a copy asked for on a version that was already replaced is skipped, and the copies after it are still made', { timeout: 10_000 }, async () => {
  write('stale.html', '<!doctype html><a href="{{HREF}}">old</a>' + '<p>Some text to compress. </p>'.repeat(200));
  const pages = createPages(dir), old = pages.get('stale.html');
  await settled();
  write('stale.html', '<!doctype html><a href="{{HREF}}">new</a>' + '<p>Some text to compress. </p>'.repeat(200));
  const c = pages.get('stale.html');
  await settled();
  // something still holding the old version asks for a filled-in copy of it: nothing is compressed for that one...
  const gone = pages.filled(old, 'https://a.example', html => html.replaceAll('{{HREF}}', 'https://a.example'));
  // ...and the queue keeps working for everything after it (it used to stop for good here)
  const v = pages.filled(c, 'https://b.example', html => html.replaceAll('{{HREF}}', 'https://b.example'));
  const done = await Promise.race([settled().then(() => true), new Promise(r => setTimeout(r, 3000, false))]);
  assert.ok(done, 'the queue drains');
  assert.equal(gone.br, null);
  assert.deepEqual(zlib.brotliDecompressSync(v.br), v.buf);
  assert.deepEqual(zlib.gunzipSync(v.gzip), v.buf);
});

test('filled-in pages: one per key, only the last few kept, compressed in the background', async () => {
  write('home.html', '<!doctype html><a href="{{HREF}}">drag me</a>' + '<p>Some text to compress. </p>'.repeat(200));
  const pages = createPages(dir, { origins: 3 }), c = pages.get('home.html');
  let fills = 0;
  const fill = origin => html => { fills++; return html.replaceAll('{{HREF}}', origin); };
  const a = pages.filled(c, 'https://a.example', fill('https://a.example'));
  assert.match(a.buf.toString(), /<a href="https:\/\/a\.example">/);
  assert.equal(a.br, null, 'a new one goes out plain: nobody waits for compression');
  assert.equal(pages.filled(c, 'https://a.example', fill('never')), a, 'the same key is the same copy');
  assert.equal(fills, 1, 'and it is not filled in again');
  await settled();
  assert.deepEqual(zlib.brotliDecompressSync(a.br), a.buf);
  assert.deepEqual(zlib.gunzipSync(a.gzip), a.buf);
  // the key comes from the Host header, so the list is bounded: the least recently used goes first
  for (const k of ['b', 'c']) pages.filled(c, `https://${k}.example`, fill(`https://${k}.example`));
  pages.filled(c, 'https://a.example', fill('never')); // a is used again
  pages.filled(c, 'https://d.example', fill('https://d.example')); // pushes b out, not a
  assert.deepEqual([...c.filled.keys()], ['https://c.example', 'https://a.example', 'https://d.example']);
  assert.equal(fills, 4);
  for (let i = 0; i < 500; i++) pages.filled(c, `https://flood-${i}.example`, fill('x'));
  assert.equal(c.filled.size, 3, 'a flood of made-up hosts cannot grow it');
  await settled();
  // a changed template drops them all
  write('home.html', '<!doctype html><a href="{{HREF}}">drag me, again</a>');
  const next = pages.get('home.html');
  assert.equal(next.filled.size, 0);
  assert.match(pages.filled(next, 'https://a.example', fill('https://a.example')).buf.toString(), /drag me, again/);
  await settled();
});

// ---- sending, over real HTTP ----
let server, origin, handler;
before(async () => {
  server = createServer((req, res) => Promise.resolve(handler(req, res)).catch(e => { res.statusCode = 500; res.end(String(e)); })).listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
// one request, exactly as sent and received: nothing is decoded and no header is added for us
function get(headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(origin + '/', { method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}
const buf = Buffer.from(pageHtml('sent'));
const copies = (which = ['br', 'gzip']) => ({ buf, br: which.includes('br') ? zlib.brotliCompressSync(buf) : null, gzip: which.includes('gzip') ? zlib.gzipSync(buf) : null, queued: new Set() });
const HEADERS = { 'Content-Security-Policy': "default-src 'self'", 'Cache-Control': 'no-cache' };

test('a page goes out in the best encoding that is ready, with its length, Vary and a validator of its own', async () => {
  const v = copies();
  handler = (req, res) => sendEncoded(req, res, v, HEADERS, 'v1');
  const seen = {};
  for (const [accept, enc] of [['gzip, deflate, br, zstd', 'br'], ['gzip', 'gzip'], ['identity', undefined], [undefined, undefined], ['br;q=0, gzip;q=0', undefined]]) {
    const r = await get(accept == null ? {} : { 'Accept-Encoding': accept });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], enc, `Accept-Encoding: ${accept}`);
    assert.deepEqual(decoded(enc, r.body), buf, 'it decodes to the page, byte for byte');
    assert.equal(Number(r.headers['content-length']), r.body.length);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers.vary, 'Accept-Encoding');
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.equal(r.headers['content-security-policy'], "default-src 'self'");
    assert.equal(r.headers.etag, etagFor('v1', enc || 'identity'));
    seen[enc || 'identity'] = r.headers.etag;
  }
  assert.equal(new Set(Object.values(seen)).size, 3, 'each encoding has its own validator');

  // while a copy is still being made, the next best goes out; nothing is compressed for the request
  const gzipOnly = copies(['gzip']), none = copies([]);
  handler = (req, res) => sendEncoded(req, res, gzipOnly, HEADERS, 'v1');
  let r = await get({ 'Accept-Encoding': 'gzip, deflate, br, zstd' });
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.equal(r.headers.etag, 'W/"v1.gz"');
  r = await get({ 'Accept-Encoding': 'br' });
  assert.equal(r.headers['content-encoding'], undefined);
  assert.deepEqual(r.body, buf);
  handler = (req, res) => sendEncoded(req, res, none, HEADERS, 'v1');
  r = await get({ 'Accept-Encoding': 'gzip, deflate, br, zstd' });
  assert.equal(r.headers['content-encoding'], undefined);
  assert.equal(r.headers.etag, 'W/"v1"');
  assert.deepEqual(r.body, buf);
});

test('a browser that holds this version gets a 304 with the headers a 304 needs, and nothing else', async () => {
  const v = copies();
  handler = (req, res) => sendEncoded(req, res, v, HEADERS, 'v1');
  const browser = { 'Accept-Encoding': 'gzip, deflate, br, zstd' };
  const first = await get(browser);
  const again = await get({ ...browser, 'If-None-Match': first.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers.etag, first.headers.etag);
  assert.equal(again.headers.vary, 'Accept-Encoding');
  assert.equal(again.headers['cache-control'], 'no-cache');
  assert.equal(again.headers['content-security-policy'], "default-src 'self'", 'the policy travels with the 304 too');
  for (const h of ['content-encoding', 'content-type', 'content-length']) assert.equal(again.headers[h], undefined, `no ${h} on a 304`);

  // any validator of this version in an encoding the browser still takes will do
  assert.equal((await get({ ...browser, 'If-None-Match': 'W/"v1.gz"' })).status, 304, 'a gzip copy kept from before brotli was ready');
  assert.equal((await get({ ...browser, 'If-None-Match': 'W/"v1.gz"' })).headers.etag, 'W/"v1.gz"', 'the 304 names the copy the browser has');
  assert.equal((await get({ ...browser, 'If-None-Match': 'W/"v1"' })).status, 304);
  assert.equal((await get({ ...browser, 'If-None-Match': '"other", W/"v1.br"' })).status, 304);
  assert.equal((await get({ ...browser, 'If-None-Match': '"v1.br"' })).status, 304, 'compared the weak way');
  assert.equal((await get({ ...browser, 'If-None-Match': '*' })).status, 304);
  assert.equal((await get({ ...browser, 'If-None-Match': '*' })).headers.etag, 'W/"v1.br"');
  // but not one it no longer takes, nor another version's
  const gz = await get({ 'Accept-Encoding': 'gzip', 'If-None-Match': 'W/"v1.br"' });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal((await get({ 'If-None-Match': 'W/"v1.br"' })).status, 200, 'no Accept-Encoding: only the plain copy counts');
  assert.equal((await get({ 'If-None-Match': 'W/"v1"' })).status, 304);
  const stale = await get({ ...browser, 'If-None-Match': 'W/"v0.br"' });
  assert.equal(stale.status, 200);
  assert.deepEqual(zlib.brotliDecompressSync(stale.body), buf);
  // a reload that insists on a fresh copy gets one
  assert.equal((await get({ ...browser, 'If-None-Match': first.headers.etag, 'Cache-Control': 'no-cache' })).status, 200);
  assert.equal((await get({ ...browser, 'If-None-Match': first.headers.etag, 'Cache-Control': 'max-age=0' })).status, 304);

  // just after a restart the brotli copy is not built yet: the browser's copy of it is still good, and saying so needs no compression
  const cold = copies([]);
  handler = (req, res) => sendEncoded(req, res, cold, HEADERS, 'v1');
  const kept = await get({ ...browser, 'If-None-Match': 'W/"v1.br"' });
  assert.equal(kept.status, 304);
  assert.equal(kept.headers.etag, 'W/"v1.br"');
});

test('HEAD gets the headers of the copy it would get, and no body', async () => {
  const v = copies();
  handler = (req, res) => sendEncoded(req, res, v, HEADERS, 'v1');
  const r = await get({ 'Accept-Encoding': 'br' }, 'HEAD');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 0);
  assert.equal(r.headers['content-encoding'], 'br');
  assert.equal(Number(r.headers['content-length']), v.br.length);
  assert.equal(r.headers.etag, 'W/"v1.br"');
  assert.equal((await get({ 'Accept-Encoding': 'br', 'If-None-Match': 'W/"v1.br"' }, 'HEAD')).status, 304);
});

test('a page that is never stored has no validator, and its own Vary is kept', async () => {
  const v = copies();
  handler = (req, res) => sendEncoded(req, res, v, { ...HEADERS, 'Cache-Control': 'no-store', Vary: 'Host, X-Forwarded-Host' });
  const r = await get({ 'Accept-Encoding': 'br', 'If-None-Match': '*' });
  assert.equal(r.status, 200, 'nothing to match, so never a 304');
  assert.equal(r.headers.etag, undefined);
  assert.equal(r.headers.vary, 'Host, X-Forwarded-Host, Accept-Encoding');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(zlib.brotliDecompressSync(r.body), buf);
});

test('big JSON is compressed with the quick settings; small JSON, and browsers that take no encoding, get it plain', async () => {
  const big = { chats: Array.from({ length: 60 }, (_, i) => ({ id: i, title: `What does “section ${i}” mean?`, site: 'example.com', updatedAt: '2026-11-18T10:00:00.000Z' })) };
  const small = { ok: true, chats: [] };
  let value = big;
  handler = (req, res) => sendJson(req, res, value);
  const text = JSON.stringify(big);
  for (const [accept, enc] of [['gzip, deflate, br, zstd', 'br'], ['gzip', 'gzip'], ['identity', undefined], [undefined, undefined], ['br;q=0', undefined]]) {
    const r = await get(accept == null ? {} : { 'Accept-Encoding': accept });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], enc, `Accept-Encoding: ${accept}`);
    assert.equal(decoded(enc, r.body).toString('utf8'), text, 'exactly the JSON that res.json would have sent');
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(r.headers.vary, 'Accept-Encoding');
    assert.equal(Number(r.headers['content-length']), r.body.length);
    if (enc) assert.ok(r.body.length < text.length / 4, `${enc}: ${r.body.length} of ${text.length} bytes`);
  }
  value = small;
  const r = await get({ 'Accept-Encoding': 'gzip, deflate, br, zstd' });
  assert.equal(r.headers['content-encoding'], undefined, 'under a kilobyte it fits in one packet either way');
  assert.equal(r.body.toString(), JSON.stringify(small));
  assert.equal(r.headers.vary, 'Accept-Encoding');
  // the threshold is in bytes of the JSON as sent
  value = { text: 'é'.repeat(506) }; // 1,012 bytes of text: 1,023 with the JSON around it
  assert.equal((await get({ 'Accept-Encoding': 'br' })).headers['content-encoding'], undefined);
  value = { text: 'é'.repeat(507) }; // 1,025
  assert.equal((await get({ 'Accept-Encoding': 'br' })).headers['content-encoding'], 'br');
  // and what would not get smaller is sent as it is
  handler = (req, res) => sendJson(req, res, { text: 'k9$Zq' }, 1);
  const tiny = await get({ 'Accept-Encoding': 'br' });
  assert.equal(tiny.headers['content-encoding'], undefined);
  assert.equal(tiny.body.toString(), '{"text":"k9$Zq"}');
  handler = (req, res) => sendJson(req, res, value);
  // HEAD: the headers, no body
  value = big;
  const head = await get({ 'Accept-Encoding': 'br' }, 'HEAD');
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-encoding'], 'br');
  // something already encoded is never encoded again
  handler = (req, res) => { res.setHeader('Content-Encoding', 'gzip'); return sendJson(req, res, big); };
  const once2 = await get({ 'Accept-Encoding': 'br' });
  assert.equal(once2.headers['content-encoding'], 'gzip');
  assert.equal(once2.body.toString(), text, 'the body was left as it was');
  // a status set before is kept
  handler = (req, res) => { res.statusCode = 404; return sendJson(req, res, big); };
  assert.equal((await get({ 'Accept-Encoding': 'br' })).status, 404);
});

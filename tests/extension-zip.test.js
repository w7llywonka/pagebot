import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { EXT_HASH, EXT_ID, EXT_KEY, EXT_VERSION, contentScript, crc32, extensionFiles, extensionZip, fingerprint, idFromKey, manifest, pageCode, zip } from '../lib/extension.js';
import { readZip } from './helpers/unzip.mjs';

// The browser extension's zip (README "Browser extension"), made by the server with Node's own zlib and a hand-written
// CRC-32 and zip headers: a valid zip, the files Load unpacked needs at its root, the address baked in and no other, no
// code from anywhere else, and the bookmark's reviewed page code reused word for word.
const root = fileURLToPath(new URL('../', import.meta.url));
const bookmarklet = readFileSync(path.join(root, 'bookmarklet.js'), 'utf8');
const ORIGIN = 'https://pagebot.example.test';
const NAMES = ['manifest.json', 'sidepanel.html', 'sidepanel.js', 'worker.js', 'content.js', 'icons/', 'icons/16.png', 'icons/32.png', 'icons/48.png', 'icons/128.png', 'README.txt'];
const files = origin => Object.fromEntries(readZip(extensionZip(origin)).map(f => [f.name, f]));
const text = (origin, name) => files(origin)[name].data.toString('utf8');

test('crc32 matches the standard check values (and zlib’s own, where Node has it)', () => {
  assert.equal(crc32('123456789'), 0xcbf43926);
  assert.equal(crc32(''), 0);
  assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  if (typeof zlib.crc32 === 'function') for (let i = 0; i < 20; i++) {
    const b = Buffer.from(Array.from({ length: 1 + i * 97 }, (_, k) => (k * 31 + i * 7) & 255));
    assert.equal(crc32(b), zlib.crc32(b) >>> 0);
  }
});

test('the zip is well formed: every file’s CRC and size match, at the root, in order, with an icons/ folder', () => {
  const z = extensionZip(ORIGIN), list = readZip(z);
  assert.deepEqual(list.map(f => f.name), NAMES);
  for (const f of list) {
    assert.ok(!f.name.startsWith('/') && !f.name.includes('..') && !f.name.includes('\\'), f.name);
    assert.equal(f.flags, 0x0800, 'names are marked UTF-8');
    if (f.name.endsWith('/')) { assert.equal(f.data.length, 0); assert.equal(f.method, 0); assert.equal(f.attrs, 0x10); continue; }
    assert.equal(crc32(f.data), f.crc, `${f.name}: CRC`);
    assert.ok([0, 8].includes(f.method));
  }
  assert.ok(list.some(f => f.method === 8), 'the scripts are deflated');
  assert.ok(z.length < 200_000, `small enough: ${z.length} bytes`);
});

test('unzip agrees the zip is fine (where unzip is installed)', t => {
  let have = true; try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { have = false; }
  if (!have) return t.skip('unzip isn’t installed here');
  const dir = mkdtempSync(path.join(tmpdir(), 'pbzip-'));
  try {
    const f = path.join(dir, 'pagebot-extension.zip');
    writeFileSync(f, extensionZip(ORIGIN));
    const out = execFileSync('unzip', ['-t', f]).toString();
    assert.match(out, /No errors detected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the same address makes the same bytes; another address changes only where it is baked in', () => {
  assert.equal(Buffer.compare(zip(extensionFiles(ORIGIN)), zip(extensionFiles(ORIGIN))), 0, 'built twice, the same bytes');
  assert.equal(Buffer.compare(zip(extensionFiles(ORIGIN)), extensionZip(ORIGIN)), 0);
  const a = extensionFiles(ORIGIN), b = extensionFiles('http://localhost:3000');
  for (let i = 0; i < a.length; i++) {
    const x = String(a[i].data ?? ''), y = String(b[i].data ?? '');
    const host = s => s.replaceAll('https://pagebot.example.test', 'ORIGIN').replaceAll('pagebot.example.test', 'HOST').replaceAll('http://localhost:3000', 'ORIGIN').replaceAll('localhost:3000', 'HOST');
    assert.equal(host(x), host(y), a[i].name);
  }
});

test('manifest.json: Manifest V3, only the permissions it needs, the fixed id, the side panel, and a page policy that frames only this server', () => {
  const m = JSON.parse(text(ORIGIN, 'manifest.json'));
  assert.deepEqual(m, manifest(ORIGIN));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.version, String(EXT_VERSION));
  assert.deepEqual(m.permissions, ['sidePanel', 'scripting', 'tabs', 'storage', 'debugger', 'contextMenus']);
  assert.deepEqual(m.host_permissions, ['<all_urls>']);
  assert.equal(m.key, EXT_KEY);
  assert.equal(idFromKey(m.key), EXT_ID);
  assert.equal(EXT_ID, 'inknjdpepdgianddhnnpkdbpkjbbiomg');
  assert.deepEqual(m.side_panel, { default_path: 'sidepanel.html' });
  assert.deepEqual(m.background, { service_worker: 'worker.js' });
  assert.equal(m.commands._execute_action.suggested_key.default, 'Alt+Shift+P');
  assert.match(m.description, /pagebot\.example\.test/);
  const csp = m.content_security_policy.extension_pages;
  assert.match(csp, /(^|; )frame-src https:\/\/pagebot\.example\.test(;|$)/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /connect-src 'none'/);
  for (const k of ['externally_connectable', 'web_accessible_resources', 'content_scripts', 'update_url']) assert.equal(k in m, false, k);
  for (const s of [16, 32, 48, 128]) assert.equal(m.icons[s], `icons/${s}.png`);
});

test('the address is baked in, and no placeholder is left anywhere', () => {
  const f = files(ORIGIN);
  assert.match(f['sidepanel.js'].data.toString(), /const ORIGIN = "https:\/\/pagebot\.example\.test", EXT_V = 1;/);
  for (const [name, x] of Object.entries(f)) assert.doesNotMatch(x.data.toString('latin1'), /__ORIGIN__|__EXT_VERSION__/, name);
  assert.match(f['README.txt'].data.toString(), /Made for https:\/\/pagebot\.example\.test\. Version 1\./);
  assert.match(f['README.txt'].data.toString(), /the pin next to pagebot\n   \(in Edge, the eye\)\./, 'Edge’s extensions menu has an eye, not a pin');
  assert.match(f['README.txt'].data.toString(), /chrome:\/\/extensions \(in Edge, Reload\)\./);
  assert.throws(() => extensionFiles('javascript:alert(1)'), /plain http\(s\) origin/);
  assert.throws(() => extensionFiles('https://a.test/"x'), /plain http\(s\) origin/);
});

test('no code from anywhere else: no other address, no eval or imports, no inline script, nothing a web page can call', () => {
  const f = files(ORIGIN);
  for (const name of ['sidepanel.js', 'worker.js', 'content.js', 'sidepanel.html']) {
    const s = f[name].data.toString();
    const urls = s.match(/https?:\/\/[^\s"'`)<>]+/g) || [];
    // (worker.js's "Ask pagebot" item shows on every web page: its match patterns name no address)
    const shown = name === 'worker.js' ? ['http://*/*', 'https://*/*'] : [];
    assert.deepEqual(urls.filter(u => !u.startsWith(ORIGIN) && !shown.includes(u)), [], `${name} names no other address`);
    for (const bad of [/\beval\s*\(/, /new Function\b/, /\bimport\s*\(/, /importScripts/, /onMessageExternal/, /onConnectExternal/, /externally_connectable/]) assert.doesNotMatch(s, bad, `${name}: ${bad}`);
  }
  const html = f['sidepanel.html'].data.toString();
  assert.deepEqual(html.match(/<script\b[^>]*>/g), ['<script src="sidepanel.js">']);
  assert.match(html, /<script src="sidepanel.js"><\/script>/, 'the only script is the file, and nothing inline');
  assert.doesNotMatch(html, /\son\w+=/i, 'no inline handlers');
  const content = f['content.js'].data.toString();
  assert.doesNotMatch(content, /addEventListener\(\s*["']message["']/, 'the page side never listens to window messages');
  assert.doesNotMatch(content, /postMessage/, 'and never posts them');
  const panel = f['sidepanel.js'].data.toString();
  assert.match(panel, /e\.source !== frame\.contentWindow \|\| e\.origin !== ORIGIN/, 'the side panel obeys only the pagebot frame');
  assert.doesNotMatch(panel, /postMessage\([^)]*'\*'\)/, 'and never posts to any origin');
});

test('content.js is the bookmark’s page-action code, word for word, plus the extension’s part, and it compiles', () => {
  const content = text(ORIGIN, 'content.js');
  new vm.Script(content);
  const code = pageCode(bookmarklet);
  assert.ok(content.includes(code));
  assert.ok(code.startsWith('P.unmark=function(){') && code.includes('P.act=function(d)') && code.includes('P.bad=function(e)') && code.includes('P.tool=function(n,i)'));
  assert.doesNotMatch(code, /postMessage|\bO\b|__ORIGIN__/, 'the reused part never talks to a window or names an origin');
  assert.throws(() => pageCode(bookmarklet.replace('P.unmark=function(){', 'P.unmarked=function(){')), /page-action block/);
  assert.throws(() => pageCode(bookmarklet + '\nP.unmark=function(){}'), /page-action block/);
  assert.throws(() => pageCode(bookmarklet.replace('W.addEventListener("message",function(e){', '')), /page-action block/);
  assert.equal(contentScript(bookmarklet, '').includes(code), true);
});

// a page with nothing on it, enough for the page code to start and answer
function fakePage(gen) {
  let listener = null;
  const el = () => ({ nodeType: 1, tagName: 'DIV', isConnected: true, getAttribute: () => null, getClientRects: () => [1], closest: () => null });
  const doc = { addEventListener() {}, querySelectorAll: () => [], body: null, documentElement: el(), title: 'Empty', contentType: 'text/html', activeElement: null };
  const win = { document: doc, addEventListener() {}, getSelection: () => '', innerWidth: 800, innerHeight: 600, __pbxGen: gen };
  win.window = win; win.top = win;
  const chrome = { runtime: { id: 'ourid', getURL: p => 'chrome-extension://ourid/' + p, sendMessage: () => Promise.resolve(), onMessage: { addListener: f => { listener = f; } } } };
  const ctx = vm.createContext({ window: win, document: doc, chrome, getComputedStyle: () => ({}), location: { href: 'https://news.example.test/a', origin: 'https://news.example.test' }, performance: { getEntriesByType: () => [] }, URL, setTimeout, clearTimeout });
  vm.runInContext(text(ORIGIN, 'content.js'), ctx);
  const ask = (m, sender = { id: 'ourid', url: 'chrome-extension://ourid/sidepanel.html?win=3' }) => { let out; listener(m, sender, r => { out = r; }); return out === undefined ? out : JSON.parse(JSON.stringify(out)); }; // (out of the page's realm)
  return { ask, P: win.__pbx, el };
}

test('the page side answers only pagebot’s side panel page, like the bookmark answers its panel, and numbers refs from its own block', () => {
  const { ask, P, el } = fakePage(3);
  assert.deepEqual(ask({ t: 'act', d: { name: 'els', input: { query: '' } } }), { els: [], more: 0 });
  assert.deepEqual(ask({ t: 'ping' }), { ok: 1, pdf: false, top: true });
  assert.equal(ask({ t: 'ping' }, { id: 'another', url: 'chrome-extension://another/sidepanel.html' }), undefined, 'another extension');
  assert.equal(ask({ t: 'ping' }, { id: 'ourid', url: 'https://news.example.test/a', tab: { id: 4 } }), undefined, 'our own helper in another tab');
  assert.equal(ask({ t: 'ping' }, { id: 'ourid', url: 'chrome-extension://ourid/worker.js' }), undefined, 'not the worker either');
  assert.equal(P.rf(el()), 'ref_300001', 'the first ref of the third document');
  assert.equal(P.el('ref_1'), null, 'a ref from an earlier page names nothing here');
  assert.equal(P.el('ref_300001')?.tagName, 'DIV');
  assert.deepEqual(ask({ t: 'tool', name: 'read_page', input: { ref: 'ref_7' } }), { error: "That ref isn't on the page anymore. Use read_page or find again." });
  assert.deepEqual(ask({ t: 'guard' }), { filled: false });
  assert.deepEqual(ask({ t: 'mystery' }), { error: 'The page doesn’t know that.' });
});

test('the icons are real PNGs at 16, 32, 48 and 128 pixels', () => {
  const f = files(ORIGIN);
  for (const s of [16, 32, 48, 128]) {
    const b = f[`icons/${s}.png`].data;
    assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let p = 8;
    const types = [];
    while (p < b.length) {
      const len = b.readUInt32BE(p), type = b.subarray(p + 4, p + 8).toString('ascii'), data = b.subarray(p + 8, p + 8 + len);
      assert.equal(b.readUInt32BE(p + 8 + len), crc32(b.subarray(p + 4, p + 8 + len)), `${s}: ${type} CRC`);
      if (type === 'IHDR') { assert.equal(data.readUInt32BE(0), s); assert.equal(data.readUInt32BE(4), s); assert.equal(data[8], 8); assert.equal(data[9], 6); }
      if (type === 'IDAT') assert.equal(zlib.inflateSync(data).length, s * (1 + s * 4));
      types.push(type); p += 12 + len;
    }
    assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  }
});

test('the extension’s files haven’t changed without a new EXT_VERSION', () => {
  assert.equal(fingerprint(), EXT_HASH, 'The extension’s files changed: raise EXT_VERSION and update EXT_HASH in lib/extension.js');
});

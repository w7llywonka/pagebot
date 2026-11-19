// The browser extension (README "Browser extension"): pagebot in Chrome's, Edge's or Brave's side panel, downloaded from
// Settings as a zip and installed with "Load unpacked". Everything it runs ships in the zip (Manifest V3 allows no remote
// code); the panel itself is this server's /widget, framed by the side panel page. The zip is made here with Node's own
// zlib and a hand-written CRC-32 and zip headers, with the address the person opened pagebot from baked in, the same way
// the homepage bakes it into the bookmark. Nothing here knows about accounts or the database, so it's tested on its own.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The extension's own version, separate from the bookmark's VERSION. Raise it whenever anything in extension/ (or the
// bookmark code content.js reuses) changes, and update EXT_HASH: side panels running an older copy then say so.
export const EXT_VERSION = 1;
// The manifest's public key fixes the extension's id, so /widget's frame-ancestors can name this one extension and nothing
// broader. Only the public half exists in the repo; Load unpacked needs no private key.
export const EXT_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4Stx6g4v0stj043q7gXhchenuHm2oxSDq/hroQXcidxS0AMPn6QZwhDPybODd7xHmvX91k+MQMuJzvYTvDi4LWqJ0eWhU/OrYG3aDzM3h8TD8JJaQmODJYPJe/KZbO3oGaE1PpEeSqNhUYUlHhtM2u2XXfuZmQm+47JqvEEVqGuHcat7/1M94Yt+JdKG7uBNrD0t+zE2X+axnNKpsRRRpyiaNeuNnMEkPslHCG153pl93yDN9oZySEB+Fe1dyIDxp1A6RWRgA5u9nQ7n5E7mE6BjnYbSc+ASqAUBFHqwh1FsMF/igiH/z9xanStyPqPUXkD4dzvqSikkh8PcRsJEwQIDAQAB';
// Chromium's id for a key: the first 128 bits of the key's SHA-256, each hex digit written as a letter from a to p
export const idFromKey = key => crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  .replace(/./g, c => String.fromCharCode(97 + parseInt(c, 16)));
export const EXT_ID = idFromKey(EXT_KEY); // inknjdpepdgianddhnnpkdbpkjbbiomg
// A fingerprint of every file the zip holds (for a fixed stand-in address). tests/extension-zip.test.js works it out again,
// so changing the extension without raising EXT_VERSION fails the tests.
export const EXT_HASH = '0dc1243cd1fba3cbf38466e1820e39a54be07ec577e400bf512f07e5dea6db04';

// ---------- CRC-32 and zip ----------
const CRC_TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
export function crc32(buf) {
  if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
// files: [{ name, data }] in order, names with forward slashes, a directory as "name/" with no data. One fixed time
// (2026-01-01 00:00), so the same files always make the same bytes. No zip64: the whole thing is well under a megabyte.
const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
export function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), dir = f.name.endsWith('/');
    const raw = dir ? Buffer.alloc(0) : Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const packed = dir ? raw : zlib.deflateRawSync(raw, { level: 9 }), store = dir || packed.length >= raw.length;
    const body = store ? raw : packed, method = store ? 0 : 8, crc = dir ? 0 : crc32(raw);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(method, 8);
    h.writeUInt16LE(DOS_TIME, 10); h.writeUInt16LE(DOS_DATE, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(method, 10);
    c.writeUInt16LE(DOS_TIME, 12); c.writeUInt16LE(DOS_DATE, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(dir ? 0x10 : 0, 38); c.writeUInt32LE(offset, 42);
    locals.push(h, name, body); centrals.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- icons: a speech bubble with a "p", drawn as pixels and written as PNGs ----------
const ICON = [
  '................',
  '....bbbbbbbb....',
  '..bbaaaaaaaabb..',
  '.baaaaaaaaaaaab.',
  '.baaaccccaaaaab.',
  'baaaaccaacaaaaab',
  'baaaaccaacaaaaab',
  'baaaaccccaaaaaab',
  'baaaaccaaaaaaaab',
  '.baaaccaaaaaaab.',
  '.baaaaaaaaaaaab.',
  '..bbaaaaaaaabb..',
  '...bbaabbbbbb...',
  '...baab.........',
  '..bab...........',
  '..bb............',
];
const INK = { '.': [0, 0, 0, 0], b: [0x1f, 0x19, 0x15, 255], a: [0xf4, 0xa8, 0x82, 255], c: [0xf6, 0xec, 0xe2, 255] };
function chunk(type, data) {
  const len = Buffer.alloc(4), t = Buffer.from(type, 'ascii'), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
export function png(size) {
  const k = size / 16, rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0, then RGBA
    for (let x = 0; x < size; x++) Buffer.from(INK[ICON[Math.floor(y / k)][Math.floor(x / k)]]).copy(row, 1 + x * 4);
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const ICON_SIZES = [16, 32, 48, 128];
const ICONS = Object.fromEntries(ICON_SIZES.map(s => [s, png(s)]));

// ---------- the files ----------
export function manifest(origin) {
  const host = new URL(origin).host;
  return {
    manifest_version: 3,
    name: 'pagebot',
    version: String(EXT_VERSION),
    description: `pagebot in your browser’s side panel, for ${host}.`,
    key: EXT_KEY,
    minimum_chrome_version: '116',
    permissions: ['sidePanel', 'scripting', 'tabs', 'storage', 'debugger'],
    host_permissions: ['<all_urls>'],
    background: { service_worker: 'worker.js' },
    side_panel: { default_path: 'sidepanel.html' },
    action: { default_title: 'Open pagebot', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
    icons: Object.fromEntries(ICON_SIZES.map(s => [s, `icons/${s}.png`])),
    commands: { _execute_action: { suggested_key: { default: 'Alt+Shift+P' }, description: 'Open pagebot' } },
    // the side panel page can frame only this pagebot server, and fetch nothing itself
    content_security_policy: { extension_pages: `default-src 'self'; script-src 'self'; object-src 'none'; frame-src ${origin}; connect-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'` },
  };
}

// The bookmark's page-action code, verbatim: protected fields (P.bad), where a click goes (P.go), click and fill (P.act),
// the page tree, find and highlights. bookmarklet.js is frozen at v14, so these anchors can't move; if a future bookmark
// changes them, this throws and the zip test fails before anything ships.
const START = 'P.unmark=function(){', END = 'W.addEventListener("message",function(e){';
export function pageCode(src) {
  const a = src.indexOf(START), b = src.indexOf(END);
  if (a < 0 || b < a || src.indexOf(START, a + 1) >= 0 || src.indexOf(END, b + 1) >= 0) throw new Error('bookmarklet.js no longer has the page-action block the extension reuses');
  return src.slice(a, b);
}
export const contentScript = (src, own) => `// pagebot extension: the page side. Built from bookmarklet.js (v14) and extension/content.js.
(function(){
if (window.__pbx && window.__pbx.alive()) return;
var W = window, D = document, P = window.__pbx = {};
${pageCode(src)}
${own}
})();
`;

// read on first use, so a server without the extension's files still starts (and the zip route says it isn't available)
let src = null;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = () => src ||= { bookmarklet: read('bookmarklet.js'), sidepanelHtml: read('extension/sidepanel.html'), sidepanel: read('extension/sidepanel.js'),
  worker: read('extension/worker.js'), content: read('extension/content.js') };

const readme = origin => `pagebot for your browser's side panel
======================================

Made for ${origin}. Version ${EXT_VERSION}.

Works in Chrome, Edge and Brave on a computer.

1. Unzip pagebot-extension.zip. You get a folder called pagebot-extension.
2. In a new tab, go to chrome://extensions (in Edge it's edge://extensions).
3. Turn on Developer mode. It's a switch at the top right (in Edge, in the left column).
4. Click Load unpacked and choose the pagebot-extension folder.
5. Pin pagebot: click the puzzle piece next to the address bar, then the pin next to pagebot.
6. Click the pagebot button, or press Alt+Shift+P, to open it in the side panel.
7. Sign in there if it asks. If you use pagebot's chat page in this browser, you're already signed in.

Keep this folder: your browser loads pagebot from it. To update, download the new zip from
pagebot's Settings, put its files here in place of these, and click the reload arrow on pagebot
in chrome://extensions.

pagebot never reads or types into password, payment card or file fields, and it always asks
before it goes to another site.
`;

// every file in the zip, in order, with the address baked in
export function extensionFiles(origin) {
  if (!/^https?:\/\/[^/?#\s"'\\]+$/.test(origin)) throw new Error('The extension needs a plain http(s) origin');
  const bake = s => s.replaceAll('"__ORIGIN__"', JSON.stringify(origin)).replaceAll('__EXT_VERSION__', String(EXT_VERSION));
  const S = SRC();
  const files = [
    { name: 'manifest.json', data: JSON.stringify(manifest(origin), null, 2) + '\n' },
    { name: 'sidepanel.html', data: S.sidepanelHtml },
    { name: 'sidepanel.js', data: bake(S.sidepanel) },
    { name: 'worker.js', data: bake(S.worker) },
    { name: 'content.js', data: contentScript(S.bookmarklet, bake(S.content)) },
    { name: 'icons/' },
    ...ICON_SIZES.map(s => ({ name: `icons/${s}.png`, data: ICONS[s] })),
    { name: 'README.txt', data: readme(origin) },
  ];
  for (const f of files) if (typeof f.data === 'string' && /__ORIGIN__|__EXT_VERSION__/.test(f.data)) throw new Error(`${f.name} still has a placeholder`);
  return files;
}
// the fingerprint EXT_HASH holds
export function fingerprint() {
  const h = crypto.createHash('sha256');
  for (const f of extensionFiles('https://fingerprint.invalid')) h.update(f.name + '\0').update(f.data ?? '').update('\0');
  return h.digest('hex');
}
// the zip for one address; the last few are kept (the Host header picks the address, so the list is short)
const zips = new Map();
export function extensionZip(origin) {
  let z = zips.get(origin);
  if (!z) {
    z = zip(extensionFiles(origin));
    zips.set(origin, z);
    if (zips.size > 8) zips.delete(zips.keys().next().value);
  }
  return z;
}

// Build a self-contained, site-bound unpacked extension without runtime ZIP dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FOLDER = 'pagebot-extension/';
const RUNTIME_FILES = ['background.js', 'panel.html', 'panel.js', 'panel.css'];
const ICON_FILES = ['icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png'];
const PERMISSIONS = new Set(['activeTab', 'scripting', 'sidePanel', 'contextMenus', 'storage']);

export function extensionOrigin(value) {
  if (typeof value !== 'string' || !/^https?:\/\/(?:\[[a-f\d:.]+\]|[^\s/?#@:\\]+)(?::\d{1,5})?$/i.test(value))
    throw new TypeError('The extension requires a valid HTTPS site origin.');
  let url;
  try { url = new URL(value); } catch { throw new TypeError('The extension requires a valid HTTPS site origin.'); }
  if (!/^(?:[a-z\d.-]+|\[[a-f\d:.]+\])$/i.test(url.hostname)) throw new TypeError('The extension requires a valid HTTPS site origin.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)))
    throw new TypeError('The extension requires HTTPS, except on localhost.');
  return url.origin;
}

export function createPageTools(bookmarklet) {
  const start = bookmarklet.indexOf('P.unmark=function');
  const end = bookmarklet.indexOf('W.addEventListener("message"', start);
  if (start < 0 || end <= start) throw new Error('The bookmarklet DOM-tool boundaries changed.');
  // These are the same protected-field and navigation checks as the bookmarklet. The extension runs
  // them in an ISOLATED world, without creating an overlay or accepting webpage messages.
  return '(function(){\nif(globalThis.__pagebotExtensionTools)return;\nvar W=window,D=document,ID="__pagebot",P={};\n' +
    bookmarklet.slice(start, end) + '\nglobalThis.__pagebotExtensionTools=P;\n})();\n';
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1;
  return i >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [filename, contents] of files) {
    const name = Buffer.from(FOLDER + filename, 'utf8');
    const plain = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
    const compressed = zlib.deflateRawSync(plain);
    const packed = compressed.length < plain.length ? compressed : plain, method = packed === plain ? 0 : 8;
    const crc = crc32(plain), header = Buffer.alloc(30), entry = Buffer.alloc(46);
    // A fixed DOS date makes the same source/origin build reproducible. All names are UTF-8.
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(method, 8); header.writeUInt16LE(0x5c21, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(plain.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, packed);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(method, 10); entry.writeUInt16LE(0x5c21, 14); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(plain.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42); central.push(entry, name);
    offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function fileStamp(file, optional = false) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error('Not a file: ' + path.basename(file));
    return [stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  } catch (error) { if (optional && error.code === 'ENOENT') return '-'; throw error; }
}
function manifests(template, origin, version, have) {
  if (template.manifest_version !== 3 || !Array.isArray(template.permissions) || template.permissions.some(p => !PERMISSIONS.has(p)))
    throw new Error('The extension manifest has unsupported permissions or format.');
  if (template.host_permissions?.length || template.optional_host_permissions?.length || template.externally_connectable)
    throw new Error('The extension template must not grant external access.');
  const manifest = { ...template, version: `1.0.${version}`, version_name: `Pagebot ${version}`,
    host_permissions: [origin + '/*'],
    content_security_policy: { extension_pages: `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-src ${origin};` },
  };
  for (const group of [manifest.icons, manifest.action?.default_icon]) if (group && typeof group === 'object') {
    for (const name of Object.values(group)) if (!ICON_FILES.includes(name) || !have.has(name)) throw new Error('Missing or unsupported extension icon.');
  }
  return manifest;
}

export function createExtensionPackager({ root = ROOT, cacheSize = 8 } = {}) {
  if (!Number.isInteger(cacheSize) || cacheSize < 1 || cacheSize > 32) throw new TypeError('Invalid extension cache size.');
  const directory = path.join(root, 'extension'), cache = new Map();
  let snapshot, stamp;
  return function build(origin, version) {
    origin = extensionOrigin(origin);
    if (!Number.isInteger(version) || version < 1 || version > 65535) throw new TypeError('Invalid extension version.');
    const paths = ['manifest.template.json', ...RUNTIME_FILES, ...ICON_FILES];
    const stamps = paths.map(name => fileStamp(path.join(directory, name), ICON_FILES.includes(name)));
    const next = [...stamps, fileStamp(path.join(root, 'bookmarklet.js'))].join('|');
    if (next !== stamp) {
      const files = new Map();
      paths.forEach((name, i) => { if (name !== 'manifest.template.json' && stamps[i] !== '-') files.set(name, fs.readFileSync(path.join(directory, name))); });
      snapshot = { template: JSON.parse(fs.readFileSync(path.join(directory, 'manifest.template.json'), 'utf8')), files,
        tools: createPageTools(fs.readFileSync(path.join(root, 'bookmarklet.js'), 'utf8')) };
      stamp = next; cache.clear();
    }
    const key = origin + '|' + version;
    if (cache.has(key)) { const hit = cache.get(key); cache.delete(key); cache.set(key, hit); return hit; }
    const files = new Map(snapshot.files);
    files.set('manifest.json', JSON.stringify(manifests(snapshot.template, origin, version, files), null, 2) + '\n');
    files.set('config.js', 'globalThis.PAGEBOT_CONFIG = Object.freeze(' + JSON.stringify({ origin, version }) + ');\n');
    files.set('page-tools.js', snapshot.tools);
    files.set('README.txt', `Pagebot extension (v${version})\nConnected to: ${origin}\n\n` +
      '1. Extract this ZIP and keep the extracted folder.\n2. Open chrome://extensions (Chrome) or edge://extensions (Edge).\n' +
      '3. Turn on Developer mode, choose Load unpacked, and select the pagebot-extension folder containing manifest.json.\n' +
      '4. Pin Pagebot using the browser Extensions button, then click Pagebot on the page you want to use.\n' +
      '5. Sign in to your Pagebot account if asked. Your existing account permissions and limits still apply.\n\n' +
      'The extension opens a native side panel and can capture the connected tab without a screen-sharing picker.\n' +
      'Page access is granted when you invoke Pagebot. It does not request access to all websites or your browsing history.\n' +
      `Its only permanent site permission is ${origin}, so the embedded chat can use your existing sign-in.\n` +
      'Browser-internal pages, extension stores, and other protected pages cannot be read or controlled.\n' +
      'To update, extract a fresh ZIP over this folder and click Reload on the browser extensions page.\n');
    const result = zip(files);
    cache.set(key, result); while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    return result;
  };
}

export const buildExtensionZip = createExtensionPackager();

// Kept with the packager so the actual download response can be tested without a database.
export function sendExtensionZip(res, origin, version) {
  try {
    const archive = buildExtensionZip(origin, version);
    res.set({
      'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="pagebot-extension.zip"',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
      Vary: 'Host, X-Forwarded-Host, X-Forwarded-Proto',
    });
    return res.send(archive);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return res.status(400).type('text/plain').send('Download the extension from the HTTPS Pagebot site (or localhost for development).');
  }
}

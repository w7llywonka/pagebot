import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createExtensionPackager, createPageTools, extensionOrigin, crc32 } from '../lib/extension-package.js';

const roots = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const bookmarklet = fs.readFileSync(new URL('../bookmarklet.js', import.meta.url), 'utf8');
function fixture({ cacheSize = 8, manifest = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagebot-extension-package-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'extension/icons'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extension/manifest.template.json'), JSON.stringify({ manifest_version: 3, name: 'Pagebot', version: '1.0.0', minimum_chrome_version: '116',
    permissions: ['activeTab', 'scripting', 'sidePanel', 'contextMenus', 'storage'], background: { service_worker: 'background.js' }, side_panel: { default_path: 'panel.html' },
    icons: { 16: 'icons/icon16.png' }, action: { default_icon: { 16: 'icons/icon16.png' } }, ...manifest }));
  for (const file of ['background.js', 'panel.js']) fs.writeFileSync(path.join(root, 'extension', file), '/* local code only */\n');
  fs.writeFileSync(path.join(root, 'extension/panel.html'), '<!doctype html><script src="config.js"></script><script src="panel.js"></script>');
  fs.writeFileSync(path.join(root, 'extension/panel.css'), 'body{margin:0}');
  fs.writeFileSync(path.join(root, 'extension/icons/icon16.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(root, 'bookmarklet.js'), bookmarklet);
  fs.writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=never-package-this');
  fs.writeFileSync(path.join(root, 'extension/private.txt'), 'not-an-allowed-file');
  return { root, build: createExtensionPackager({ root, cacheSize }) };
}
// Read the ZIP independently through its central directory, checking the local headers and CRC.
function unpack(buffer) {
  const eocd = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(eocd), 0x06054b50);
  const count = buffer.readUInt16LE(eocd + 10), files = new Map();
  let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(p), 0x02014b50);
    const method = buffer.readUInt16LE(p + 10), expectedCRC = buffer.readUInt32LE(p + 16), size = buffer.readUInt32LE(p + 20), plainSize = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28), extra = buffer.readUInt16LE(p + 30), comment = buffer.readUInt16LE(p + 32), offset = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50); assert.equal(buffer.readUInt16LE(offset + 8), method);
    const dataStart = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const packed = buffer.subarray(dataStart, dataStart + size), plain = method === 8 ? zlib.inflateRawSync(packed) : packed;
    assert.equal(plain.length, plainSize); assert.equal(crc32(plain), expectedCRC);
    assert.ok(name.startsWith('pagebot-extension/') && !name.includes('..') && !name.includes('\\'));
    files.set(name.slice('pagebot-extension/'.length), plain);
    p += 46 + nameLength + extra + comment;
  }
  assert.equal(p, eocd); return files;
}

test('the ZIP contains a site-bound load-unpacked extension, original tools, and no server secrets', () => {
  const { build } = fixture(), bytes = build('https://pagebot.example', 14), files = unpack(bytes);
  assert.deepEqual([...files.keys()].sort(), ['README.txt', 'background.js', 'config.js', 'icons/icon16.png', 'manifest.json', 'page-tools.js', 'panel.css', 'panel.html', 'panel.js']);
  const manifest = JSON.parse(files.get('manifest.json'));
  assert.equal(manifest.manifest_version, 3); assert.equal(manifest.version, '1.0.14'); assert.equal(manifest.minimum_chrome_version, '116');
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'sidePanel', 'contextMenus', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://pagebot.example/*']);
  assert.equal(manifest.background.service_worker, 'background.js'); assert.equal(manifest.side_panel.default_path, 'panel.html');
  assert.equal(manifest.content_security_policy.extension_pages, "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-src https://pagebot.example;");
  const context = vm.createContext({}); vm.runInContext(files.get('config.js').toString(), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.PAGEBOT_CONFIG)), { origin: 'https://pagebot.example', version: 14 });
  assert.equal(vm.runInContext('Object.isFrozen(PAGEBOT_CONFIG)', context), true);
  assert.match(files.get('README.txt').toString(), /Load unpacked/);
  for (const [name, data] of files) {
    assert.doesNotMatch(data.toString(), /never-package-this|not-an-allowed-file|ANTHROPIC_API_KEY/);
    if (name.endsWith('.js')) new vm.Script(data.toString());
  }
});

test('ZIP records work with the standard Python zipfile reader', () => {
  const { root, build } = fixture(), file = path.join(root, 'extension.zip'); fs.writeFileSync(file, build('https://pagebot.example', 14));
  const result = execFileSync('python', ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps(json.loads(z.read("pagebot-extension/manifest.json"))))', file], { encoding: 'utf8' });
  assert.equal(JSON.parse(result).version, '1.0.14');
});

test('source changes invalidate cached ZIPs; bounded cache eviction rebuilds reproducibly', () => {
  const { root, build } = fixture({ cacheSize: 2 });
  const a = build('https://one.example', 14), b = build('https://two.example', 14);
  assert.equal(build('https://one.example', 14), a);
  build('https://three.example', 14);
  const again = build('https://two.example', 14); assert.notEqual(again, b); assert.deepEqual(again, b);
  fs.writeFileSync(path.join(root, 'extension/panel.js'), '/* changed locally */\n');
  const changed = build('https://one.example', 14); assert.notDeepEqual(changed, a);
  assert.equal(unpack(changed).get('panel.js').toString(), '/* changed locally */\n');
  assert.notDeepEqual(build('https://one.example', 15), changed);
});

test('origins are validated and normalized before becoming CSP, permissions, or configuration', () => {
  assert.equal(extensionOrigin('https://PAGEBOT.example:443'), 'https://pagebot.example');
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:8000', 'http://[::1]:3000']) assert.equal(extensionOrigin(origin), origin);
  for (const origin of ['http://public.example', 'https://person:password@pagebot.example', 'https://pagebot.example/', 'https://pagebot.example/path', 'https://pagebot.example?x=1', 'https://pagebot.example#x', 'javascript:alert(1)', 'file:///etc/passwd', 'https://pagebot.example;script-src', "https://pagebot.example'", ' https://pagebot.example', 'https://pagebot.example\\x', 'https://pagebot.example\n'])
    assert.throws(() => extensionOrigin(origin), /HTTPS|origin/);
  const { build } = fixture(); for (const version of [0, -1, 1.5, 65536, '14', null]) assert.throws(() => build('https://pagebot.example', version), /version/);
});

test('an unexpected manifest permission or external connection is rejected rather than shipped', () => {
  for (const manifest of [{ permissions: ['debugger'] }, { host_permissions: ['<all_urls>'] }, { optional_host_permissions: ['https://*/*'] }, { externally_connectable: { matches: ['https://*/*'] } }, { manifest_version: 2 }, { icons: { 16: '../.env' } }]) {
    const { build } = fixture({ manifest }); assert.throws(() => build('https://pagebot.example', 14), /manifest|access|icon/);
  }
});

function tools() {
  let listeners = 0;
  const document = { addEventListener() { listeners++; } };
  const context = vm.createContext({ document, location: { href: 'https://shop.example/cart' }, URL,
    getComputedStyle: () => ({ visibility: 'visible', webkitTextSecurity: 'none' }),
  });
  context.window = context;
  vm.runInContext(createPageTools(bookmarklet), context);
  return { api: context.__pagebotExtensionTools, context, listeners: () => listeners };
}
function field(type, name = '') {
  return { tagName: 'INPUT', type, name, labels: [], isConnected: true, getClientRects: () => [{}],
    getAttribute: () => null, closest: () => null, value: 'must not be read',
  };
}
test('the packaged tools initialize in isolation, are idempotent, and retain protected-field checks', () => {
  const { api, context, listeners } = tools();
  for (const name of ['text', 'find', 'tool', 'act']) assert.equal(typeof api[name], 'function');
  assert.equal(context.__pb, undefined); const count = listeners();
  vm.runInContext(createPageTools(bookmarklet), context); assert.equal(context.__pagebotExtensionTools, api); assert.equal(listeners(), count);
  assert.doesNotMatch(createPageTools(bookmarklet), /W\.addEventListener\("message"|__ORIGIN__|P\.f=document\.createElement/);
  for (const [element, reason] of [[field('password'), 'password'], [field('text', 'credit_card_number'), 'payment'], [field('file'), 'file']]) {
    api.refs.push(element);
    const result = api.act({ name: 'fill', input: { ref: api.refs.length, text: 'blocked' }, sure: 1 });
    assert.equal(result.no, reason); assert.equal(element.value, 'must not be read');
  }
});

test('the packaged tools preserve navigation confirmation and fail if source boundaries disappear', () => {
  const { api } = tools();
  const link = { tagName: 'A', href: 'https://other.example/checkout', labels: [], isConnected: true, innerText: 'Pay now',
    getClientRects: () => [{}], getAttribute: name => name === 'href' ? 'https://other.example/checkout' : null,
    hasAttribute: () => false, querySelector: () => null, closest() { return this; }, click() { throw new Error('must not click'); },
  };
  api.refs.push(link);
  assert.equal(api.act({ name: 'click', input: { ref: 1 } }).no, 'nav');
  assert.throws(() => createPageTools('not the bookmarklet'), /boundaries/);
});

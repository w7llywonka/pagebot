import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { createPageTools } from '../lib/extension-package.js';

// This managed Chromium forbids loading unpacked extensions by administrator policy. These tests
// run the actual packaged panel bridge and remote widget with a local broker fixture, plus the
// exact packaged DOM helpers in a real browser. Native chrome.* calls are covered by runtime tests;
// this suite does not claim to exercise the browser toolbar, side-panel API, or activeTab granting.
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
const browserTest = chromium ? test : test.skip;
const root = new URL('../', import.meta.url);
const widget = await readFile(new URL('public/widget.html', root), 'utf8');
const tools = createPageTools(await readFile(new URL('bookmarklet.js', root), 'utf8'));
const files = Object.fromEntries(await Promise.all(['panel.html', 'panel.js', 'panel.css'].map(async name => [name, await readFile(new URL('extension/' + name, root), 'utf8')])));
const scripts = [...widget.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
const paragraph = 'A real article paragraph. ' + 'The complete argument is useful context. '.repeat(20) + 'ARTICLE_CONCLUSION';
const host = `<!doctype html><html><head><title>Reading fixture</title><style>body{margin:0;padding:20px;background:#e8f0e3;font:16px sans-serif}input{display:block;margin:12px 0}</style></head><body>
<h1>Reading fixture</h1><p id="article">${paragraph}</p><label for="email">Email</label><input id="email" value="before@example.test"><label for="password">Password</label><input id="password" type="password" value="private-password"><input id="file" type="file"><button id="continue">Continue</button></body></html>`;
const boot = {
  authed: true, who: 'user', version: 14, theme: 'ember', lockMinutes: 0,
  user: { id: 1, name: 'Reader', status: 'trusted', allowWeb: true, allowActions: true, passcode: false },
  prefs: { theme: 'ember', model: 'haiku', web: false, actions: true, actionsAuto: false },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 }, models: [{ key: 'haiku', label: 'Haiku' }],
};
let browser, server, origin;
before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/host') {
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; frame-src 'none'; form-action 'none'");
      res.setHeader('Content-Type', 'text/html'); return res.end(host);
    }
    if (url.pathname === '/widget') {
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors * chrome-extension:`);
      res.setHeader('Content-Type', 'text/html'); return res.end(widget);
    }
    if (url.pathname === '/config.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end('globalThis.PAGEBOT_CONFIG=' + JSON.stringify({ origin, version: 14 }) + ';'); }
    const filename = url.pathname.slice(1);
    if (files[filename]) { res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html'); return res.end(files[filename]); }
    res.statusCode = 404; res.end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  if (chromium) browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });

async function fixture(t, { theme = 'ember' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(6000);
  const state = { calls: [], acts: [], requests: [], errors: [], connected: true, prefs: { ...boot.prefs, theme } };
  t.after(async () => { await context.close(); assert.deepEqual(state.errors, []); });
  const page = await context.newPage(); await page.goto(origin + '/host'); await page.evaluate(tools);
  await context.exposeBinding('__pagebotBroker', async (_source, message) => {
    state.calls.push(message);
    if (!state.connected) return { error: 'The active tab changed. Return to the connected tab.' };
    const data = message.payload || {};
    if (message.type === 'status') return { tab: { id: 7, url: origin + '/host', title: 'Reading fixture' } };
    if (message.type === 'selection') return { selection: 'Selected from the context menu' };
    if (message.type === 'capture') return { dataUrl: 'data:image/jpeg;base64,' + (await page.screenshot({ type: 'jpeg', quality: 85 })).toString('base64') };
    return page.evaluate(({ type, data }) => {
      const helper = globalThis.__pagebotExtensionTools;
      if (type === 'page') return { page: { url: location.href, title: document.title, text: data.max <= 1 ? '' : helper.text().slice(0, data.max || 20000) }, selection: '' };
      if (type === 'tool') return helper.tool(data.name, data.input || {});
      if (type === 'act') return helper.act(data);
      if (type === 'find') return { found: !!helper.find(data.text) };
      throw new Error('Unexpected broker operation: ' + type);
    }, { type: message.type, data });
  });
  await context.addInitScript(() => {
    if (location.pathname === '/panel.html') globalThis.chrome = { runtime: { sendMessage: message => globalThis.__pagebotBroker(message) } };
    if (location.pathname !== '/widget') return;
    localStorage.setItem('pb_token', 'test-session');
    const fetchReal = window.fetch;
    window.fetch = (input, options) => {
      if (String(input) !== '/api/chat') return fetchReal(input, options);
      window.__chatBody = JSON.parse(options.body);
      const encoder = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.__push = event => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        window.__end = () => controller.close();
        options.signal.addEventListener('abort', () => { try { controller.close(); } catch {} });
      } }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
    };
    window.__displayPickerCalls = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = async () => { window.__displayPickerCalls++; throw new Error('The extension must use its native capture bridge.'); };
  });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    state.requests.push({ path, body: request.postDataJSON() });
    const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/boot') return json({ ...boot, theme, prefs: state.prefs });
    if (path === '/api/prefs') { Object.assign(state.prefs, request.postDataJSON()); return json({ prefs: state.prefs, limits: boot.limits }); }
    if (path === '/api/chat/act') { state.acts.push(request.postDataJSON()); return json({ ok: true }); }
    if (path === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
    if (path === '/api/commands') return json({ commands: [] });
    if (path === '/api/chats') return json({ chats: [], next: null });
    if (path === '/api/ping' || path === '/api/logout') return json({ ok: true });
    state.errors.push('Unexpected request ' + path); return json({ error: path });
  });
  const panel = await context.newPage(); panel.on('pageerror', e => state.errors.push('panel: ' + e.message));
  await panel.goto(origin + '/panel.html?tab=7');
  await panel.locator('#context').filter({ hasText: '127.0.0.1' }).waitFor();
  const frame = panel.frames().find(frame => frame.url().includes('/widget'));
  assert.ok(frame, 'the actual packaged panel embeds the widget');
  frame.on('pageerror', e => state.errors.push('widget: ' + e.message));
  await frame.locator('#boot').waitFor({ state: 'detached' }); await frame.locator('#q').waitFor({ state: 'visible' });
  const push = event => frame.evaluate(value => window.__push(value), event);
  const waitForAct = async id => {
    const deadline = Date.now() + 6000;
    while (!state.acts.some(item => item.id === id)) {
      if (Date.now() > deadline) assert.fail('The widget did not return page action ' + id);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    return state.acts.find(item => item.id === id);
  };
  return { context, page, panel, frame, state, push, waitForAct };
}

browserTest('packaged page tools preserve long text and protected fields in a strict-CSP real document', async t => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } }); t.after(() => context.close());
  const page = await context.newPage(); await page.goto(origin + '/host');
  // DevTools evaluates the packaged helper; this validates DOM behavior, not extension installation permission.
  await page.evaluate(tools);
  const result = await page.evaluate(() => ({ text: __pagebotExtensionTools.text(), tree: __pagebotExtensionTools.tool('read_page', {}) }));
  assert.match(result.text, /ARTICLE_CONCLUSION/); assert.doesNotMatch(result.text, /private-password/);
  assert.doesNotMatch(result.tree.text, /private-password/);
  const email = /textbox "Email" \[(ref_\d+)\]/.exec(result.tree.text)[1];
  const password = /textbox "Password" \[(ref_\d+)\]/.exec(result.tree.text)[1];
  const fill = await page.evaluate(ref => __pagebotExtensionTools.act({ name: 'fill', input: { ref: +ref.slice(4), text: 'reader@example.test' } }), email);
  assert.equal(fill.value, 'reader@example.test');
  const denied = await page.evaluate(ref => __pagebotExtensionTools.act({ name: 'fill', input: { ref: +ref.slice(4), text: 'changed' } }), password);
  assert.equal(denied.no, 'password'); assert.equal(await page.locator('#password').inputValue(), 'private-password');
});

browserTest('packaged panel and extension widget use page context and screenshot bridge without a screen picker', async t => {
  const f = await fixture(t, { theme: 'clear' });
  assert.equal(await f.frame.locator('#minBtn').isVisible(), false);
  assert.equal(await f.frame.locator('#dockBtn').isVisible(), false);
  assert.equal(await f.frame.evaluate(() => document.documentElement.dataset.theme), 'ember', 'browser side panels use an opaque theme');
  await f.frame.locator('#q').fill('Explain this page.'); await f.frame.locator('#sendBtn').click();
  await f.frame.waitForFunction(() => !!window.__push);
  assert.match(await f.frame.evaluate(() => window.__chatBody.page.text), /ARTICLE_CONCLUSION/);
  await f.push({ t: 'd', v: 'I can read the page.' }); await f.push({ t: 'done', conversationId: 7, model: 'haiku', usage: { in: 20, out: 8 }, stop: 'end_turn' });
  await f.frame.locator('.msg.bot .meta').waitFor();
  await f.frame.locator('#addBtn').click(); await f.frame.locator('#shotBtn').click();
  await f.frame.locator('#att img').waitFor({ state: 'visible' });
  assert.equal(await f.frame.evaluate(() => window.__displayPickerCalls), 0);
  assert.ok(f.state.calls.some(call => call.type === 'capture'));
  const data = await f.frame.locator('#att img').getAttribute('src'); assert.match(data, /^data:image\/jpeg;base64,/);
  await f.panel.evaluate(() => window.postMessage({ type: 'extensionCapture', id: 9876 }, '*'));
  await f.frame.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(f.state.calls.filter(call => call.type === 'capture').length, 1, 'messages from the panel itself cannot impersonate the iframe');
  f.state.connected = false;
  await f.frame.locator('#addBtn').click(); await f.frame.locator('#shotBtn').click();
  await f.panel.locator('#notice').filter({ hasText: 'active tab changed' }).waitFor();
  assert.match(await f.panel.locator('#notice').innerText(), /active tab changed/);
});

browserTest('extension widget keeps field approvals and protected-field refusal before page edits', async t => {
  const f = await fixture(t);
  await f.frame.locator('#q').fill('Help with this form.'); await f.frame.locator('#sendBtn').click(); await f.frame.waitForFunction(() => !!window.__push);
  await f.push({ t: 'act', id: 'read', name: 'read_page', input: {}, ask: false, wait: 20000 });
  const tree = (await f.waitForAct('read')).result.text;
  const email = /textbox "Email" \[(ref_\d+)\]/.exec(tree)[1], password = /textbox "Password" \[(ref_\d+)\]/.exec(tree)[1];
  await f.push({ t: 'act', id: 'fill', name: 'form_input', input: { target: { ref: email }, value: 'approved@example.test' }, ask: true, wait: 20000 });
  await f.frame.locator('.acard').waitFor();
  assert.equal(await f.page.locator('#email').inputValue(), 'before@example.test');
  await f.frame.getByRole('button', { name: 'Allow', exact: true }).click();
  await f.waitForAct('fill');
  assert.equal(await f.page.locator('#email').inputValue(), 'approved@example.test');
  await f.push({ t: 'act', id: 'private', name: 'form_input', input: { target: { ref: password }, value: 'do not write' }, ask: true, wait: 20000 });
  const refused = await f.waitForAct('private');
  assert.match(refused.result.error, /password|protected/i);
  assert.equal(await f.page.locator('#password').inputValue(), 'private-password');
  assert.equal(await f.frame.locator('.acard').count(), 0);
  await f.push({ t: 'd', v: 'Updated only the approved field.' }); await f.push({ t: 'done', conversationId: 7, model: 'haiku', usage: { in: 20, out: 8 }, stop: 'end_turn' });
});

browserTest('lost page access preserves the question and never silently sends a page-based request without context', async t => {
  const f = await fixture(t); f.state.connected = false;
  await f.frame.locator('#q').fill('Help me understand this page.'); await f.frame.locator('#sendBtn').click();
  await f.frame.locator('.note').filter({hasText: 'Turn off Page'}).waitFor();
  assert.equal(await f.frame.locator('#q').inputValue(), 'Help me understand this page.');
  assert.equal(f.state.requests.filter(r => r.path === '/api/chat').length, 0);
  await f.frame.locator('#pagePill').click();
  await f.frame.locator('#q').fill('Help me think through an idea.'); await f.frame.locator('#sendBtn').click();
  await f.frame.waitForFunction(() => !!window.__push);
  assert.equal(await f.frame.evaluate(() => window.__chatBody.page), null);
  await f.push({ t: 'd', v: 'What idea would you like to explore?' });
  await f.push({ t: 'done', conversationId: 8, model: 'haiku', usage: { in: 20, out: 8 }, stop: 'end_turn' });
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { EXT_ID, extensionZip } from '../lib/extension.js';
import { readZip } from './helpers/unzip.mjs';

// The real browser extension (README "Browser extension"), unzipped from the zip the server hands out and loaded into
// Chromium with Load unpacked's command-line twin, then driven through the real panel the way the model drives it: the test
// plays the server's {t:'act'} events into /api/chat and reads what the panel posts to /api/chat/act. Everything else is a
// small local server: pagebot on 127.0.0.1 (its /widget with the policy server.js gives it), and two sites, news.test and
// other.test, mapped to the same address. Only the full Chromium runs extensions (not the headless shell).
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const why = !chromium ? 'Playwright isn’t installed' : !existsSync(CHROME) ? `no Chromium at ${CHROME}` : /headless_shell/.test(CHROME) ? 'the headless shell can’t run extensions' : '';
const widget = readFileSync(new URL('../public/widget.html', import.meta.url), 'utf8');
const hashes = [...widget.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
const CSP = frames => `default-src 'self'; script-src ${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${frames}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (what, check, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(40)) { const v = await check(); if (v) return v; }
  assert.fail(`timed out waiting for ${what}`);
};

let server, port, ORIGIN, NEWS, OTHER, ctx, sw, dir, extDir;
const state = { signedIn: false, chats: [], acts: [], chat: null, logins: 0, boot: {} };
const owner = () => ({ version: 14, extVersion: 1, theme: 'ember', lock: 'password', passwordSet: true, accounts: { on: false, signup: false }, authed: true, who: 'owner', lockMinutes: 0,
  prefs: { theme: 'ember', model: 'haiku', web: false, actions: true, actionsAuto: true, ...state.boot.prefs }, limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3, maxTokensCap: 100000 },
  models: [{ key: 'haiku', label: 'Haiku 5.5' }], commands: [], commandLimits: { maxCommands: 50, maxPrompt: 2000, maxStarters: 3, reserved: [] } });

const pages = {
  '/form': () => `<!doctype html><html><head><title>Form</title><style>body{margin:0;font:16px sans-serif}input,button{display:block;margin:8px;width:300px;height:30px}canvas{display:block;margin:8px;border:1px solid #000}iframe{display:block;margin:8px;border:1px solid #000}</style></head><body>
<form id="f" action="/submitted" method="get">
<input id="name" name="name" aria-label="Your name">
<input id="pw" type="password" name="pw" aria-label="Password">
<input id="card" name="cc" autocomplete="cc-number" aria-label="Card number">
<input id="file" type="file" aria-label="Upload">
<button id="go">Send</button>
</form>
<canvas id="cv" width="200" height="80"></canvas>
<button id="away" type="button">Away</button>
<a id="other" href="${OTHER}/page">Other site</a>
<iframe id="fr" src="${OTHER}/frame" width="420" height="110"></iframe>
<p id="para">Some words to find on this page.</p>
<script>
window.log = [];
for (const t of ['click', 'keydown', 'keyup', 'input', 'submit', 'contextmenu', 'dblclick', 'mousedown', 'mouseup']) addEventListener(t, e => log.push({ type: e.type, id: e.target.id, trusted: e.isTrusted, key: e.key, button: e.button, detail: e.detail }), true);
document.getElementById('cv').addEventListener('click', e => { const r = e.target.getBoundingClientRect(); window.canvasHit = { x: e.clientX - r.left, y: e.clientY - r.top, trusted: e.isTrusted }; });
document.getElementById('away').onclick = () => { location.href = '${OTHER}/page'; };
console.log('hello from the form', 42); console.warn('careful now');
fetch('/data?token=secret123').then(r => r.text()); // (a response nobody reads never makes it into the page's own record)
</script></body></html>`,
  '/submitted': () => `<!doctype html><title>Sent</title><p id="ok">Sent.</p>`,
  '/b': () => `<!doctype html><title>Page B</title><p>Page B</p><button id="bb">Only on B</button>`,
  '/data': () => '{"ok":true}',
  '/frame': () => `<!doctype html><title>Frame</title><body style="margin:0"><input id="ftext" aria-label="Frame text" style="margin:4px;width:150px"><input id="fcard" autocomplete="cc-number" aria-label="Frame card" style="margin:4px;width:150px"><script>window.typed = []; addEventListener('input', e => typed.push([e.target.id, e.target.value, e.isTrusted]), true);</script></body>`,
  '/page': () => `<!doctype html><title>Other page</title><p>Another site.</p>`,
  '/messages': () => `<!doctype html><title>Messages</title><p>Look-alike messages.</p><script>
    window.tries = [];
    for (const m of [{ type: 'ext', name: 'navigate', input: { url: 'https://evil.test/' } }, { t: 'act', d: { name: 'click', input: { ref: 1 } } }, { type: 'run', on: true, run: 'x' }]) { try { parent.postMessage(m, '*'); postMessage(m, '*'); tries.push('posted'); } catch (e) { tries.push(String(e)); } }
    try { chrome.runtime.sendMessage('${EXT_ID}', { t: 'act' }, () => {}); tries.push('sent'); } catch (e) { tries.push('no runtime: ' + e.message); }
  </script>`,
};

before(async () => {
  if (why) return;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x'), host = String(req.headers.host || '').split(':')[0];
    const send = (status, type, body, more = {}) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...more }); res.end(body); };
    const json = v => send(200, 'application/json', JSON.stringify(v));
    if (host === 'news.test' || host === 'other.test') {
      if (url.pathname === '/redirect') return send(302, 'text/plain', '', { Location: `${OTHER}/page` });
      const p = pages[url.pathname];
      return p ? send(200, url.pathname === '/data' ? 'application/json' : 'text/html', p()) : send(404, 'text/plain', 'nope');
    }
    if (url.pathname === '/widget') return send(200, 'text/html', widget, { 'Content-Security-Policy': CSP(`* chrome-extension://${EXT_ID}`) });
    if (url.pathname === '/chat') return send(200, 'text/html', widget, { 'Content-Security-Policy': CSP("'none'") });
    if (url.pathname === '/pagebot-extension.zip') return send(200, 'application/zip', extensionZip(ORIGIN));
    const body = [];
    req.on('data', c => body.push(c));
    req.on('end', () => {
      const data = body.length ? JSON.parse(Buffer.concat(body)) : null;
      const authed = state.signedIn && req.headers.authorization === 'Bearer ext-test-token';
      if (url.pathname === '/api/boot') return json(authed ? owner() : { version: 14, extVersion: 1, theme: 'ember', lock: 'password', passwordSet: true, accounts: { on: false, signup: false }, authed: false });
      if (url.pathname === '/api/login') { state.logins++; if (data?.password !== 'open sesame') return send(401, 'application/json', '{"error":"That password didn’t match."}'); state.signedIn = true; return json({ token: 'ext-test-token' }); }
      if (!authed) return send(401, 'application/json', '{"error":"Sign in first."}');
      if (url.pathname === '/api/chat') {
        state.chats.push(data);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ t: 'id', conversationId: state.chats.length }) + '\n');
        state.chat = res;
        return;
      }
      if (url.pathname === '/api/chat/act') { state.acts.push(data); return json({ ok: true }); }
      if (url.pathname === '/api/prefs') return json({ prefs: { ...owner().prefs, ...data }, limits: owner().limits });
      if (url.pathname === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
      if (url.pathname === '/api/ping') return json({ ok: true });
      return send(404, 'application/json', '{"error":"not in this fixture"}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  ORIGIN = `http://127.0.0.1:${port}`; NEWS = `http://news.test:${port}`; OTHER = `http://other.test:${port}`;
  // the extension, the way a person gets it: the zip from pagebot, unzipped into a folder
  dir = mkdtempSync(path.join(tmpdir(), 'pbext-'));
  extDir = path.join(dir, 'pagebot-extension');
  const zip = Buffer.from(await (await fetch(`${ORIGIN}/pagebot-extension.zip`)).arrayBuffer());
  for (const f of readZip(zip)) {
    const to = path.join(extDir, f.name);
    if (f.name.endsWith('/')) mkdirSync(to, { recursive: true }); else { mkdirSync(path.dirname(to), { recursive: true }); writeFileSync(to, f.data); }
  }
  ctx = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
    executablePath: CHROME, headless: true, viewport: null, // the page's real size, so the side panel's room shows
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox', '--host-resolver-rules=MAP *.test 127.0.0.1', '--remote-debugging-port=0', '--window-size=1200,800'],
  });
  ctx.setDefaultTimeout(8000);
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 10000 });
});
after(async () => {
  await ctx?.close().catch(() => {});
  if (server) { server.closeAllConnections(); server.close(); }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// the side panel page as a small window acting on the page's window (so the page stays that window's showing tab)
async function openPanel(page) {
  const win = await sw.evaluate(async u => { const [t] = await chrome.tabs.query({ url: u }); return { tabId: t.id, windowId: t.windowId }; }, page.url());
  const opened = ctx.waitForEvent('page');
  await sw.evaluate(({ id, w }) => chrome.windows.create({ type: 'popup', url: `chrome-extension://${id}/sidepanel.html?win=${w}`, width: 440, height: 860 }), { id: EXT_ID, w: win.windowId });
  const panel = await opened;
  panel.errors = []; panel.on('pageerror', e => panel.errors.push(e.message));
  const frame = await until('the panel inside the side panel page', () => panel.frames().find(f => f.url().startsWith(ORIGIN + '/widget')));
  await frame.locator('#boot').waitFor({ state: 'detached' });
  return { panel, frame, win };
}
// one question with page actions on; the stream stays open while the test plays the model's steps
async function question(frame, text = 'Help me with this page') {
  const n = state.chats.length;
  await frame.locator('#q').fill(text);
  await frame.locator('#q').press('Enter');
  await until('the question to reach the server', () => state.chats.length > n && state.chat);
  return state.chats.at(-1);
}
let seq = 0;
async function step(name, input = {}, { ask = true, wait = 300000, card } = {}) {
  const id = `s${++seq}`;
  state.chat.write(JSON.stringify({ t: 'act', id, name, input, wait, ask }) + '\n');
  return { id, result: () => until(`the result of ${name}`, () => state.acts.find(a => a.id === id), 20000) };
}
async function run(name, input, opts) { const s = await step(name, input, opts); return s.result(); }
function finish() { state.chat?.write(JSON.stringify({ t: 'd', v: 'Done.' }) + '\n'); state.chat?.write(JSON.stringify({ t: 'done', conversationId: state.chats.length, model: 'haiku', usage: { in: 1, out: 1 }, stop: 'end_turn' }) + '\n'); state.chat?.end(); state.chat = null; }
// whether the extension has the debugger on a tab (getTargets can't say: Playwright is attached to every page too). The extension
// can't attach twice, so the worker tries.
const attachedTo = tabId => sw.evaluate(async t => { try { await chrome.debugger.attach({ tabId: t }, '1.3'); } catch (e) { return /already attached/i.test(e.message); } await chrome.debugger.detach({ tabId: t }); return false; }, tabId);
const centre = (page, sel) => page.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }, sel);
const pt = p => ({ type: 'coordinate', x: p.x, y: p.y });
// the browser's own DevTools connection (the port is in DevToolsActivePort): it can press the toolbar button for a tab
async function browserCdp() {
  const f = path.join(dir, 'profile', 'DevToolsActivePort');
  await until('the DevTools port', () => existsSync(f));
  const [p, wsPath] = readFileSync(f, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${p}${wsPath}`);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let n = 0; const waits = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); } };
  const send = (method, params = {}) => new Promise(ok => { const id = ++n; waits.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  return { send, port: p, close: () => ws.close() };
}

test('the real extension, from the served zip', { skip: why || false }, async t => {
  await t.test('it loads with the fixed id, and its side panel page frames the pagebot panel, which asks to sign in', async () => {
    assert.equal(new URL(sw.url()).host, EXT_ID, 'the key in the manifest gives the id /widget allows');
    const page = await ctx.newPage();
    await page.goto(`${NEWS}/form`);
    for (const p of ctx.pages()) if (p !== page && p.url() === 'about:blank') await p.close();
    const { panel, frame } = await openPanel(page);
    assert.equal(await frame.evaluate(() => window.__pbEarly.ext), true, 'the panel knows it’s in the extension');
    assert.deepEqual(await frame.evaluate(() => [...location.ancestorOrigins]), [`chrome-extension://${EXT_ID}`]);
    await frame.locator('#pw').waitFor({ state: 'visible' });
    await frame.locator('#pw').fill('open sesame');
    await frame.locator('#pw').press('Enter');
    await frame.locator('#q').waitFor({ state: 'visible' });
    assert.equal(state.signedIn, true);
    t.panel = panel; t.frame = frame; t.page = page;
    assert.deepEqual(panel.errors, []);
  });

  await t.test('a question carries the page’s text and says it runs in the extension; a screenshot needs no sharing', async () => {
    const { frame, page } = t;
    const body = await question(frame, 'What can you do here?');
    assert.equal(body.host, 'ext');
    assert.equal(body.ext, 1);
    assert.ok(body.tools.includes('navigate') && body.tools.includes('key') && body.tools.includes('javascript_exec'));
    assert.equal(body.page.url, `${NEWS}/form`);
    assert.match(body.page.text, /Some words to find on this page/);
    const shot = await run('screenshot', {}, { ask: false });
    assert.equal(shot.result.error, undefined, JSON.stringify(shot.result));
    const width = await page.evaluate(() => innerWidth);
    assert.equal(shot.result.w, width, 'a screenshot of the tab itself, at its CSS width');
    assert.equal(shot.result.scale, 1);
    assert.match(shot.result.image, /^data:image\/jpeg;base64,/);
    assert.equal(await frame.locator('.acard.share').count(), 0, 'no Share this tab card');
    t.k = 1;
  });

  await t.test('a click at a screenshot point lands there, as a real click, and the debugger is detached after', async () => {
    const { page } = t;
    const c = await centre(page, '#cv');
    const r = await run('left_click', { target: pt({ x: c.x + 30, y: c.y - 10 }) });
    assert.equal(r.result.error, undefined, JSON.stringify(r.result));
    const hit = await page.evaluate(() => window.canvasHit);
    assert.ok(Math.abs(hit.x - 130) <= 1 && Math.abs(hit.y - 30) <= 1, JSON.stringify(hit));
    assert.equal(hit.trusted, true);
    const tabId = (await sw.evaluate(async u => (await chrome.tabs.query({ url: u }))[0].id, page.url()));
    t.tabId = tabId;
    assert.equal(await attachedTo(tabId), false, 'detached after the step');
  });

  await t.test('typing goes into the field it clicked, as real input; Enter sends the form', async () => {
    const { page } = t;
    const r1 = await run('left_click', { target: pt(await centre(page, '#name')) });
    assert.equal(r1.result.label, 'Your name');
    const r2 = await run('type', { text: 'hello there' });
    assert.equal(r2.result.error, undefined, JSON.stringify(r2.result));
    assert.equal(r2.result.value, 'hello there');
    assert.equal(await page.inputValue('#name'), 'hello there');
    assert.ok((await page.evaluate(() => log)).some(e => e.type === 'input' && e.id === 'name' && e.trusted));
    const r3 = await run('key', { text: 'Enter', repeat: 1 });
    assert.equal(r3.result.error, undefined, JSON.stringify(r3.result));
    await page.waitForURL(/\/submitted\?name=hello\+there/);
    assert.match(r3.result.url, /\/submitted\?name=hello\+there/);
    assert.ok(Array.isArray(r3.result.tabs) && r3.result.tabs.some(x => x.active));
  });

  await t.test('back to the form; refs from the page that’s gone are gone; a password field and a paste are refused', async () => {
    const { page } = t;
    const nav = await run('navigate', { url: `${NEWS}/form` });
    assert.equal(nav.result.error, undefined, JSON.stringify(nav.result));
    assert.equal(page.url(), `${NEWS}/form`);
    const stale = await run('read_page', { ref: 'ref_1' }, { ask: false });
    assert.match(stale.result.error, /isn't on the page anymore/);
    await run('left_click', { target: pt(await centre(page, '#pw')) });
    const pw = await run('type', { text: 'hunter2' });
    assert.match(pw.result.error, /never reads or types into password fields/);
    assert.equal(await page.inputValue('#pw'), '');
    const paste = await run('key', { text: 'ctrl+v', repeat: 1 });
    assert.match(paste.result.error, /never pastes from the clipboard/);
    await run('left_click', { target: pt(await centre(page, '#card')) });
    assert.match((await run('type', { text: '4242' })).result.error, /payment card/);
    const file = await run('left_click', { target: pt(await centre(page, '#file')) });
    assert.match(file.result.error, /never opens file pickers/);
  });

  await t.test('typing inside a frame from another site is checked inside that frame', async () => {
    const { page } = t;
    const fr = await centre(page, '#fr'), frame = page.frames().find(f => f.url().startsWith(OTHER));
    const box = await frame.evaluate(() => { const r = document.getElementById('ftext').getBoundingClientRect(), c = document.getElementById('fcard').getBoundingClientRect(); return { t: [r.left + r.width / 2, r.top + r.height / 2], c: [c.left + c.width / 2, c.top + c.height / 2] }; });
    const fRect = await page.evaluate(() => { const r = document.getElementById('fr').getBoundingClientRect(); return { x: r.left + 1, y: r.top + 1 }; });
    void fr;
    await run('left_click', { target: pt({ x: Math.round(fRect.x + box.t[0]), y: Math.round(fRect.y + box.t[1]) }) });
    const ok = await run('type', { text: 'in the frame' });
    assert.equal(ok.result.error, undefined, JSON.stringify(ok.result));
    assert.equal(await frame.inputValue('#ftext'), 'in the frame');
    await run('left_click', { target: pt({ x: Math.round(fRect.x + box.c[0]), y: Math.round(fRect.y + box.c[1]) }) });
    const no = await run('type', { text: '4242' });
    assert.match(no.result.error, /payment card/);
    assert.equal(await frame.inputValue('#fcard'), '');
  });

  await t.test('a button whose script leaves for a site nobody approved is held, and the tab stays', async () => {
    const { page } = t;
    const r = await run('left_click', { target: pt(await centre(page, '#away')) });
    assert.match(r.result.error, /which the user hasn’t approved, so pagebot stopped it/);
    await sleep(300);
    assert.equal(page.url(), `${NEWS}/form`);
  });

  await t.test('the console, the network log (without its token), a script, and a highlight that paints', async () => {
    const { page, frame } = t;
    const con = await run('read_console', {});
    assert.equal(con.result.error, undefined, JSON.stringify(con.result));
    assert.match(con.result.text, /\[log\] hello from the form 42/);
    assert.match(con.result.text, /\[warn\] careful now/);
    const again = await run('read_console', {});
    assert.equal(again.result.text, '', 'nothing new the second time');
    const net = await run('read_network', {});
    assert.match(net.result.text, /\/data/);
    assert.doesNotMatch(net.result.text, /secret123|token=/);
    const js = await step('javascript_exec', { text: 'document.title + " " + (1 + 1)' });
    await frame.locator('.acard pre.acode').waitFor();
    assert.deepEqual(await frame.locator('.acard button').allInnerTexts(), ['Allow', 'Skip'], 'a script always asks, even with clicks not asking');
    await frame.getByRole('button', { name: 'Allow', exact: true }).click();
    assert.equal((await js.result()).result.value, 'Form 2');
    await page.fill('#pw', 'typed by the person');
    const js2 = await step('javascript_exec', { text: '1' });
    assert.match((await js2.result()).result.error, /password or card field/);
    await page.fill('#pw', '');
    const hl = await run('highlight', { quotes: ['Some words to find'] }, { ask: false });
    assert.equal(hl.result.found[0], 1);
    assert.equal(await page.evaluate(() => CSS.highlights.has('pagebot')), true, 'the highlight is in the page’s own registry');
  });

  await t.test('another site always asks; then new tabs, switching and closing them, with the tabs reported', async () => {
    const { page, frame } = t;
    const go = await step('navigate', { url: `${OTHER}/page` });
    await frame.locator('.acard').waitFor();
    assert.match(await frame.locator('.acard .aw').innerText(), /another site \(other\.test/);
    assert.deepEqual(await frame.locator('.acard button').allInnerTexts(), ['Allow', 'Skip']);
    await frame.getByRole('button', { name: 'Allow', exact: true }).click();
    const r = await go.result();
    assert.equal(r.result.error, undefined, JSON.stringify(r.result));
    assert.equal(page.url(), `${OTHER}/page`);
    const nt = await run('new_tab', {}, { ask: false });
    assert.equal(nt.result.opened.length, 1);
    const opened = nt.result.opened[0];
    assert.ok(nt.result.tabs.find(x => x.tab_id === opened).active);
    const empty = await run('read_page', {}, { ask: false });
    assert.match(empty.result.error, /This tab is empty\. Use navigate/);
    const n2 = await run('navigate', { url: `${NEWS}/b` });
    assert.equal(n2.result.error, undefined, JSON.stringify(n2.result));
    const lt = await run('list_tabs', {}, { ask: false });
    assert.equal(lt.result.tabs.length, 2);
    const sw1 = await run('switch_tab', { tab_id: `tab-${t.tabId}` });
    assert.equal(sw1.result.error, undefined, 'switching back to the tab the answer started on doesn’t ask');
    const ct = await run('close_tab', { tab_id: opened });
    assert.equal(ct.result.error, undefined, JSON.stringify(ct.result));
    assert.equal(ct.result.tabs.length, 1);
    // the person switches to a tab of their own: pagebot stops touching the page until they come back
    const mine = await sw.evaluate(async ({ w, u }) => (await chrome.tabs.create({ windowId: w, url: u, active: true })).id, { w: (await sw.evaluate(async id => (await chrome.tabs.get(id)).windowId, t.tabId)), u: `${NEWS}/b` });
    await sleep(300);
    const away = await run('read_page', {}, { ask: false });
    assert.match(away.result.error, /The user switched to another tab, so pagebot didn’t touch it/);
    await sw.evaluate(id => chrome.tabs.update(id, { active: true }), t.tabId);
    await sleep(200);
    const back = await run('get_page_text', {}, { ask: false });
    assert.equal(back.result.error, undefined, JSON.stringify(back.result));
    await sw.evaluate(id => chrome.tabs.remove(id), mine);
    finish();
  });

  await t.test('pages pagebot never works on: the browser’s own, and pagebot’s', async () => {
    const { page, frame } = t;
    await page.goto('chrome://version');
    await question(frame, 'And here?');
    const r = await run('read_page', {}, { ask: false });
    assert.match(r.result.error, /browser’s own pages/);
    const s = await run('screenshot', {}, { ask: false });
    assert.match(s.result.error, /browser’s own pages/);
    await page.goto(`${ORIGIN}/chat`);
    await sleep(300);
    const p = await run('get_page_text', {}, { ask: false });
    assert.match(p.result.error, /its own pages/);
    finish();
  });

  await t.test('a web page can’t drive the extension, and closing the panel mid-step lets go and detaches', async () => {
    const { page, frame } = t;
    await page.goto(`${NEWS}/messages`);
    await sleep(500);
    const tries = await page.evaluate(() => window.tries);
    assert.ok(tries.some(x => /no runtime/.test(x)), `a page has no way to message the extension: ${tries}`);
    assert.equal(page.url(), `${NEWS}/messages`);
    await page.goto(`${NEWS}/form`);
    await question(frame, 'Hold shift');
    await run('left_click', { target: pt(await centre(page, '#name')) });
    const hold = await step('hold_key', { text: 'shift', duration: 20 });
    await until('the key to go down', () => page.evaluate(() => log.some(e => e.type === 'keydown' && e.key === 'Shift')));
    assert.equal(await attachedTo(t.tabId), true);
    await t.panel.close();
    await until('shift to be let go', () => page.evaluate(() => log.some(e => e.type === 'keyup' && e.key === 'Shift')));
    await until('the debugger to be detached', async () => !(await attachedTo(t.tabId)));
    void hold;
  });

  await t.test('the real side panel: the toolbar button opens it beside the tab, still signed in; a screenshot is the tab only; click and type work', async () => {
    const { page } = t;
    const before = await page.evaluate(() => innerWidth);
    const cdp = await browserCdp();
    let b2;
    try {
      const tab = (await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] })).result.targetInfos.find(x => x.url === `${NEWS}/form`);
      const pressed = await cdp.send('Extensions.triggerAction', { id: EXT_ID, targetId: tab.targetId });
      assert.equal(pressed.error, undefined, JSON.stringify(pressed.error));
      b2 = await chromium.connectOverCDP(`http://127.0.0.1:${cdp.port}`);
      const sp = await until('the side panel', () => b2.contexts().flatMap(c => c.pages()).find(p => p.url() === `chrome-extension://${EXT_ID}/sidepanel.html`));
      const wf = await until('the panel in it', () => sp.frames().find(f => f.url().startsWith(ORIGIN + '/widget')), 15000);
      await wf.locator('#q').waitFor({ state: 'visible' }); // signed in already: the side panel shares pagebot's own storage
      const after = await until('the side panel to take room beside the page', async () => { const w = await page.evaluate(() => innerWidth); return w < before && w; });
      await question(wf, 'From the real side panel');
      const shot = await run('screenshot', {}, { ask: false });
      assert.equal(shot.result.w, after, 'the screenshot is the tab, not the side panel');
      await run('left_click', { target: pt(await centre(page, '#name')) });
      const typed = await run('type', { text: 'from the side panel' });
      assert.equal(typed.result.error, undefined, JSON.stringify(typed.result));
      assert.equal(await page.inputValue('#name'), 'from the side panel');
      finish();
      await wf.locator('#closeBtn').click();
      await until('the side panel to close', () => !b2.contexts().flatMap(c => c.pages()).some(p => p.url().endsWith('/sidepanel.html')));
    } finally { await b2?.close().catch(() => {}); cdp.close(); }
  });
});

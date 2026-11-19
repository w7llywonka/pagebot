import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXT_ID, extensionZip } from '../../lib/extension.js';
import { readZip } from './unzip.mjs';

// The real browser extension (README "Browser extension") for the browser tests: unzipped from the zip the server hands out
// and loaded into Chromium with Load unpacked's command-line twin, then driven through the real panel the way the model drives
// it: a test plays the server's {t:'act'} events into /api/chat and reads what the panel posts to /api/chat/act. Everything
// else is a small local server: pagebot on 127.0.0.1 (its /widget with the policy server.js gives it), and two sites,
// news.test and other.test, mapped to the same address. Only the full Chromium runs extensions (not the headless shell).
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
export { chromium };
export const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
export const why = !chromium ? 'Playwright isn’t installed' : !existsSync(CHROME) ? `no Chromium at ${CHROME}` : /headless_shell/.test(CHROME) ? 'the headless shell can’t run extensions' : '';
const widget = readFileSync(new URL('../../public/widget.html', import.meta.url), 'utf8');
const hashes = [...widget.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
const CSP = frames => `default-src 'self'; script-src ${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${frames}`;
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const until = async (what, check, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(40)) { const v = await check(); if (v) return v; }
  assert.fail(`timed out waiting for ${what}`);
};
export const pt = p => ({ type: 'coordinate', x: p.x, y: p.y });

// pages: { '/path': H => html } served on news.test and other.test (H has NEWS, OTHER, ORIGIN). own: the same on pagebot's
// own address (127.0.0.1), for pages of pagebot's site that aren't the panel.
// headless: false only for a test that brings its own display (extension-menu.test.js clicks the real right-click menu under Xvfb)
export async function startExtension({ pages = {}, own = {}, headless = true } = {}) {
  const H = { state: { signedIn: false, chats: [], acts: [], chat: null, logins: 0, boot: {}, hits: [] }, EXT_ID };
  const { state } = H;
  const owner = () => ({ version: 14, extVersion: 1, theme: 'ember', lock: 'password', passwordSet: true, accounts: { on: false, signup: false }, authed: true, who: 'owner', lockMinutes: 0,
    prefs: { theme: 'ember', model: 'haiku', web: false, actions: true, actionsAuto: true, ...state.boot.prefs }, limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3, maxTokensCap: 100000 },
    models: [{ key: 'haiku', label: 'Haiku 5.5' }], commands: [], commandLimits: { maxCommands: 50, maxPrompt: 2000, maxStarters: 3, reserved: [] } });
  H.server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x'), host = String(req.headers.host || '').split(':')[0];
    const send = (status, type, body, more = {}) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...more }); res.end(body); };
    const json = v => send(200, 'application/json', JSON.stringify(v));
    if (host === 'news.test' || host === 'other.test') {
      state.hits.push(host + url.pathname + url.search);
      if (url.pathname === '/redirect') return send(302, 'text/plain', '', { Location: url.searchParams.get('to') || `${H.OTHER}/page` });
      const p = pages[url.pathname];
      return p ? send(200, url.pathname === '/data' ? 'application/json' : 'text/html', p(H, url)) : send(404, 'text/plain', 'nope');
    }
    if (url.pathname === '/widget') return send(200, 'text/html', widget, { 'Content-Security-Policy': CSP(`* chrome-extension://${EXT_ID}`) });
    if (url.pathname === '/chat') return send(200, 'text/html', widget, { 'Content-Security-Policy': CSP("'none'") });
    if (own[url.pathname]) return send(200, 'text/html', own[url.pathname](H, url));
    if (url.pathname === '/pagebot-extension.zip') return send(200, 'application/zip', extensionZip(H.ORIGIN));
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
  await new Promise(r => H.server.listen(0, '127.0.0.1', r));
  const port = H.server.address().port;
  H.ORIGIN = `http://127.0.0.1:${port}`; H.NEWS = `http://news.test:${port}`; H.OTHER = `http://other.test:${port}`;
  // the extension, the way a person gets it: the zip from pagebot, unzipped into a folder
  H.dir = mkdtempSync(path.join(tmpdir(), 'pbext-'));
  const extDir = path.join(H.dir, 'pagebot-extension');
  const zip = Buffer.from(await (await fetch(`${H.ORIGIN}/pagebot-extension.zip`)).arrayBuffer());
  for (const f of readZip(zip)) {
    const to = path.join(extDir, f.name);
    if (f.name.endsWith('/')) mkdirSync(to, { recursive: true }); else { mkdirSync(path.dirname(to), { recursive: true }); writeFileSync(to, f.data); }
  }
  H.ctx = await chromium.launchPersistentContext(path.join(H.dir, 'profile'), {
    executablePath: CHROME, headless, viewport: null, // the page's real size, so the side panel's room shows
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox', '--host-resolver-rules=MAP *.test 127.0.0.1', '--remote-debugging-port=0', '--window-size=1200,800'],
  });
  H.ctx.setDefaultTimeout(8000);
  H.sw = H.ctx.serviceWorkers()[0] || await H.ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const { ctx, sw } = H;

  H.close = async () => {
    await ctx?.close().catch(() => {});
    H.server.closeAllConnections(); H.server.close();
    rmSync(H.dir, { recursive: true, force: true });
  };
  // the side panel page as a small window acting on the page's window (so the page stays that window's showing tab)
  H.openPanel = async page => {
    const win = await sw.evaluate(async u => { const [t] = await chrome.tabs.query({ url: u }); return { tabId: t.id, windowId: t.windowId }; }, page.url());
    const opened = ctx.waitForEvent('page');
    await sw.evaluate(({ id, w }) => chrome.windows.create({ type: 'popup', url: `chrome-extension://${id}/sidepanel.html?win=${w}`, width: 440, height: 860 }), { id: EXT_ID, w: win.windowId });
    const panel = await opened;
    panel.errors = []; panel.on('pageerror', e => panel.errors.push(e.message));
    const frame = await until('the panel inside the side panel page', () => panel.frames().find(f => f.url().startsWith(H.ORIGIN + '/widget')));
    await frame.locator('#boot').waitFor({ state: 'detached' });
    return { panel, frame, win };
  };
  H.signIn = async frame => {
    await frame.locator('#pw').waitFor({ state: 'visible' });
    await frame.locator('#pw').fill('open sesame');
    await frame.locator('#pw').press('Enter');
    await frame.locator('#q').waitFor({ state: 'visible' });
  };
  // one question with page actions on; the stream stays open while the test plays the model's steps
  H.question = async (frame, text = 'Help me with this page') => {
    const n = state.chats.length;
    await frame.locator('#q').fill(text);
    await frame.locator('#q').press('Enter');
    await until('the question to reach the server', () => state.chats.length > n && state.chat);
    return state.chats.at(-1);
  };
  let seq = 0;
  H.step = async (name, input = {}, { ask = true, wait = 300000 } = {}) => {
    const id = `s${++seq}`;
    state.chat.write(JSON.stringify({ t: 'act', id, name, input, wait, ask }) + '\n');
    return { id, result: (ms = 20000) => until(`the result of ${name}`, () => state.acts.find(a => a.id === id), ms) };
  };
  H.run = async (name, input, opts) => { const s = await H.step(name, input, opts); return s.result(); };
  H.finish = () => {
    state.chat?.write(JSON.stringify({ t: 'd', v: 'Done.' }) + '\n');
    state.chat?.write(JSON.stringify({ t: 'done', conversationId: state.chats.length, model: 'haiku', usage: { in: 1, out: 1 }, stop: 'end_turn' }) + '\n');
    state.chat?.end(); state.chat = null;
  };
  // the card the panel shows for a step, and the person's choice on it
  H.card = async frame => { await frame.locator('.acard').waitFor(); return { text: await frame.locator('.acard').innerText(), buttons: await frame.locator('.acard button').allInnerTexts() }; };
  H.choose = (frame, label) => frame.locator('.acard').getByRole('button', { name: label, exact: true }).click();
  // whether the extension has the debugger on a tab (getTargets can't say: Playwright is attached to every page too). The
  // extension can't attach twice, so the worker tries.
  H.attachedTo = tabId => sw.evaluate(async t => { try { await chrome.debugger.attach({ tabId: t }, '1.3'); } catch (e) { return /already attached/i.test(e.message); } await chrome.debugger.detach({ tabId: t }); return false; }, tabId);
  H.tabIdOf = page => sw.evaluate(async u => (await chrome.tabs.query({ url: u }))[0]?.id, page.url());
  H.centre = (page, sel) => page.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }, sel);
  // the browser's own DevTools connection (the port is in DevToolsActivePort): it can press the toolbar button for a tab
  H.browserCdp = async () => {
    const f = path.join(H.dir, 'profile', 'DevToolsActivePort');
    await until('the DevTools port', () => existsSync(f));
    const [p, wsPath] = readFileSync(f, 'utf8').trim().split('\n');
    const ws = new WebSocket(`ws://127.0.0.1:${p}${wsPath}`);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
    let n = 0; const waits = new Map();
    ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); } };
    // sessionId: a target attached with Target.attachToTarget (flatten), like the side panel's /widget frame
    const send = (method, params = {}, sessionId) => new Promise(ok => { const id = ++n; waits.set(id, ok); ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) })); });
    return { send, port: p, close: () => ws.close() };
  };
  return H;
}

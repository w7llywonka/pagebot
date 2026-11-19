import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// How fast the panel becomes usable, and that what was moved out of the start-up still works.
// Like the other widget tests this needs no pagebot server or database, but the page comes from a small local server instead
// of a routed fixture, because these tests need what a route can't do: hold the page back half way (everything before the
// main script, as on a slow connection) and stream an answer in pieces. The host page is on 127.0.0.1 and pagebot on
// localhost, which are different sites, as the page and the panel are in real use. The page is sent with the policy
// server.js gives it (inline scripts by hash, connect-src 'self'), so a script or request the policy blocks fails here.
// To watch these fail on an older page: PAGEBOT_WIDGET_FILE=old.html node --test tests/widget-startup.test.js
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
const browserTest = chromium ? test : test.skip;
const widget = await readFile(process.env.PAGEBOT_WIDGET_FILE || new URL('../public/widget.html', import.meta.url), 'utf8');
const bookmarkletSource = await readFile(new URL('../bookmarklet.js', import.meta.url), 'utf8');
const MAIN = widget.lastIndexOf('<script>'); // the main script is the last thing in the page
const CSP = frames => `default-src 'self'; script-src ${[...widget.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ')}; ` +
  `style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${frames}`;
let browser;
const servers = new Set();
before(async () => {
  if (chromium) browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); for (const s of servers) { s.closeAllConnections(); s.close(); } }); // (a test that failed half way may have left one open)

const account = {
  version: 13, authed: true, who: 'user', theme: 'ember', lock: 'password', passwordSet: true, accounts: { on: true, signup: true }, lockMinutes: 0,
  user: { id: 1, name: 'Test reader', status: 'trusted', allowWeb: true, passcode: false },
  prefs: { theme: 'ember', model: 'haiku', web: false },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku' }],
  commands: [], commandLimits: { maxCommands: 50, maxPrompt: 2000, maxStarters: 3, reserved: [] },
};
const signedOut = { version: 13, authed: false, theme: 'ember', lock: 'password', passwordSet: true, accounts: { on: true, signup: true } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (what, check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const v = await check(); if (v) return v; }
  assert.fail(`timed out waiting for ${what}`);
};
// the page has the whole answer to its early boot (a finished request is in its resource timings)
const bootBack = frame => until('the boot answer to be in the page', () => frame.evaluate(() => performance.getEntriesByType('resource').some(e => e.name.endsWith('/api/boot'))));
// an init script for a busy host page: what the panel says reaches the bookmark only when the test calls __letGo(), all of it and in order
const busyHost = () => {
  if (location.hostname !== '127.0.0.1') return;
  const held = [], hold = e => { const f = document.getElementById('__pagebot'); if (f && e.source === f.contentWindow) { e.stopImmediatePropagation(); held.push(e); } };
  addEventListener('message', hold);
  window.__letGo = () => { removeEventListener('message', hold); for (const e of held.splice(0)) dispatchEvent(new MessageEvent('message', { data: e.data, origin: e.origin, source: e.source })); };
};
const done = { t: 'done', conversationId: 42, model: 'haiku', usage: { in: 50, out: 20 }, stop: 'end_turn' };

// hold: the page stops arriving just before its main script until release() (the head, the styles and the markup are there)
// boot: what /api/boot answers (a function gets the request); bootStatus: an error instead; bootGate: it answers only once this resolves
// answer: the text /api/chat streams, `piece` characters at a time; chatGate + chatHold: it stops after exactly chatHold characters until the gate resolves
async function fixture(t, { standalone = false, token = 'test-session', store = {}, bookmark = 13, hold = false, boot = account, bootStatus = 200, bootGate,
  answer = 'A helpful answer.', piece = 2000, chatGate, chatHold = 0, init, viewport = { width: 1280, height: 800 }, quiet = [] } = {}) {
  const state = { boots: [], requests: [], errors: [], chats: 0 }, gate = deferred();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<!doctype html><html><body style="margin:0"><p id="words">Host page text.</p>
      <script>window.hostRequests = []; addEventListener('message', e => { const f = document.getElementById('__pagebot'); if (f && e.source === f.contentWindow) window.hostRequests.push(e.data); });</script></body></html>`); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/widget' || url.pathname === '/chat') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP(url.pathname === '/widget' ? '*' : "'none'") });
      if (!hold) return res.end(widget);
      res.write(widget.slice(0, MAIN)); await gate.promise; return res.end(widget.slice(MAIN));
    }
    state.requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/api/boot') {
      state.boots.push({ authorization: req.headers.authorization, device: req.headers['x-pagebot-device'] });
      if (bootGate) await bootGate.promise;
      return bootStatus === 200 ? json(typeof boot === 'function' ? boot(req) : boot) : json({ error: 'down' }, bootStatus);
    }
    if (url.pathname === '/api/login') return json({ token: 'fresh-session' });
    if (url.pathname === '/api/logout' || url.pathname === '/api/ping') return json({ ok: true });
    if (url.pathname === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
    if (url.pathname === '/api/pdf') return json({ used: 0, cap: 10 * 1048576, pdfs: [] });
    if (url.pathname === '/api/chats') return json({ chats: [{ id: 42, title: 'A long answer', site: 'news.example.test', url: 'https://news.example.test/a', pageTitle: 'A', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], next: null });
    if (url.pathname === '/api/chats/42') return json({ chat: { id: 42, title: 'A long answer', site: 'news.example.test', url: 'https://news.example.test/a', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      messages: [{ role: 'user', text: 'Explain', at: new Date().toISOString() }, { role: 'assistant', text: answer, model: 'Haiku', usage: { in: 50, out: 20 }, searches: 0, stopped: false, at: new Date().toISOString() }], earlier: false });
    if (url.pathname === '/api/chat') {
      state.chats++;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store, no-transform' });
      res.write(JSON.stringify({ t: 'id', conversationId: 42 }) + '\n');
      const send = async text => { for (let i = 0; i < text.length && !res.destroyed; i += piece) { res.write(JSON.stringify({ t: 'd', v: text.slice(i, i + piece) }) + '\n'); if (piece < text.length) await sleep(4); } };
      await send(chatGate ? answer.slice(0, chatHold) : answer);
      if (chatGate) { state.held = true; await chatGate.promise; await send(answer.slice(chatHold)); }
      return res.destroyed ? null : res.end(JSON.stringify(done) + '\n');
    }
    state.errors.push(`Unexpected request: ${req.method} ${url.pathname}`);
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  servers.add(server);
  const port = server.address().port, HOST = `http://127.0.0.1:${port}`, ORIGIN = `http://localhost:${port}`;
  const context = await browser.newContext({ viewport });
  context.setDefaultTimeout(8000);
  t.after(async () => {
    gate.resolve(); bootGate?.resolve(); chatGate?.resolve();
    await context.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); servers.delete(server);
    assert.deepEqual(state.errors.filter(e => !quiet.some(q => q.test(e))), [], 'no browser errors or unexpected requests');
  });
  await context.addInitScript(([session, items]) => {
    try { if (location.hostname !== 'localhost') return; if (session) localStorage.setItem('pb_token', session); for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v); } catch {}
  }, [token, store]);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.location().url || '')) state.errors.push('console: ' + m.text()); });
  const click = () => page.evaluate(bookmarkletSource.replaceAll('__ORIGIN__', ORIGIN).replaceAll('__VERSION__', String(bookmark)).replace(/\n\s*/g, '')); // the real bookmark
  let frame;
  const open = async () => {
    if (standalone) { await page.goto(ORIGIN + '/chat', { waitUntil: 'commit' }); frame = page.mainFrame(); return frame; }
    await click();
    frame = await until('the panel frame', () => page.frames().find(f => f.url().startsWith(ORIGIN + '/widget')));
    return frame;
  };
  if (!standalone) await page.goto(HOST + '/page');
  const ready = async (box = '#q') => { await frame.locator('#boot').waitFor({ state: 'detached' }); await frame.locator(box).waitFor({ state: 'visible' }); };
  const host = type => page.evaluate(t => window.hostRequests.filter(r => r.type === t), type);
  const shown = () => page.evaluate(() => { const f = document.getElementById('__pagebot'); return !!f && f.style.display !== 'none' && f.style.opacity === '1'; });
  // shown, and done fading in: until then the frame is still moving and shrunk a little, so a click aimed inside it can land beside it
  const steady = () => until('the panel to finish fading in', () => page.evaluate(() => { const f = document.getElementById('__pagebot'); return !!f && f.style.display !== 'none' && f.style.opacity === '1' && !f.getAnimations().length; }));
  return { page, state, open, click, ready, host, shown, steady, release: () => gate.resolve(), get frame() { return frame; }, ORIGIN };
}

browserTest('the first boot leaves while the page is still arriving, with the session and this browser’s id, and a normal open asks once', async t => {
  const f = await fixture(t, { hold: true });
  const frame = await f.open();
  await until('the boot request', () => f.state.boots.length); // the main script isn't even here yet
  assert.deepEqual(await frame.evaluate(() => [document.readyState, !!document.querySelector('#boot'), document.scripts.length]), ['loading', true, 1], 'only the head script has run');
  assert.equal(f.state.boots[0].authorization, 'Bearer test-session');
  assert.match(f.state.boots[0].device, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(f.state.boots[0].device, await frame.evaluate(() => localStorage.getItem('pb_dev')), 'the id it made is the one it keeps');
  f.release(); await f.ready();
  await frame.locator('#q').fill('hello');
  assert.equal(await frame.locator('#q').inputValue(), 'hello');
  await sleep(400); // long enough for the bookmark's "open" to have asked again, if it were going to
  assert.equal(f.state.boots.length, 1, 'one boot for one open');
  assert.deepEqual(f.state.requests, ['GET /api/boot'], 'and nothing else is asked for at start');
  // closing and reopening with the bookmark still refreshes in the background, with the same id
  await f.click(); await until('the panel to be put away', () => f.page.evaluate(() => document.getElementById('__pagebot').style.display === 'none'));
  await f.click(); await until('the refresh', () => f.state.boots.length === 2);
  assert.equal(f.state.boots[1].device, f.state.boots[0].device);
  await f.ready();
  assert.equal(await frame.locator('#q').inputValue(), 'hello', 'the open chat stays as it was');
});

browserTest('the chat is there the moment the main script has run when the boot is already back, on /chat and in the panel', async t => {
  // what is on screen when the page finishes parsing: with the boot back, the loading mark has already yielded to the chat
  const init = () => addEventListener('DOMContentLoaded', () => { const c = document.querySelector('#composer'); if (c) window.__atParsed = { splash: !!document.querySelector('#boot'), composer: !c.hidden, log: !document.querySelector('#log').hidden }; });
  for (const standalone of [true, false]) {
    const f = await fixture(t, { standalone, hold: true, init });
    const frame = await f.open();
    await until('the boot request', () => f.state.boots.length);
    await bootBack(frame); // its answer is back in the page; the rest of the page isn't
    f.release(); await f.ready();
    assert.deepEqual(await frame.evaluate(() => window.__atParsed), { splash: false, composer: true, log: true }, standalone ? '/chat' : 'panel');
    await frame.locator('#q').fill('straight away');
    assert.equal(await frame.locator('#q').inputValue(), 'straight away');
    assert.equal(f.state.boots.length, 1);
  }
  // signed out: the sign-in form, just as directly
  const out = await fixture(t, { token: null, boot: signedOut, hold: true, init: () => addEventListener('DOMContentLoaded', () => { const l = document.querySelector('#login'); if (l) window.__atParsed = { splash: !!document.querySelector('#boot'), login: l.style.display }; }) });
  const frame = await out.open();
  await until('the boot request', () => out.state.boots.length);
  assert.equal(out.state.boots[0].authorization, undefined, 'no session, no Authorization header');
  await bootBack(frame); out.release(); await out.ready('#uName');
  assert.deepEqual(await frame.evaluate(() => window.__atParsed), { splash: false, login: 'flex' });
  assert.equal(await frame.locator('#lockTitle').innerText(), 'Sign in');
  // signing in boots again, for the new session (the early answer was for nobody and is used only once)
  await frame.locator('#uName').fill('reader'); await frame.locator('#uPass').fill('secret-pass');
  await frame.locator('#uGo').click();
  await until('the boot after signing in', () => out.state.boots.length === 2);
  assert.equal(out.state.boots[1].authorization, 'Bearer fresh-session');
});

browserTest('the early boot is only used for the session it was sent with, and a boot that fails is not asked for twice', async t => {
  // another tab signed in between the head script and the main script: the early answer belongs to the old session
  const f = await fixture(t, { standalone: true, hold: true, boot: req => req.headers.authorization === 'Bearer newer-session' ? account : { ...account, user: { ...account.user, name: 'Somebody else' } } });
  const frame = await f.open();
  await until('the boot request', () => f.state.boots.length);
  await frame.evaluate(() => localStorage.setItem('pb_token', 'newer-session'));
  f.release(); await f.ready();
  await until('a boot for the session the page ended up with', () => f.state.boots.length === 2);
  assert.deepEqual(f.state.boots.map(b => b.authorization), ['Bearer test-session', 'Bearer newer-session']);
  await frame.locator('#setBtn').click(); await frame.locator('#tab-account').click();
  assert.equal(await frame.locator('#acctName').innerText(), 'Signed in as Test reader', 'the answer for the other session was not used');
  // the server is down: the lock screen says so, as before, after one try
  const down = await fixture(t, { standalone: true, token: null, bootStatus: 503, quiet: [/503/] });
  const lock = await down.open(); await down.ready('#pw');
  assert.equal(await lock.locator('#loginErr').innerText(), 'Can’t reach the pagebot server.');
  await sleep(300);
  assert.equal(down.state.boots.length, 1);
  // and a slow boot still can't keep the loading mark up
  const gate = deferred(), slow = await fixture(t, { standalone: true, bootGate: gate });
  const page = await slow.open();
  await page.locator('#boot').waitFor({ state: 'detached', timeout: 2500 });
  assert.equal(await page.locator('#q').isVisible(), true, 'a remembered session opens on the chat meanwhile');
  gate.resolve(); await sleep(200);
  assert.equal(slow.state.boots.length, 1);
});

browserTest('the bookmark shows the panel while the page is still arriving, and what it says meanwhile is not lost', async t => {
  const f = await fixture(t, { hold: true, store: { pb_pos: JSON.stringify({ r: 40, b: 60 }), pb_size: JSON.stringify({ w: 450, h: 600 }) } });
  await f.page.evaluate(() => getSelection().selectAllChildren(document.querySelector('#words'))); // a highlight made before the click
  const frame = await f.open();
  await until('the panel to be shown', f.shown);
  assert.equal(await frame.evaluate(() => document.readyState), 'loading', 'the main script has not arrived');
  assert.equal(await frame.locator('#boot .word').isVisible(), true, 'the loading mark is what shows');
  assert.equal(await frame.locator('#q').isVisible(), false);
  assert.deepEqual(await f.host('ready'), [{ type: 'ready', pos: { r: 40, b: 60 }, size: { w: 450, h: 600 }, dock: false }], 'with the place and size saved on this site');
  assert.deepEqual(await f.page.evaluate(() => { const s = document.getElementById('__pagebot').style; return [s.width, s.height, s.right, s.bottom]; }), ['450px', '600px', '40px', '60px']);
  f.release(); await f.ready();
  // the bookmark answered 'ready' with 'open' and the highlight before the main script existed: both arrive
  await frame.locator('#selPill').waitFor({ state: 'visible' });
  assert.match(await frame.locator('#selPill').innerText(), /Host page text/);
  await frame.waitForFunction(() => document.activeElement?.id === 'q');
  assert.equal(await f.page.evaluate(() => document.activeElement?.id), '__pagebot', 'opening with the bookmark gives the panel the keyboard');
  assert.equal((await f.host('ready')).length, 1, 'said once');
  assert.equal(f.state.boots.length, 1);
  // an old bookmark gets its screen-sized default the same early way, and /chat has no one to tell
  const old = await fixture(t, { hold: true, bookmark: 8 });
  const oldFrame = await old.open();
  await until('the panel to be shown', old.shown);
  assert.equal(await oldFrame.evaluate(() => document.readyState), 'loading');
  const sent = (await old.host('ready'))[0];
  assert.ok(sent.size.w >= 360 && sent.size.h >= 420 && sent.dw >= 420 && sent.dock === false, JSON.stringify(sent));
  old.release(); await old.ready();
  assert.equal((await old.host('ready')).length, 1);
});

browserTest('a panel shown while the page is still arriving can be closed, even once the loading mark has given up', async t => {
  const f = await fixture(t, { hold: true });
  const frame = await f.open();
  await until('the panel to be shown', f.shown);
  const hidden = () => until('the panel to be put away', () => f.page.evaluate(() => document.getElementById('__pagebot').style.display === 'none'));
  // the main script still hasn't come when the loading mark's failsafe runs out (6 s): the header's close button is what's left
  await frame.locator('#closeBtn').click({ timeout: 9000 });
  await hidden();
  assert.equal(await frame.evaluate(() => document.readyState), 'loading', 'the main script has not arrived');
  assert.equal((await f.host('close')).length, 1);
  // Esc does the same, and the keyboard goes back to the page
  await f.click(); await f.steady();
  await frame.locator('header .title').click();
  await frame.waitForFunction(() => document.hasFocus()); // (the click's focus reaches the panel's process a moment later)
  await f.page.keyboard.press('Escape');
  await hidden();
  assert.equal((await f.host('close')).length, 2);
  assert.notEqual(await f.page.evaluate(() => document.activeElement?.id), '__pagebot');
  // once the main script is here, closing is its job, said once
  await f.click(); await until('the panel to be shown again', f.shown);
  f.release(); await f.ready(); await f.steady();
  await frame.locator('#closeBtn').click();
  await hidden();
  assert.equal((await f.host('close')).length, 3);
  assert.equal(f.state.boots.length, 1);
});

browserTest('a Glass or Clear panel shown while the page is still arriving already looks like it: the page behind blurred, or no shadow', async t => {
  // every change the bookmark makes to the frame's look on the host page
  const init = () => {
    if (location.hostname !== '127.0.0.1') return;
    window.__looks = [];
    new MutationObserver(() => { const f = document.getElementById('__pagebot'); if (f) window.__looks.push([f.style.opacity, f.style.boxShadow, f.style.backdropFilter]); })
      .observe(document, { subtree: true, attributes: true, attributeFilter: ['style'] });
  };
  const root = frame => frame.evaluate(() => [document.documentElement.dataset.blur ?? null, document.documentElement.dataset.page ?? null]);
  for (const theme of ['glass', 'clear']) {
    const f = await fixture(t, { hold: true, init, store: { pb_theme: theme }, boot: { ...account, theme, prefs: { ...account.prefs, theme } } });
    const frame = await f.open();
    await until('the panel to be shown', f.shown);
    const seen = (await f.page.evaluate(() => window.__looks)).filter(([opacity]) => opacity !== '0');
    assert.ok(seen.length, 'shown');
    for (const [, shadow, blur] of seen) if (theme === 'glass') assert.match(blur, /blur/, 'never shown without the blur'); else assert.equal(shadow, 'none', 'never shown with a shadow');
    // and inside, the glass knows the page behind is light, as it did when the main script asked
    await until('the panel to know the page behind', async () => (await root(frame))[1]);
    assert.equal(await frame.evaluate(() => document.readyState), 'loading', 'the main script has not arrived');
    assert.deepEqual(await root(frame), [theme === 'glass' ? '1' : null, 'light'], theme);
    f.release(); await f.ready(); await sleep(300);
    assert.deepEqual(await root(frame), [theme === 'glass' ? '1' : null, 'light'], 'the main script carries on from that answer');
    assert.deepEqual((await f.host(theme)).map(r => r.on), [true], 'and does not ask again');
  }
  // the account's theme turns out to be another one: the glass the head script asked for is put away again
  const f = await fixture(t, { hold: true, init, store: { pb_theme: 'glass' } });
  const frame = await f.open();
  await until('the panel to know the page behind', async () => (await root(frame))[1]);
  f.release(); await f.ready();
  await until('the theme from the server', () => frame.evaluate(() => document.documentElement.dataset.theme === 'ember'));
  assert.deepEqual(await root(frame), [null, null]);
  assert.deepEqual((await f.host('glass')).map(r => r.on), [true, false]);
  assert.doesNotMatch(await f.page.evaluate(() => document.getElementById('__pagebot').style.backdropFilter), /blur/);
  // and when the bookmark's answer to the head script only comes after that (a busy page), it is not put on the panel
  const busy = await fixture(t, { init: busyHost, store: { pb_theme: 'glass' } });
  const late = await busy.open();
  await until('the theme from the server', () => late.evaluate(() => document.documentElement.dataset.theme === 'ember'));
  await busy.page.evaluate(() => window.__letGo());
  await until('the panel to be shown', busy.shown); await busy.ready(); await sleep(300);
  assert.deepEqual((await busy.host('glass')).map(r => r.on), [true, false]);
  assert.deepEqual(await root(late), [null, null], 'no glass marks on a Carbon panel');
});

browserTest('nothing on the way to the first screen loads the locale data or draws the companions, and both are there on first use', async t => {
  // every way the page could format a number or a date for the locale
  const init = () => {
    window.__locale = 0;
    for (const name of ['DateTimeFormat', 'NumberFormat']) { const Real = Intl[name]; Intl[name] = function (...a) { window.__locale++; return new Real(...a); }; Intl[name].prototype = Real.prototype; Intl[name].supportedLocalesOf = Real.supportedLocalesOf; }
    for (const [proto, names] of [[Number.prototype, ['toLocaleString']], [Date.prototype, ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']]])
      for (const n of names) { const real = proto[n]; proto[n] = function (...a) { window.__locale++; return real.apply(this, a); }; }
  };
  const command = { name: 'tldr', prompt: 'Summarize {input}', starter: false, updatedAt: new Date().toISOString() };
  const f = await fixture(t, { init, boot: { ...account, quota: { pct: 12 }, commands: [command], commandLimits: { ...account.commandLimits, maxPrompt: 3000 } } });
  const frame = await f.open(); await f.ready();
  await frame.locator('#q').fill('/'); await frame.locator('#slashMenu button').first().waitFor(); // the slash list works at once, your own command included
  assert.ok((await frame.locator('#slashMenu').innerText()).includes('/tldr'));
  await frame.locator('#q').fill('');
  assert.equal(await frame.evaluate(() => window.__locale), 0, 'no locale formatting before the first screen');
  assert.equal(await frame.locator('#companionSeg canvas').count(), 0, 'no companion pictures drawn yet');
  await frame.locator('#setBtn').click();
  await frame.locator('#tab-appearance').click();
  assert.deepEqual(await frame.locator('#companionSeg button').allInnerTexts(), ['Red panda', 'Cat', 'Fox', 'Frog']);
  const inked = await frame.evaluate(() => [...document.querySelectorAll('#companionSeg canvas')].map(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; }));
  assert.ok(inked.length === 4 && inked.every(n => n > 40), `each one is drawn: ${inked}`);
  await frame.locator('#tab-memory').click();
  assert.equal(await frame.locator('#cmdCount').innerText(), '0 / 3,000 characters', 'counted with this account’s limit, in the locale’s numbers');
  assert.equal(await frame.locator('#memoryCount').innerText(), '0 / 4,000 characters');
  await frame.locator('#cmdPrompt').fill('x'.repeat(1234));
  assert.equal(await frame.locator('#cmdCount').innerText(), '1,234 / 3,000 characters');
  await frame.locator('#tab-files').click();
  assert.equal(await frame.locator('#dsCmd').innerText(), '1 saved command');
  assert.ok(await frame.evaluate(() => window.__locale) > 0);
  // the pieces that format a date the first time they are needed: a restriction's end, a ban's dates
  const ends = new Date(Date.now() + 3 * 864e5).toISOString();
  const r = await fixture(t, { standalone: true, boot: { ...account, restriction: { id: 5, kind: 'restrict', state: 'restricted', reason: 'Too much', note: '', endsAt: ends, limits: { noWeb: true } } } });
  const restricted = await r.open(); await r.ready();
  assert.match(await restricted.locator('#rstText').innerText(), /^Your account is restricted until \S+ \d+, \d+:\d\d.*: no web search\.$/);
  const b = await fixture(t, { standalone: true, boot: { ...account, prefs: undefined, ban: { id: 7, key: 'k', state: 'active', hours: 24, endsAt: ends, at: new Date().toISOString(), name: 'Test reader', reason: 'Spam', note: '', appeal: null } } });
  const banned = await b.open(); await banned.locator('#ban').waitFor({ state: 'visible' });
  assert.match(await banned.locator('#banAt').innerText(), /\d{4}/);
  assert.match(await banned.locator('#banEnd').innerText(), /\d{4}/);
  assert.equal(await banned.locator('#q').isVisible(), false);
  // the panda's tables are set up when a panda is first drawn: the loader on the waiting screen
  const w = await fixture(t, { standalone: true, boot: { ...account, user: { ...account.user, status: 'pending' }, prefs: undefined } });
  const waiting = await w.open(); await waiting.locator('#wait').waitFor({ state: 'visible' });
  assert.equal(await waiting.locator('#waitPbl').getAttribute('data-state'), 'dangle');
  assert.ok(await waiting.locator('#waitPbl').evaluate(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; }) > 200, 'the loader is drawn');
});

// every kind of block, a code block with blank lines in it, a ``` that isn't closed until much later, markers that overlap, and no blank line at the end
const LONG = Array.from({ length: 14 }, (_, i) =>
  `## Part ${i + 1}\n\nSome **bold**, *italic* and \`code_${i}\` with a [link](https://example.com/p/${i}) and **a [tangled** one](https://example.com/t/${i}).\nA second line of the same paragraph.\n\n` +
  `- first point\n- second point with **weight**\n\n1. one\n2. two\n\n` +
  (i % 2 ? `| Name | Value |\n|:---|---:|\n| a${i} | ${i * 3} |\n| b \\| c | ${i} |\n\n` : `> A quoted line.\n> And another.\n\n---\n\n`) +
  (i % 3 === 0 ? '```js\nconst a = 1;\n\n\nconst b = `x`;\n```\n\n' : '') + (i === 7 ? 'Text right before a fence\n```\nno language\n\nstill code ** not bold **\n```\nand right after it.\n\n' : '')).join('') + 'The last line, with nothing after it.';

browserTest('a long answer streamed in small pieces is drawn exactly like the whole text at once, and its settled part is not drawn again', async t => {
  const f = await fixture(t, { standalone: true, answer: LONG, piece: 23 });
  const frame = await f.open(); await f.ready();
  await frame.locator('#q').fill('Explain'); await frame.locator('#sendBtn').click();
  // hold on to the first two blocks as soon as there are a few, and count how often anything before the last few is replaced
  await frame.waitForFunction(() => document.querySelectorAll('.msg.bot .body > *').length >= 6);
  await frame.evaluate(() => {
    const body = document.querySelector('.msg.bot .body'); window.__kept = [body.children[0], body.children[1]]; window.__redrawn = 0;
    new MutationObserver(list => { for (const m of list) for (const n of m.removedNodes) if (window.__kept.includes(n)) window.__redrawn++; }).observe(body, { childList: true });
  });
  await frame.locator('.msg.bot .meta').waitFor({ timeout: 20000 });
  const streamed = await frame.evaluate(() => { const body = document.querySelector('.msg.bot .body'); return { html: body.innerHTML, same: body.children[0] === window.__kept[0] && body.children[1] === window.__kept[1], redrawn: window.__redrawn, blocks: body.children.length }; });
  assert.ok(streamed.blocks > 60, `a long answer (${streamed.blocks} blocks)`);
  assert.equal(streamed.same, true, 'the first blocks are the very elements made when they arrived');
  assert.equal(streamed.redrawn, 0);
  // the same text drawn in one go: reopen the chat from history
  await frame.locator('#newBtn').click();
  await frame.locator('#histBtn').click();
  await frame.locator('.hrow .hopen').first().click();
  await frame.locator('.msg.bot .meta').waitFor();
  assert.equal(await frame.evaluate(() => document.querySelector('.msg.bot .body').innerHTML), streamed.html);
});

browserTest('stopping an answer part way leaves exactly what was on screen, wherever it stops', async t => {
  // in a paragraph, in a list, inside a table, inside a code block (after its blank lines), and right after a closing fence
  const stops = ['second line of', '- second point', '| a1 | 3', 'const b = `x', 'no language\n\nstill code ** not bold **\n```\n'].map(s => LONG.indexOf(s) + s.length);
  for (const at of stops) {
    assert.ok(at > 40, 'the sample has that place');
    const chatGate = deferred(), f = await fixture(t, { standalone: true, answer: LONG, piece: 19, chatGate, chatHold: at });
    const frame = await f.open(); await f.ready();
    await frame.locator('#q').fill('Explain'); await frame.locator('#sendBtn').click();
    await until('the answer to pause', () => f.state.held);
    await sleep(450); // the send button has become a stop button
    let before = '';
    await until('the last pieces to be painted', async () => { const now = await frame.evaluate(() => document.querySelector('.msg.bot .body').innerHTML); if (now === before) return true; before = now; await sleep(150); });
    assert.ok(before.length > 100);
    await frame.locator('#sendBtn').click(); // stop: the panel draws what it has from scratch
    await frame.locator('.msg.bot .meta').waitFor();
    assert.equal(await frame.locator('.msg.bot .meta').innerText(), 'Stopped');
    assert.equal(await frame.evaluate(() => document.querySelector('.msg.bot .body').innerHTML), before, `stopped ${at} characters in`);
  }
});

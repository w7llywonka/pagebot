import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// The panel inside the browser extension's side panel (README "Browser extension"), with a fake side panel page standing in
// for the extension: it answers the panel's requests from simple rules and records every message. Everything over HTTP is
// a fixture, and /api/chat is a stream the test feeds by hand (window.__push), as in widget-actions.test.js. The real
// extension, loaded into Chromium, is in extension-browser.test.js.
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
const browserTest = chromium ? test : test.skip;
const widget = await readFile(new URL('../public/widget.html', import.meta.url), 'utf8');
const FRAMED = "var extFramed = EXT_PARENT === 'chrome-extension://inknjdpepdgianddhnnpkdbpkjbbiomg' && location.ancestorOrigins.length === 1;";
assert.ok(widget.includes(FRAMED), 'the line tests stand in on');
const extWidget = widget.replace(FRAMED, 'var extFramed = true;'); // the fake side panel is an https page, not chrome-extension://
let browser;
before(async () => { if (chromium) browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] }); });
after(async () => { await browser?.close(); });

const ALL = ['navigate', 'new_tab', 'list_tabs', 'switch_tab', 'close_tab', 'read_console', 'read_network', 'javascript_exec',
  'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'type', 'key', 'hold_key'];
const TABS = [{ tab_id: 'tab-1', title: 'Article', url: 'https://news.example.test/a', active: true }, { tab_id: 'tab-2', title: 'Mail', url: 'https://mail.example.test/' }];
const boot = {
  authed: true, who: 'user', theme: 'ember', lockMinutes: 0, version: 14, extVersion: 1,
  user: { id: 1, name: 'Test reader', status: 'trusted', allowWeb: true, allowActions: true, passcode: false },
  prefs: { theme: 'ember', model: 'haiku', web: false, actions: true, actionsAuto: false },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku' }],
};
const done = { t: 'done', conversationId: 7, model: 'haiku', usage: { in: 50, out: 20 }, stop: 'end_turn' };

// The fake side panel: frames the panel and answers like the extension would. window.msgs is every message it got.
const sidePanel = `<!doctype html><html><body style="margin:0"><script>
  window.msgs = []; window.siteOnce = false; window.shot = '';
  const c = document.createElement('canvas'); c.width = 1600; c.height = 1100; // a tab 800 CSS pixels wide at 2x
  const g = c.getContext('2d'); g.fillStyle = '#c00'; g.fillRect(0, 0, 800, 550); g.fillStyle = '#04c'; g.fillRect(800, 0, 800, 1100);
  window.shot = c.toDataURL('image/jpeg', 0.9);
  const TABS = ${JSON.stringify(TABS)};
  function answer(d) {
    if (d.type === 'hello') return { v: 1, tools: ${JSON.stringify(ALL)} };
    if (d.type === 'page') return { page: { url: 'https://news.example.test/a', title: 'Article', text: 'From the page' }, selection: '' };
    if ((d.type === 'tool' || d.type === 'shot' || d.type === 'act') && window.siteOnce && !d.site) { window.siteOnce = false; return { no: 'site', site: 'other.example.test', sure: 'https://other.example.test' }; }
    if (d.type === 'tool') return d.name === 'view' ? { w: 800, h: 550, dpr: 2 } : d.name === 'read_page' ? { text: 'button "Save" [ref_100001]' } : { error: 'not in this fake' };
    if (d.type === 'shot') return { image: window.shot };
    if (d.type === 'act') return d.dry ? { role: 'button', label: 'Save', nav: '' } : { role: 'button', label: 'Save', nav: '', tabs: TABS };
    if (d.type !== 'ext') return { error: 'unknown' };
    const x = d.input || {};
    if (d.dry) {
      if (d.name === 'navigate') { const far = !String(x.url).startsWith('https://news.example.test/'); return { ask: far ? 'always' : 'setting', how: 'url', dest: x.url, far, sure: 'tok-nav' }; }
      if (d.name === 'javascript_exec') return { ask: 'always', sure: 'tok-js' };
      if (d.name === 'switch_tab') return { ask: x.tab_id === 'tab-2' ? 'always' : 'no', title: 'Mail', url: 'https://mail.example.test/', mine: x.tab_id !== 'tab-2', sure: 'tok-sw' };
      if (d.name === 'type') return { ask: 'setting', role: 'textbox', label: 'Search', sure: 'tok-type' };
      if (d.name === 'left_click') return { ask: 'setting', role: 'button', label: 'Buy', at: [x.target.x, x.target.y], go: '', sure: 'tok-click' };
      return { ask: 'no', sure: 'tok-' + d.name };
    }
    if (d.name === 'navigate') return { url: x.url, title: 'B', tabs: TABS };
    if (d.name === 'javascript_exec') return { value: '2' };
    if (d.name === 'type') return { role: 'textbox', label: 'Search', value: x.text };
    if (d.name === 'left_click') return { role: 'button', label: 'Buy', tabs: TABS };
    return { tabs: TABS };
  }
  addEventListener('message', e => {
    const f = document.querySelector('iframe');
    if (!f || e.source !== f.contentWindow) return;
    window.msgs.push(e.data);
    if (e.data && e.data.id != null) e.source.postMessage({ ...answer(e.data), id: e.data.id }, e.origin);
  });
</script><iframe title="pagebot" src="https://pagebot.example.test/widget?host=ext&ext=1" style="width:400px;height:860px;border:0"></iframe></body></html>`;

async function fixture(t, { prefs = {}, user = {}, bootMore = {}, where = 'ext', grant = false } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1000, height: 900 } });
  context.setDefaultTimeout(5000);
  if (grant) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://pagebot.example.test' });
  const state = { requests: [], errors: [], prefs: { ...boot.prefs, ...prefs } };
  t.after(async () => { await context.close(); assert.deepEqual(state.errors, [], 'no browser errors or unexpected requests'); });
  await context.addInitScript(() => {
    localStorage.setItem('pb_token', 'test-session');
    window.__shares = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = async () => { window.__shares++; throw new DOMException('no', 'NotAllowedError'); };
    const real = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url) !== '/api/chat') return real(url, opts);
      window.__bodies = [...(window.__bodies || []), JSON.parse(opts.body)];
      const enc = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({ start(c) {
        window.__push = ev => c.enqueue(enc.encode(JSON.stringify(ev) + '\n'));
        window.__end = () => c.close();
        opts?.signal?.addEventListener('abort', () => { try { c.error(new DOMException('Aborted', 'AbortError')); } catch {} });
      } }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
    };
  });
  const bookmarkHost = `<!doctype html><html><body><script>addEventListener('message', e => { const f = document.querySelector('iframe'); if (e.source !== f.contentWindow) return; if (e.data.type === 'page') e.source.postMessage({ id: e.data.id, page: { url: 'https://news.example.test/a', title: 'A', text: 'x' }, selection: '' }, e.origin); });</script><iframe title="pagebot" src="https://pagebot.example.test/widget?v=14" style="width:420px;height:860px;border:0"></iframe></body></html>`;
  const plainFrame = `<!doctype html><html><body><iframe title="pagebot" src="https://pagebot.example.test/widget?host=ext&ext=1" style="width:420px;height:860px;border:0"></iframe></body></html>`;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname === 'panel.example.test') return route.fulfill({ contentType: 'text/html', body: sidePanel });
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: url.pathname === '/plain' ? plainFrame : bookmarkHost });
    if (url.pathname === '/widget') return route.fulfill({ contentType: 'text/html', body: where === 'unpatched' ? widget : extWidget });
    if (url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    state.requests.push({ path: url.pathname, body: request.postDataJSON() });
    if (url.pathname === '/api/boot') return json({ ...boot, ...bootMore, user: { ...boot.user, ...user }, prefs: state.prefs });
    if (url.pathname === '/api/ping' || url.pathname === '/api/logout') return json({ ok: true });
    if (url.pathname === '/api/prefs') { Object.assign(state.prefs, request.postDataJSON()); return json({ prefs: state.prefs, limits: boot.limits }); }
    if (url.pathname === '/api/chat/act') return json({ ok: true });
    if (url.pathname === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
    state.errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  const at = { ext: 'https://panel.example.test/sidepanel', unpatched: 'https://news.example.test/plain', bookmark: 'https://news.example.test/a', chat: 'https://pagebot.example.test/chat' }[where];
  await page.goto(at);
  const frame = where === 'chat' ? page.mainFrame() : page.frames().find(f => f.url().startsWith('https://pagebot.example.test/'));
  await frame.locator('#setBtn').waitFor({ state: 'visible' });
  await frame.locator('#boot').waitFor({ state: 'detached' });
  const acts = () => state.requests.filter(r => r.path === '/api/chat/act').map(r => r.body);
  const msgs = () => page.evaluate(() => window.msgs || []);
  const push = ev => frame.evaluate(e => window.__push(e), ev);
  const ask = async (text = 'Do it') => {
    await frame.locator('#q').fill(text);
    await frame.locator('#sendBtn').click();
    await frame.waitForFunction(() => !!window.__push);
  };
  const waitActs = async n => { for (const end = Date.now() + 5000; acts().length < n; await new Promise(r => setTimeout(r, 30))) if (Date.now() > end) assert.fail(`expected ${n} results, got ${acts().length}`); };
  return { page, frame, state, acts, msgs, push, ask, waitActs };
}
const ev = (id, name, input = {}, ask = true) => ({ t: 'act', id, name, input, wait: 300000, ask });

browserTest('in the side panel the panel says it runs in the extension, sends what it can run, and has no bookmark controls', async t => {
  const f = await fixture(t);
  assert.equal(await f.frame.evaluate(() => document.documentElement.classList.contains('nohost')), true);
  for (const id of ['#minBtn', '#dockBtn']) assert.equal(await f.frame.locator(id).isVisible(), false, id);
  assert.equal(await f.frame.locator('#closeBtn').getAttribute('title'), 'Close pagebot');
  assert.equal(await f.frame.locator('#upd').isVisible(), false, 'no "drag the new bookmark" banner in the extension');
  const types = (await f.msgs()).map(m => m.type);
  assert.ok(types.includes('hello'));
  assert.ok(!types.includes('ready'), 'the bookmark’s ready message never goes to the side panel');
  await f.ask();
  const body = await f.frame.evaluate(() => window.__bodies.at(-1));
  assert.deepEqual([body.actions, body.host, body.ext, body.tools], [true, 'ext', 1, ALL]);
  const run = (await f.msgs()).find(m => m.type === 'run');
  assert.ok(run.on && /^[0-9a-f]{24}$/.test(run.run), 'the answer’s run starts before the question goes');
  await f.push({ t: 'd', v: 'Fine.' }); await f.push(done); await f.frame.evaluate(() => window.__end());
  await f.page.waitForFunction(id => window.msgs.some(m => m.type === 'run' && m.on === false && m.run === id), run.run); // and ends with the answer
  await f.frame.locator('#closeBtn').click();
  await f.page.waitForFunction(() => window.msgs.some(m => m.type === 'close')); // the side panel is told to close
});

browserTest('a bookmark panel and a page that frames ?host=ext itself are not the extension', async t => {
  const b = await fixture(t, { where: 'bookmark' });
  await b.frame.locator('#q').fill('Hi');
  await b.frame.locator('#sendBtn').click();
  await b.frame.waitForFunction(() => !!window.__push);
  const body = await b.frame.evaluate(() => window.__bodies.at(-1));
  assert.equal('host' in body || 'tools' in body || 'ext' in body, false);
  const u = await fixture(t, { where: 'unpatched' });
  assert.equal(await u.frame.evaluate(() => document.documentElement.classList.contains('nohost')), false, 'an https parent is not an extension page');
  assert.equal(await u.frame.evaluate(() => window.__pbEarly.ext), false, 'it acts as a bookmark-style frame');
});

browserTest('a screenshot step needs no sharing: the extension takes it, scaled like the bookmark’s, and the + menu’s too', async t => {
  const f = await fixture(t);
  await f.ask();
  await f.push(ev('s1', 'screenshot', {}, false));
  await f.waitActs(1);
  const r = f.acts()[0];
  assert.deepEqual([r.result.w, r.result.h, r.result.scale], [800, 550, 1]);
  assert.match(r.result.image, /^data:image\/jpeg;base64,/);
  assert.equal(await f.frame.locator('.acard.share').count(), 0, 'no Share this tab card');
  assert.equal(await f.frame.locator('.athumb').count(), 1);
  const run = (await f.msgs()).find(m => m.type === 'run').run;
  assert.ok((await f.msgs()).some(m => m.type === 'shot' && m.run === run), 'asked for with the answer’s run');
  await f.push({ t: 'd', v: 'Seen.' }); await f.push(done);
  await f.frame.locator('.msg.bot .meta').waitFor();
  await f.frame.locator('#addBtn').click();
  await f.frame.locator('#shotBtn').click();
  await f.frame.locator('#att img, .att img, #attach img').first().waitFor().catch(() => {});
  const shots = (await f.msgs()).filter(m => m.type === 'shot');
  assert.equal(shots.length, 2);
  assert.equal(shots[1].run, undefined, 'the + menu’s screenshot isn’t a step');
  assert.equal(await f.frame.evaluate(() => window.__shares), 0, 'getDisplayMedia is never asked');
  assert.equal(await f.frame.locator('#stopBtn').isVisible(), false);
});

browserTest('another site always asks, even with clicks not asking, and has no Allow all; the same site follows the setting', async t => {
  const f = await fixture(t, { prefs: { actionsAuto: true } });
  await f.ask();
  await f.push(ev('n1', 'navigate', { url: 'https://other.example.test/' }));
  await f.frame.locator('.acard').waitFor();
  assert.match(await f.frame.locator('.acard .aq').innerText(), /Go to other\.example\.test/);
  assert.match(await f.frame.locator('.acard .aw').innerText(), /takes the tab to another site \(other\.example\.test\)\. pagebot stays open\./);
  assert.deepEqual(await f.frame.locator('.acard button').allInnerTexts(), ['Allow', 'Skip']);
  await f.frame.getByRole('button', { name: 'Skip', exact: true }).click();
  await f.waitActs(1);
  assert.equal(f.acts()[0].denied, true);
  assert.equal((await f.msgs()).filter(m => m.type === 'ext' && !m.dry).length, 0, 'nothing ran');
  await f.push(ev('n2', 'navigate', { url: 'https://news.example.test/b' }));
  await f.waitActs(2);
  assert.equal(await f.frame.locator('.acard').count(), 0, 'the same site doesn’t ask with clicks not asking');
  assert.deepEqual(f.acts()[1].result, { url: 'https://news.example.test/b', title: 'B', tabs: TABS }, 'the tabs go back to the server as they came');
  assert.equal(f.acts()[1].note, 'Went to news.example.test/b');
  assert.equal((await f.msgs()).find(m => m.type === 'ext' && !m.dry).sure, 'tok-nav', 'the run carries the dry run’s token');
});

browserTest('the same site asks when clicks ask, with Allow all; tabs pagebot didn’t open always ask; listing tabs never does', async t => {
  const f = await fixture(t);
  await f.ask();
  await f.push(ev('n1', 'navigate', { url: 'https://news.example.test/b' }));
  await f.frame.locator('.acard').waitFor();
  assert.deepEqual(await f.frame.locator('.acard button').allInnerTexts(), ['Allow', 'Skip', 'Allow all for this answer']);
  await f.frame.getByRole('button', { name: 'Allow', exact: true }).click();
  await f.waitActs(1);
  await f.push(ev('l1', 'list_tabs', {}, false));
  await f.waitActs(2);
  assert.equal(await f.frame.locator('.acard').count(), 0);
  assert.deepEqual(f.acts()[1].result, { tabs: TABS });
  await f.push(ev('w1', 'switch_tab', { tab_id: 'tab-2' }));
  await f.frame.locator('.acard').waitFor();
  assert.match(await f.frame.locator('.acard .aq').innerText(), /Switch to the “Mail” tab \(mail\.example\.test\)/);
  assert.match(await f.frame.locator('.acard .aw').innerText(), /pagebot can then read and use that tab/);
  assert.deepEqual(await f.frame.locator('.acard button').allInnerTexts(), ['Allow', 'Skip']);
  await f.frame.getByRole('button', { name: 'Allow', exact: true }).click();
  await f.waitActs(3);
  assert.equal(f.acts()[2].note, 'Switched to the “Mail” tab');
  const steps = await f.frame.locator('.steps .astep .ai').allInnerTexts();
  assert.deepEqual(steps, ['↪', '☰', '⇆']);
});

browserTest('a script always asks and shows its code; Allow runs exactly what was shown', async t => {
  const f = await fixture(t, { prefs: { actionsAuto: true } });
  await f.ask();
  const code = 'document.title\n  + " and more"';
  await f.push(ev('j1', 'javascript_exec', { text: code }));
  await f.frame.locator('.acard').waitFor();
  assert.equal(await f.frame.locator('.acard pre.acode').innerText(), code);
  assert.match(await f.frame.locator('.acard .aw').innerText(), /A script can do anything the page can/);
  assert.deepEqual(await f.frame.locator('.acard button').allInnerTexts(), ['Allow', 'Skip']);
  await f.frame.getByRole('button', { name: 'Allow', exact: true }).click();
  await f.waitActs(1);
  const ran = (await f.msgs()).find(m => m.type === 'ext' && m.name === 'javascript_exec' && !m.dry);
  assert.equal(ran.sure, 'tok-js');
  assert.equal(ran.input.text, code);
  assert.deepEqual(f.acts()[0].result, { value: '2' });
});

browserTest('a new site asks before pagebot works there, then the step runs; a point is turned back into the page’s pixels', async t => {
  const f = await fixture(t);
  await f.ask();
  await f.push(ev('s1', 'screenshot', {}, false));
  await f.waitActs(1);
  await f.page.evaluate(() => { window.siteOnce = true; });
  await f.push(ev('r1', 'read_page', { depth: 15 }, false));
  await f.frame.locator('.acard').waitFor();
  assert.match(await f.frame.locator('.acard .aq').innerText(), /Work on other\.example\.test/);
  assert.match(await f.frame.locator('.acard .aw').innerText(), /pagebot is on a new site now \(other\.example\.test\)/);
  assert.deepEqual(await f.frame.locator('.acard button').allInnerTexts(), ['Allow', 'Skip']);
  await f.frame.getByRole('button', { name: 'Allow', exact: true }).click();
  await f.waitActs(2);
  const reads = (await f.msgs()).filter(m => m.type === 'tool' && m.name === 'read_page');
  assert.deepEqual(reads.map(m => m.site), [undefined, 'https://other.example.test']);
  assert.equal(f.acts()[1].result.text, 'button "Save" [ref_100001]');
  await f.push(ev('c1', 'left_click', { target: { type: 'coordinate', x: 400, y: 300 } }));
  await f.frame.locator('.acard').waitFor();
  assert.match(await f.frame.locator('.acard .aq').innerText(), /Click the “Buy” button \(at 400, 300\)/);
  await f.frame.getByRole('button', { name: 'Allow', exact: true }).click();
  await f.waitActs(3);
  assert.equal(f.acts()[2].note, 'Clicked the “Buy” button');
  const click = (await f.msgs()).find(m => m.type === 'ext' && m.name === 'left_click' && m.dry);
  assert.deepEqual(click.input.target, { type: 'coordinate', x: 400, y: 300 }, 'k is 1 here (an 800 pixel wide tab)');
});

browserTest('Stop ends the run, and no step goes to the side panel after it', async t => {
  const f = await fixture(t);
  await f.ask();
  await f.push(ev('t1', 'type', { text: 'hello' }));
  await f.frame.locator('.acard').waitFor();
  assert.match(await f.frame.locator('.acard .aq').innerText(), /Type “hello” into the “Search” box/);
  await f.frame.waitForTimeout(450); // a double-click on send isn't a stop
  await f.frame.locator('#sendBtn').click();
  await f.frame.locator('.acard').waitFor({ state: 'detached' });
  const m = await f.msgs(), run = m.find(x => x.type === 'run').run;
  assert.ok(m.some(x => x.type === 'run' && x.run === run && x.on === false));
  assert.equal(m.filter(x => x.type === 'ext' && !x.dry).length, 0, 'the typing never ran');
});

browserTest('Settings: the install area, with the Download link and the steps; inside the extension, its version', async t => {
  const f = await fixture(t);
  await f.frame.locator('#setBtn').click();
  await f.frame.locator('#tab-actions').click();
  assert.equal(await f.frame.locator('#extLead').innerText(), 'You’re using the extension, version 1.');
  assert.equal(await f.frame.locator('#extHint').innerText(), 'It’s up to date.');
  assert.equal(await f.frame.locator('#extGet').getAttribute('href'), '/pagebot-extension.zip');
  assert.equal(await f.frame.locator('#extSteps').isVisible(), false);
  assert.match(await f.frame.locator('#tab-actions small').innerText(), /^Extension · asks before each click$/);
  assert.match(await f.frame.locator('#verLine').innerText(), /extension v1/);
  assert.match(await f.frame.locator('#actLeave').innerText(), /always asks before it goes to another site/);
  const old = await fixture(t, { bootMore: { extVersion: 2 } });
  assert.equal(await old.frame.locator('#upd').isVisible(), true);
  assert.match(await old.frame.locator('#upd').innerText(), /newer pagebot extension/);
  await old.frame.locator('#updGo').click();
  assert.equal(await old.frame.locator('#extLead').innerText(), 'Version 2 of the extension is out.');
  assert.deepEqual(await old.frame.locator('#extSteps li').allInnerTexts(), ['Download the new zip and unzip it.', 'Put its files in your pagebot-extension folder, in place of the old ones.',
    'In chrome://extensions, click ↻ on pagebot, then reopen the side panel.']);
});

browserTest('Settings in the bookmark panel and in /chat: Download and seven steps; Copy copies the address; hidden without page actions', async t => {
  for (const where of ['bookmark', 'chat']) {
    const f = await fixture(t, { where, grant: true });
    await f.frame.locator('#setBtn').click();
    await f.frame.locator('#tab-actions').click();
    const get = f.frame.locator('#extGet');
    assert.equal(await get.getAttribute('href'), '/pagebot-extension.zip');
    assert.equal(await get.getAttribute('download'), '');
    assert.equal(await get.innerText(), 'Download');
    const steps = await f.frame.locator('#extSteps li').allInnerTexts();
    assert.equal(steps.length, 7);
    assert.match(steps[3], /Load unpacked/);
    assert.match(await f.frame.locator('#extHint').innerText(), /Works in Chrome, Edge and Brave/);
    if (where === 'chat') {
      assert.match(await f.frame.locator('#actAvail').innerText(), /need a web page\. Open pagebot from your bookmark or the extension/);
      await f.frame.locator('#extCopy').click();
      await f.frame.locator('#extCopy', { hasText: 'Copied' }).waitFor();
      assert.equal(await f.frame.evaluate(() => navigator.clipboard.readText()), 'chrome://extensions');
    }
    assert.equal(await f.frame.locator('#aboutExt').count(), 1);
  }
  const off = await fixture(t, { where: 'bookmark', user: { allowActions: false } });
  await off.frame.locator('#setBtn').click();
  await off.frame.locator('#tab-actions').click();
  assert.equal(await off.frame.locator('#extSec').isVisible(), false);
  assert.equal(await off.frame.locator('#aboutExt').isHidden(), true);
});

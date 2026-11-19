import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, sleep, startExtension, until, why } from './helpers/ext-harness.mjs';

// "Ask pagebot" on selected text (extension/worker.js), in the real extension from the served zip (tests/helpers/ext-harness.mjs).
// What a headless browser can't do is show its own right-click menu, so by default nothing here clicks the menu item itself.
// Instead: the item the install registered is read back from the browser (the API, and the browser's own record of it), and
// the worker's click handler (worker.js as the zip ships it) is run inside a real user gesture, the toolbar button's, since
// the browser opens a side panel only in response to one; then the side panel that opens is used the way a person would.
// The last test, opt-in, does click the real menu: a headed browser on a virtual display (xvfb-run), with the key press that
// chooses the item sent by the X server (python3's ctypes and libXtst, nothing from npm). Run it with
//   PAGEBOT_TEST_NATIVE_MENU=1 xvfb-run -a -s "-screen 0 1400x1000x24" node --test tests/extension-menu.test.js
// (never on a desktop of your own: the key press goes to whatever window has the keyboard).
const native = why || (process.env.PAGEBOT_TEST_NATIVE_MENU !== '1' ? 'the real right-click menu is opt-in: PAGEBOT_TEST_NATIVE_MENU=1 under xvfb-run'
  : !process.env.DISPLAY ? 'no DISPLAY: run it under xvfb-run' : '');
// one key press from the X server, which is where a native menu takes its keys from
const XKEY = `import ctypes, sys
x = ctypes.cdll.LoadLibrary('libX11.so.6'); t = ctypes.cdll.LoadLibrary('libXtst.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p; x.XStringToKeysym.restype = ctypes.c_ulong; x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
p = x.XOpenDisplay(None)
if not p: sys.exit('no X display')
d = ctypes.c_void_p(p); k = x.XKeysymToKeycode(d, x.XStringToKeysym(sys.argv[1].encode()))
t.XTestFakeKeyEvent(d, k, True, 0); t.XTestFakeKeyEvent(d, k, False, 0); x.XFlush(d)`;
const xkey = name => execFileSync('python3', ['-I', '-c', XKEY, name], { timeout: 10_000 });
let H;
const QUOTE = 'The quick brown fox jumps over the lazy dog.';
const pages = {
  '/article': () => `<!doctype html><html><head><title>Article</title></head><body style="margin:0;font:16px sans-serif">
<h1>An article</h1><p id="quote">${QUOTE}</p><p id="more">Some more words after it.</p></body></html>`,
  '/second': () => '<!doctype html><html><head><title>Second</title></head><body><p id="other">Words on another tab.</p></body></html>',
};
// Chromium keeps a service worker extension's menu items in the profile's "Extension State" store (LevelDB), as JSON under
// "<extension id>.context_menus", so they come back when the worker restarts. Its log file holds the latest write as text.
function storedMenus(dir, id) {
  const store = path.join(dir, 'profile', 'Default', 'Extension State');
  if (!existsSync(store)) return null;
  for (const f of readdirSync(store).filter(n => n.endsWith('.log'))) {
    const s = readFileSync(path.join(store, f)).toString('latin1'), at = s.lastIndexOf(`${id}.context_menus`);
    if (at < 0) continue;
    const from = s.indexOf('[', at);
    for (let end = s.indexOf(']', from); end > 0; end = s.indexOf(']', end + 1)) {
      try { return JSON.parse(s.slice(from, end + 1)); } catch { /* not the end of the list yet */ }
    }
  }
  return null;
}
// worker.js run again inside the worker, with `chrome` standing for the real one: its listeners are kept (not registered a
// second time) and its calls go through to the browser, each recorded with how it came out
const rerun = src => `(() => {
  const caught = {}, calls = [];
  const wrap = (obj, at) => new Proxy(obj, { get(t, k) {
    const v = Reflect.get(t, k);
    if (typeof k === 'symbol') return v;
    const here = at ? at + '.' + k : k;
    if (k === 'addListener' && typeof v === 'function') return fn => { (caught[at] ||= []).push(fn); };
    if (typeof v === 'function') return (...args) => {
      const c = { at: here, args: JSON.parse(JSON.stringify(args.filter(a => typeof a !== 'function'))) };
      calls.push(c);
      const r = v.apply(t, args);
      if (r && typeof r.then === 'function') r.then(() => { c.outcome = 'ok'; }, e => { c.outcome = String(e && e.message || e); });
      return r;
    };
    return v && typeof v === 'object' ? wrap(v, here) : v;
  } });
  const chrome = wrap(globalThis.chrome, '');
  ${src}
  globalThis.__worker = { caught, calls };
  return Object.fromEntries(Object.entries(caught).map(([k, v]) => [k, v.length]));
})()`;


before(async () => {
  if (why) return;
  H = await startExtension({ pages });
});
after(async () => { await H?.close(); });

test('Ask pagebot on selected text, in the real extension', { skip: why || false }, async t => {
  const SIDE_PANEL = () => `chrome-extension://${H.EXT_ID}/sidepanel.html`;
  const opens = () => H.sw.evaluate(() => __worker.calls.filter(c => c.at === 'sidePanel.open'));
  const menuInfo = (page, text) => ({ menuItemId: 'ask', selectionText: text, pageUrl: page.url(), editable: false, frameId: 0 });
  // The worker's own click handler, handed the menu's click inside the toolbar button's click (Extensions.triggerAction):
  // a real user gesture, as the menu's click is. Other items and a click with no tab come first and must do nothing.
  // Returns the sidePanel.open calls it made, each with how it came out.
  async function askWithGesture(cdp, page, info) {
    await H.sw.evaluate(async info => {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); // so the button's click reaches the worker
      globalThis.__menuClick = tab => {
        __worker.calls.length = 0;
        const [handler] = __worker.caught['contextMenus.onClicked'];
        handler({ ...info, menuItemId: 'something-else' }, tab);
        handler(info, undefined);
        handler(info, tab);
      };
      chrome.action.onClicked.addListener(__menuClick);
    }, info);
    try {
      const target = (await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] })).result.targetInfos.find(x => x.url === page.url());
      const pressed = await cdp.send('Extensions.triggerAction', { id: H.EXT_ID, targetId: target.targetId });
      assert.equal(pressed.error, undefined, JSON.stringify(pressed.error));
      return await until('the handler to open the side panel', async () => { const o = await opens(); return o[0]?.outcome && o; });
    } finally {
      await H.sw.evaluate(async () => {
        chrome.action.onClicked.removeListener(__menuClick);
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      });
    }
  }

  await t.test('installing it registers one item, "Ask pagebot", shown for selected text only', async () => {
    const { sw, EXT_ID } = H;
    // the install's onInstalled clears the menu and then adds the item, so it can be a moment after the worker starts
    await until('the install to add the item', () => sw.evaluate(() => chrome.contextMenus.update('ask', {}).then(() => true, () => false)), 10000);
    const api = await sw.evaluate(async () => ({
      listening: chrome.contextMenus.onClicked.hasListeners(),
      again: await new Promise(r => chrome.contextMenus.create({ id: 'ask', title: 'Again' }, () => r(chrome.runtime.lastError?.message || 'created'))),
    }));
    assert.deepEqual(api, { listening: true, again: 'Cannot create item with duplicate id ask' }, 'the item is there, by the id the click handler looks for');
    // the browser's record: contexts is a bit set, and 4 is Chromium's bit for "selection" (page is 2, link 8, all 1)
    const items = await until('the browser to record the menu', () => storedMenus(H.dir, EXT_ID), 15000);
    assert.deepEqual(items.map(i => ({ id: i.string_uid, title: i.title, contexts: i.contexts, enabled: i.enabled, visible: i.visible, type: i.type, pages: i.document_url_patterns })),
      [{ id: 'ask', title: 'Ask pagebot', contexts: 4, enabled: true, visible: true, type: 0, pages: ['http://*/*', 'https://*/*'] }], 'only on web pages, the ones pagebot reads');
  });

  await t.test('choosing it opens the side panel beside the page (with a gesture, never without), and the question carries the selection', async () => {
    const { ctx, sw, NEWS, ORIGIN } = H;
    const page = t.page = await ctx.newPage();
    await page.goto(`${NEWS}/article`);
    for (const p of ctx.pages()) if (p !== page && p.url() === 'about:blank') await p.close();
    await page.locator('#quote').selectText(); // what a person highlights before right-clicking
    assert.equal(await page.evaluate(() => String(getSelection())), QUOTE);
    const before = await page.evaluate(() => innerWidth);

    const src = readFileSync(path.join(H.dir, 'pagebot-extension', 'worker.js'), 'utf8');
    assert.deepEqual(await sw.evaluate(rerun(src)), { 'runtime.onInstalled': 1, 'contextMenus.onClicked': 1, 'runtime.onConnect': 1 });
    const tab = await sw.evaluate(async u => { const [x] = await chrome.tabs.query({ url: u }); return { id: x.id, windowId: x.windowId, url: x.url }; }, page.url());
    const info = menuInfo(page, QUOTE);

    // without a gesture (called straight from here) the browser refuses to open the panel, and the handler lets it go quietly
    await sw.evaluate(({ info, tab }) => { __worker.calls.length = 0; __worker.caught['contextMenus.onClicked'][0](info, tab); }, { info, tab });
    const refused = await until('the refusal', async () => { const o = await opens(); return o[0]?.outcome && o; });
    assert.deepEqual(refused, [{ at: 'sidePanel.open', args: [{ windowId: tab.windowId }], outcome: '`sidePanel.open()` may only be called in response to a user gesture.' }]);

    const cdp = await H.browserCdp();
    let b2;
    try {
      // with one: a single open, for the page's window
      assert.deepEqual(await askWithGesture(cdp, page, info), [{ at: 'sidePanel.open', args: [{ windowId: tab.windowId }], outcome: 'ok' }]);
      b2 = await chromium.connectOverCDP(`http://127.0.0.1:${cdp.port}`);
      const sp = await until('the side panel page', () => b2.contexts().flatMap(c => c.pages()).find(p => p.url() === SIDE_PANEL()));
      const width = await until('the side panel to take room beside the page', async () => { const w = await page.evaluate(() => innerWidth); return w < before && w; });
      assert.ok(width < before);
      assert.equal(await page.evaluate(() => String(getSelection())), QUOTE, 'the page keeps its selection');
      // (as in extension-browser.test.js: Playwright joining late may miss the frame in another process; a reload shows it)
      const panelFrame = () => sp.frames().find(f => f.url().startsWith(ORIGIN + '/widget'));
      let wf = await until('the panel in it', panelFrame, 4000).catch(() => null);
      if (!wf) { await sp.reload(); wf = await until('the panel in it, after a reload', panelFrame, 20000); }
      assert.equal(new URL(wf.url()).search, '?host=ext&ext=1');
      await H.signIn(wf);
      // the highlight was there before the panel opened (and before its helper was in the page): the panel shows it
      await until('the ✂️ pill to show the highlight', async () => await wf.locator('#selPill').isVisible() && (await wf.locator('#selPill').getAttribute('title')).includes(QUOTE), 4000);
      const body = await H.question(wf, 'What does this mean?');
      assert.equal(body.selection, QUOTE, 'the highlighted passage goes with the question');
      assert.equal(body.page.url, page.url(), 'with the page it was chosen on');
      assert.match(body.page.text, /The quick brown fox/);
      assert.equal(body.host, 'ext');
      H.finish();
      await wf.locator('#closeBtn').click();
      await until('the side panel to close', () => !b2.contexts().flatMap(c => c.pages()).some(p => p.url() === SIDE_PANEL()));
    } finally { await b2?.close().catch(() => {}); cdp.close(); }
  });

  // The panel reads the highlight as it starts (ask('page') in public/widget.html), and the side panel's first {type:'tab'}
  // message, sent once the panel's frame has loaded (extension/sidepanel.js), clears it (setSel('')). On a tab where pagebot's
  // helper is already loaded (any tab the panel was open on before) that read used to come back first, so the ✂️ pill ("Your
  // highlight goes with your next message") was cleared as the panel started and stayed hidden, yet the question read the
  // highlight again and sent it: the person couldn't see it or leave it out first. The side panel now sends what's
  // highlighted straight after each 'tab'. (Selecting text only a moment before the panel opens hid this: the helper's own
  // report of the new highlight, 160 ms later, put the pill back. A person right-clicking and choosing takes longer than
  // that.) The frame is read over CDP: Playwright would need to reload the side panel to see the frame, and a reload is a
  // second start.
  await t.test('choosing it again on the same tab: the panel shows the highlight it will send', async () => {
    const { page } = t;
    const cdp = await H.browserCdp();
    const targets = async () => (await cdp.send('Target.getTargets')).result.targetInfos;
    const seen = [];
    try {
      for (const [sel, text] of [['#more', 'Some more words after it.'], ['#quote', QUOTE], ['#more', 'Some more words after it.']]) {
        await page.evaluate(() => getSelection().removeAllRanges());
        await page.locator(sel).selectText();
        await sleep(500); // a person takes longer than this to right-click and choose
        assert.equal((await askWithGesture(cdp, page, menuInfo(page, text)))[0].outcome, 'ok');
        const frame = await until('the panel’s frame', async () => (await targets()).find(x => x.type === 'iframe' && x.url.startsWith(H.ORIGIN + '/widget')), 10000);
        const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId: frame.targetId, flatten: true })).result;
        await sleep(1500); // the panel has started, signed in (as the test before left it), and heard from the side panel
        const pill = (await cdp.send('Runtime.evaluate', { returnByValue: true, expression:
          `(() => { const p = document.querySelector('#selPill'); return { shown: !p.hidden && !!p.offsetParent, read: p.title.includes(${JSON.stringify(text)}) }; })()` }, sessionId)).result.result.value;
        assert.equal(pill.read, true, 'the panel read the highlight');
        seen.push(pill.shown ? 'shown' : 'hidden');
        const sp = (await targets()).find(x => x.url === SIDE_PANEL());
        await cdp.send('Target.closeTarget', { targetId: sp.targetId });
        await until('the side panel to close', async () => !(await targets()).some(x => x.url === SIDE_PANEL()), 10000);
      }
      assert.deepEqual(seen, ['shown', 'shown', 'shown']);
    } finally { cdp.close(); }
  });

  await t.test('the highlight follows the tab that’s showing, and leaving it out lasts while the page retitles itself', async () => {
    const { ctx, NEWS } = H;
    const a = await ctx.newPage(), b = await ctx.newPage();
    await a.goto(`${NEWS}/article`);
    await b.goto(`${NEWS}/second`);
    await b.locator('#other').selectText(); // highlighted before pagebot is open, on a tab that isn't showing then
    await a.bringToFront();
    await a.locator('#quote').selectText();
    const { panel, frame } = await H.openPanel(a);
    try {
      if (await frame.locator('#pw').isVisible()) await H.signIn(frame);
      const pill = () => frame.locator('#selPill');
      const shows = text => until(`the ✂️ pill to show “${text}”`, async () => await pill().isVisible() && (await pill().getAttribute('title')).includes(text), 5000);
      await shows(QUOTE);
      await b.bringToFront();
      await shows('Words on another tab.');
      await pill().click(); // leave it out
      assert.equal(await pill().isVisible(), false);
      await b.evaluate(() => { document.title = 'Second (1 new)'; }); // a page that changes its own title, as inboxes do
      await sleep(1200);
      assert.equal(await pill().isVisible(), false, 'what the person left out stays out');
      await a.bringToFront();
      await shows(QUOTE);
    } finally { await panel.close().catch(() => {}); await a.close(); await b.close(); }
  });

  await t.test('the real right-click menu on selected text: Escape leaves it, choosing Ask pagebot opens the side panel', { skip: native || false }, async () => {
    const H2 = await startExtension({ pages, headless: false });
    let cdp;
    try {
      const { ctx, NEWS, EXT_ID } = H2;
      const page = await ctx.newPage();
      await page.goto(`${NEWS}/article`);
      for (const p of ctx.pages()) if (p !== page && p.url() === 'about:blank') await p.close();
      await page.bringToFront();
      await page.locator('#quote').selectText();
      const before = await page.evaluate(() => innerWidth);
      cdp = await H2.browserCdp();
      const panelOpen = async () => (await cdp.send('Target.getTargets')).result.targetInfos.some(x => x.url === `chrome-extension://${EXT_ID}/sidepanel.html`);
      // the menu, dismissed: nothing opens
      await page.locator('#quote').click({ button: 'right' });
      await sleep(700);
      xkey('Escape');
      await sleep(1500);
      assert.equal(await panelOpen(), false, 'the menu alone opens nothing');
      assert.equal(await page.evaluate(() => innerWidth), before);
      // the menu again, and "Ask pagebot" chosen (the only item starting with A, so its letter picks it)
      await page.locator('#quote').click({ button: 'right' });
      await sleep(700);
      xkey('a');
      await until('the side panel to open', panelOpen, 10000);
      await until('the side panel to take room beside the page', async () => (await page.evaluate(() => innerWidth)) < before, 10000);
      assert.equal(await page.evaluate(() => String(getSelection())), QUOTE, 'the page keeps its selection');
    } finally { cdp?.close(); await H2.close(); }
  });
});

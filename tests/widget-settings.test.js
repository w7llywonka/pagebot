import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// The redesigned Settings (categories, two panes or drill-in) with Playwright and a local Chromium. Every HTTP response is a fixture.
// The panel is an iframe of the width being tested, inside a host page that records what the panel tells it.
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
const browserTest = chromium ? test : test.skip;
const widget = await readFile(new URL('../public/widget.html', import.meta.url), 'utf8');
let browser;
before(async () => {
  if (chromium) browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); });

const ORIGIN = 'https://pagebot.example.test';
const CATS = ['general', 'appearance', 'memory', 'actions', 'files', 'privacy', 'account', 'usage', 'about'];
const TITLES = ['General', 'Appearance', 'Memory & commands', 'Page actions', 'Files & chats', 'Privacy', 'Account', 'Usage', 'About'];
const THEMES = ['auto', 'ember', 'paper', 'midnight', 'forest', 'dusk', 'sakura', 'terminal', 'pond', 'orbit', 'void', 'arcade', 'glass', 'clear'];
const done = { t: 'done', conversationId: 42, model: 'haiku', usage: { in: 50, out: 20 }, stop: 'end_turn' };
const cmd = (name, prompt, starter = false) => ({ name, prompt, starter, updatedAt: '2026-01-01T00:00:00.000Z' });

// width: the panel's width (below 560 it drills in, from 560 it has two panes); hostV: the bookmark's version (the panel's ?v=)
async function fixture(t, { width = 720, height = 760, standalone = false, who = 'user', hostV = 12, theme = 'ember', reduced = true, user = {}, prefs = {}, quota, commands = [],
  memories = [], version = 11, store = {}, pdfs = [], chats = 3, models = [{ key: 'haiku', label: 'Haiku' }, { key: 'sonnet', label: 'Sonnet' }], limits = { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 } } = {}) {
  const context = await browser.newContext({ reducedMotion: reduced ? 'reduce' : 'no-preference', viewport: standalone ? { width, height } : { width: width + 40, height: height + 40 } });
  context.setDefaultTimeout(5000);
  const state = { requests: [], errors: [], prefs: { theme, model: 'haiku', web: false, ...prefs }, limits: { ...limits }, commands: [...commands], memories: [...memories], pdfs: [...pdfs], chats, removed: 0 };
  t.after(async () => { await context.close(); assert.deepEqual(state.errors, [], 'no browser errors or unexpected requests'); });
  await context.addInitScript(([items]) => {
    localStorage.setItem('pb_token', 'test-session');
    for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
  }, [store]);
  const hostPage = `<!doctype html><html><body style="margin:0"><script>
    window.hostRequests = [];
    addEventListener('message', event => {
      if (event.source !== document.querySelector('iframe')?.contentWindow) return;
      window.hostRequests.push(event.data);
      if (event.data.type === 'page') event.source.postMessage({ id: event.data.id, page: { url: 'https://news.example.test/article', title: 'Article', text: 'x' }, selection: '' }, event.origin);
    });
  </script><iframe title="Pagebot" src="${ORIGIN}/widget?v=${hostV}" style="width:${width}px;height:${height}px;border:0"></iframe></body></html>`;
  const owner = who === 'owner';
  const boot = () => ({
    version, authed: true, who: owner ? 'owner' : 'user', theme: state.prefs.theme, lockMinutes: 0, lock: 'password', passwordSet: true, accounts: { on: true, signup: false },
    ...(owner ? {} : { user: { id: 1, name: 'Maya', status: 'trusted', allowWeb: true, allowSonnet: true, passcode: false, ...user }, ...(quota && { quota }) }),
    prefs: state.prefs, limits: state.limits, models,
    commands: state.commands, commandLimits: { maxCommands: 50, maxPrompt: 2000, maxStarters: 3, reserved: ['new', 'web', 'page', 'screenshot', 'region', 'settings', 'help', 'summarize', 'keypoints', 'simple', 'history', 'pdf', 'actions'] },
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: hostPage });
    if (url.pathname === '/widget' || url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    state.requests.push({ path: url.pathname, search: url.search, method, body: method === 'GET' || method === 'DELETE' ? undefined : request.postDataJSON() });
    if (url.pathname === '/api/boot') return json(boot());
    if (url.pathname === '/api/logout' || url.pathname === '/api/ping') return json({ ok: true });
    if (url.pathname === '/api/prefs') {
      const b = request.postDataJSON();
      if ('maxTokens' in b) state.limits.maxTokens = b.maxTokens;
      Object.assign(state.prefs, Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'maxTokens')));
      return json({ prefs: state.prefs, limits: state.limits });
    }
    if (url.pathname === '/api/site-memory') {
      if (method === 'PUT') { const { site, instructions } = request.postDataJSON(), memory = { site, instructions, updatedAt: '2026-01-01T00:00:00.000Z' }; state.memories = state.memories.filter(m => m.site !== site).concat(memory); return json({ memory }); }
      return json({ memories: state.memories, maxSites: 100, maxInstructions: 4000 });
    }
    if (url.pathname === '/api/commands') {
      const sorted = () => [...state.commands].sort((a, b) => a.name.localeCompare(b.name));
      if (method === 'PUT') {
        const { name, prompt, starter, from } = request.postDataJSON(), c = cmd(name, prompt, starter);
        state.commands = state.commands.filter(x => x.name !== name && x.name !== from).concat(c);
        return json({ command: c, commands: sorted() });
      }
      if (method === 'DELETE') { state.commands = state.commands.filter(x => x.name !== url.searchParams.get('name')); return json({ ok: true, commands: sorted() }); }
      return json({ commands: sorted() });
    }
    if (url.pathname === '/api/pdf' && method === 'GET') return json({ used: state.pdfs.reduce((n, p) => n + p.size, 0), cap: 10 * 1048576, pdfs: state.pdfs });
    if (url.pathname === '/api/chats' && method === 'DELETE') { const removed = state.chats; state.chats = 0; state.removed = removed; return json({ ok: true, removed }); }
    if (url.pathname === '/api/chats' && method === 'GET') return json({ chats: [], next: null });
    if (url.pathname === '/api/account/passcode') return json({ ok: true, user: { ...boot().user, passcode: true }, lockMinutes: 0 });
    if (url.pathname === '/api/chat') return route.fulfill({ contentType: 'application/x-ndjson', body: [{ t: 'd', v: 'Hi.' }, done].map(e => JSON.stringify(e)).join('\n') + '\n' });
    state.errors.push(`Unexpected request: ${method} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  await page.goto(standalone ? ORIGIN + '/chat' : 'https://news.example.test/article');
  const frame = standalone ? page.mainFrame() : page.frames().find(f => f.url().startsWith(ORIGIN));
  await frame.locator('#setBtn').waitFor({ state: 'visible' });
  await frame.locator('#boot').waitFor({ state: 'detached' });
  const opens = () => frame.locator('#setBtn').click();
  // Settings remembers the category you were in; on a narrow panel that hides the list, so go back to it first
  const go = async name => { if (await frame.locator('#shBack').isVisible()) await frame.locator('#shBack').click(); await frame.locator('#tab-' + name).click(); await frame.locator('#cat-' + name).waitFor({ state: 'visible' }); };
  const reqs = path => state.requests.filter(r => r.path === path);
  const host = () => page.evaluate(() => window.hostRequests);
  const vis = sel => frame.locator(sel).isVisible();
  return { context, page, frame, state, opens, go, reqs, host, vis };
}

const until = async (fn, ms = 4000) => { const end = Date.now() + ms; let v; do { v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); } while (Date.now() < end); return v; }; // polls: the host's postMessages and re-renders land a moment after a click

browserTest('a wide panel shows two panes: the category list beside the selected category, with a sticky header and a readable column', async t => {
  const f = await fixture(t, { width: 720 });
  await f.opens();
  assert.equal(await f.vis('#snav'), true);
  assert.equal(await f.vis('#cat-general'), true, 'General is the first category');
  assert.deepEqual(await f.frame.locator('#stabs [role=tab] b').allInnerTexts(), TITLES);
  assert.equal(await f.frame.locator('#shTitle').innerText(), 'Settings');
  assert.equal(await f.vis('#shBack'), false, 'no Back where the list is always there');
  assert.equal(await f.frame.locator('#tab-general').getAttribute('aria-selected'), 'true');
  assert.equal(await f.frame.locator('#stabs').getAttribute('role'), 'tablist');
  assert.equal(await f.frame.locator('#cat-general').getAttribute('role'), 'tabpanel');
  assert.equal(await f.frame.locator('#cat-general').getAttribute('aria-labelledby'), 'tab-general');
  const geo = await f.frame.evaluate(() => { const r = s => document.querySelector(s).getBoundingClientRect(); return { nav: r('#snav'), pane: r('#spane'), head: r('.sh'), sheet: r('#sheet') }; });
  assert.ok(geo.nav.right <= geo.pane.left, 'list left, category right');
  assert.ok(geo.pane.width <= 600 && geo.pane.width > 380, `a comfortable column: ${geo.pane.width}`);
  assert.ok(Math.abs(geo.head.top - geo.sheet.top) < 1, 'the header sits at the top');
  // switching shows the other category without hiding the list; the header stays while the pane scrolls
  await f.frame.locator('#tab-appearance').click();
  assert.equal(await f.vis('#cat-appearance'), true);
  assert.equal(await f.vis('#cat-general'), false);
  assert.equal(await f.vis('#snav'), true);
  await f.frame.locator('#sbody').evaluate(e => { e.scrollTop = 400; });
  assert.ok(await f.frame.evaluate(() => document.querySelector('.sh').getBoundingClientRect().top === document.querySelector('#sheet').getBoundingClientRect().top), 'header is sticky');
  assert.ok(await f.frame.evaluate(() => document.querySelector('#snav').getBoundingClientRect().top < 120), 'and so is the list');
});

for (const [width, name] of [[300, 'a 300px panel'], [420, 'a 420px docked panel']]) browserTest(`${name} shows a list of categories that drills in, with Back and Done`, async t => {
  const f = await fixture(t, { width, store: width === 420 ? { pb_dock: '1' } : {} });
  await f.opens();
  assert.equal(await f.vis('#snav'), true);
  assert.equal(await f.vis('#spane'), false, 'the list is the whole screen');
  assert.equal(await f.vis('#shBack'), false);
  assert.match(await f.frame.locator('#tab-general small').innerText(), /Haiku · web search off/, 'each row has a summary');
  await f.frame.locator('#tab-memory').click();
  assert.equal(await f.vis('#cat-memory'), true);
  assert.equal(await f.vis('#snav'), false);
  assert.equal(await f.frame.locator('#shTitle').innerText(), 'Memory & commands');
  assert.equal(await f.frame.evaluate(() => document.activeElement.id), 'cat-memory', 'the keyboard moves into the category');
  await f.frame.locator('#shBack').click();
  assert.equal(await f.vis('#snav'), true);
  assert.equal(await f.frame.locator('#shTitle').innerText(), 'Settings');
  assert.equal(await f.frame.evaluate(() => document.activeElement.id), 'tab-memory', 'Back returns to the row you left');
  // nothing runs off the side in any category
  for (const c of CATS) {
    await f.go(c);
    const over = await f.frame.evaluate(() => { const b = document.querySelector('#sbody'); return [b.scrollWidth, b.clientWidth]; });
    assert.ok(over[0] <= over[1], `${c} overflows sideways: ${over}`);
  }
  await f.frame.locator('#shDone').click();
  assert.equal(await f.vis('#sheet'), false);
});

browserTest('Settings remembers the last category within the session, on a wide and on a narrow panel', async t => {
  const wide = await fixture(t, { width: 720 });
  await wide.opens(); await wide.frame.locator('#tab-privacy').click();
  await wide.opens(); await wide.opens(); // closed and reopened
  assert.equal(await wide.vis('#cat-privacy'), true);
  assert.equal(await wide.frame.locator('#tab-privacy').getAttribute('aria-selected'), 'true');
  const narrow = await fixture(t, { width: 300 });
  await narrow.opens(); await narrow.frame.locator('#tab-about').click();
  await narrow.frame.locator('#setBtn').click(); await narrow.opens();
  assert.equal(await narrow.vis('#cat-about'), true, 'a narrow panel reopens inside it');
  await narrow.frame.locator('#shBack').click();
  await narrow.frame.locator('#setBtn').click(); await narrow.opens();
  assert.equal(await narrow.vis('#snav'), true, 'or on the list, if you left it there');
});

browserTest('opening Settings is instant: nothing but the site-memory list is asked for until a category needs it', async t => {
  const f = await fixture(t, { width: 720 });
  const before = f.state.requests.length;
  await f.opens();
  await f.frame.locator('#sheet').waitFor();
  await f.page.waitForTimeout(200);
  assert.deepEqual([...new Set(f.state.requests.slice(before).map(r => r.path))], ['/api/site-memory']);
  await f.go('files');
  await f.frame.waitForFunction(() => /MB of/.test(document.querySelector('#fsUsed').textContent));
  assert.equal(f.reqs('/api/pdf').length, 1);
});

browserTest('every category is reachable, and every old section and control is in one', async t => {
  const f = await fixture(t, { width: 720, quota: { kind: 'tokens', used: 1200, limit: 10000, left: 8800 }, user: { passcode: false } });
  await f.opens();
  const want = {
    general: ['#modelSeg', '#webTog', '#tokSec', '#tokSeg'],
    appearance: ['#themes', '#motionSeg', '#panelSec', '#dockTog', '#panelReset'],
    memory: ['#memorySec', '#memoryForm', '#memorySite', '#memoryInstructions', '#memorySave', '#cmdSec', '#cmdForm', '#cmdList', '#cmdName', '#cmdPrompt', '#cmdStarter', '#cmdSave', '#cmdDelete'],
    actions: ['#actSec', '#actAsk', '#actSkip', '#actAvail'].filter(s => s !== '#actAvail'),
    files: ['#fsBar', '#fsManage', '#fsHist', '#fsClear', '#dsChats', '#dsMem', '#dsCmd', '#dsPdf'],
    privacy: ['#seeList', '#privSend', '#privOwner'],
    account: ['#acctName', '#outBtn', '#pwChange', '#pcSec', '#pcSet', '#acctDevice'],
    usage: ['#quotaSec', '#quotaFill', '#quotaText', '#wrapBtn'],
    about: ['#verLine', '#keysList'],
  };
  for (const c of CATS) {
    await f.go(c);
    for (const sel of want[c]) assert.equal(await f.vis(sel), true, `${c}: ${sel}`);
    assert.equal(await f.frame.locator('#spane .chead h2:visible').innerText().then(s => s.replace('&amp;', '&')), TITLES[CATS.indexOf(c)]);
  }
  assert.match(await f.frame.locator('#quotaText').innerText(), /1\.2k of 10k tokens used/);
});

browserTest('General: model, web search and answer length are saved as preferences', async t => {
  const f = await fixture(t, { width: 720 });
  await f.opens();
  assert.equal(await f.frame.locator('#modelSeg .on').innerText(), 'Haiku');
  await f.frame.locator('#modelSeg button', { hasText: 'Sonnet' }).click();
  await f.frame.waitForFunction(() => document.querySelector('#modelSeg .on')?.textContent === 'Sonnet');
  assert.deepEqual(f.reqs('/api/prefs').at(-1).body, { model: 'sonnet' });
  assert.equal(await f.frame.locator('#modelName').innerText(), 'Sonnet', 'the message box follows');
  assert.equal(await f.frame.locator('#webTog').getAttribute('aria-checked'), 'false');
  await f.frame.locator('#webTog').click();
  await f.frame.waitForFunction(() => document.querySelector('#webTog').getAttribute('aria-checked') === 'true');
  assert.deepEqual(f.reqs('/api/prefs').at(-1).body, { web: true });
  assert.equal(await f.vis('#webPill'), true, 'and so does the Web pill');
  await f.frame.locator('#tokSeg button[data-n="4096"]').click(); // (an account sees the answer lengths by name: 4k is Long)
  await f.frame.waitForFunction(() => document.querySelector('#tokSeg .on')?.textContent === 'Long');
  assert.deepEqual(f.reqs('/api/prefs').at(-1).body, { maxTokens: 4096 });
  // an account without web search sees why
  const g = await fixture(t, { width: 720, user: { allowWeb: false } });
  await g.opens();
  assert.equal(await g.frame.locator('#webTog').isDisabled(), true);
  assert.match(await g.frame.locator('#webTogNote').innerText(), /Not turned on for your account/);
});

browserTest('Appearance: theme changes persist through the prefs route, with names, previews and keyboard control', async t => {
  const f = await fixture(t, { width: 720 });
  await f.opens(); await f.go('appearance');
  assert.equal(await f.frame.locator('.themes .sw').count(), THEMES.length);
  assert.equal(await f.frame.locator('.sw .ds').first().innerText(), 'Follows your device', 'each swatch says what it is');
  const pv = await f.frame.locator('.sw[data-t=ember] .pv').evaluate(e => e.getBoundingClientRect().height);
  assert.ok(pv >= 60, `a bigger preview: ${pv}px`);
  await f.frame.locator('.sw[data-t=midnight]').click();
  assert.equal(await f.frame.evaluate(() => document.documentElement.dataset.theme), 'midnight');
  assert.deepEqual(f.reqs('/api/prefs').at(-1).body, { theme: 'midnight' });
  assert.equal(await f.frame.evaluate(() => localStorage.getItem('pb_theme')), 'midnight');
  assert.equal(await f.frame.locator('.sw[data-t=midnight]').getAttribute('aria-checked'), 'true');
  // one tab stop (the chosen swatch); arrows move between the rest; Enter picks
  assert.equal(await f.frame.locator('.sw[tabindex="0"]').count(), 1);
  await f.frame.locator('.sw[data-t=midnight]').focus();
  await f.page.keyboard.press('ArrowRight');
  assert.equal(await f.frame.evaluate(() => document.activeElement.dataset.t), 'forest');
  assert.equal(await f.frame.evaluate(() => document.documentElement.dataset.theme), 'midnight', 'moving does not pick');
  await f.page.keyboard.press('Enter');
  await f.frame.waitForFunction(() => document.documentElement.dataset.theme === 'forest');
  assert.deepEqual(f.reqs('/api/prefs').at(-1).body, { theme: 'forest' });
});

browserTest('Appearance: Animations overrides the system setting, and is remembered in this browser only', async t => {
  const f = await fixture(t, { width: 720, reduced: false });
  const dur = () => f.frame.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.cat:not([hidden])')).animationDuration));
  await f.opens(); await f.go('appearance');
  assert.equal(await f.frame.locator('#motionSeg .on').innerText(), 'System');
  assert.ok(await dur() > 0.05, 'the category fades in normally');
  await f.frame.locator('#motionSeg button', { hasText: 'Less' }).click();
  assert.equal(await f.frame.evaluate(() => localStorage.getItem('pb_motion')), 'less');
  assert.equal(await f.frame.evaluate(() => document.documentElement.classList.contains('calm')), true);
  assert.ok(await dur() < 0.001, 'Less turns the animation off');
  assert.equal(f.reqs('/api/prefs').length, 0, 'nothing is sent to the server');
  await f.frame.locator('#motionSeg button', { hasText: 'System' }).click();
  assert.equal(await f.frame.evaluate(() => localStorage.getItem('pb_motion')), null);
  // the other way: a device that asks for less motion, and Full
  const g = await fixture(t, { width: 720, reduced: true });
  await g.opens(); await g.go('appearance');
  assert.ok(await g.frame.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.cat:not([hidden])')).animationDuration)) < 0.001, 'System follows the device');
  await g.frame.locator('#motionSeg button', { hasText: 'Full' }).click();
  assert.ok(await g.frame.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.cat:not([hidden])')).animationDuration)) > 0.05, 'Full overrides it');
  // and a saved choice is on the very first frame of the next load
  const h = await fixture(t, { width: 720, reduced: false, store: { pb_motion: 'less' } });
  assert.equal(await h.frame.evaluate(() => document.documentElement.classList.contains('calm')), true);
});

browserTest('Appearance: panel layout can dock, and Reset puts the size and position back', async t => {
  const f = await fixture(t, { width: 720, store: { pb_size: '{"w":500,"h":500}', pb_pos: '{"r":100,"b":100}' } });
  await f.opens(); await f.go('appearance');
  assert.equal(await f.vis('#panelSec'), true);
  await f.frame.locator('#dockTog').click();
  assert.equal(await f.frame.locator('#dockTog').getAttribute('aria-checked'), 'true');
  assert.equal(await f.frame.evaluate(() => localStorage.getItem('pb_dock')), '1', 'it opens docked next time');
  assert.equal(await until(async () => (await f.host()).filter(r => r.type === 'dock').at(-1)?.on === true), true); // (the host's messages arrive a moment after the click)
  assert.equal(await until(() => f.frame.evaluate(() => document.body.classList.contains('docked'))), true);
  await f.frame.locator('#panelReset').click();
  assert.match(await f.frame.locator('#panelMsg').innerText(), /back in the corner/);
  assert.deepEqual(await f.frame.evaluate(() => ['pb_size', 'pb_pos', 'pb_dock', 'pb_dockw'].map(k => localStorage.getItem(k))), [null, null, null, null]);
  assert.equal(await until(async () => (await f.frame.locator('#dockTog').getAttribute('aria-checked')) === 'false'), true);
  const ready = await until(async () => { const r = (await f.host()).filter(r => r.type === 'ready').at(-1); return r?.dock === false && r.pos?.r === 16 ? r : null; });
  assert.deepEqual([ready?.pos, ready?.dock], [{ r: 16, b: 16 }, false]);
  assert.ok(ready.size.w > 0 && ready.size.h > 0, 'the host is sent a size to go back to');
  // not on /chat, where there's no panel to move; and an old bookmark can move it but not dock it
  const chat = await fixture(t, { width: 900, standalone: true });
  await chat.opens(); await chat.go('appearance');
  assert.equal(await chat.vis('#panelSec'), false);
  const old = await fixture(t, { width: 720, hostV: 3 });
  await old.opens(); await old.go('appearance');
  assert.equal(await old.vis('#panelReset'), true);
  assert.equal(await old.vis('#dockRow'), false);
});

browserTest('Memory & commands: website memory saves, and a slash command can be added and deleted', async t => {
  const f = await fixture(t, { width: 720 });
  await f.opens(); await f.go('memory');
  await f.frame.waitForFunction(() => document.querySelector('#memorySite').value === 'news.example.test');
  await f.frame.locator('#memoryInstructions').fill('Keep it brief.');
  await f.frame.locator('#memorySave').click();
  await f.frame.waitForFunction(() => /Saved for news\.example\.test/.test(document.querySelector('#memoryStatus').textContent));
  assert.deepEqual(f.reqs('/api/site-memory').find(r => r.method === 'PUT').body, { site: 'news.example.test', instructions: 'Keep it brief.' });
  await f.frame.locator('#cmdName').fill('tldr');
  await f.frame.locator('#cmdPrompt').fill('Give me a TL;DR.');
  await f.frame.locator('#cmdSave').click();
  await f.frame.waitForFunction(() => /Saved\. Type \/tldr/.test(document.querySelector('#cmdStatus').textContent));
  assert.deepEqual(f.state.commands.map(c => c.name), ['tldr']);
  await f.go('files');
  assert.match(await f.frame.locator('#dsMem').innerText(), /1 website/, 'the data summary counts them');
  assert.match(await f.frame.locator('#dsCmd').innerText(), /1 saved command/);
  await f.frame.locator('#dsCmd + *, #cat-files [data-go=memory]').first().click();
  await f.frame.locator('#cat-memory').waitFor({ state: 'visible' });
  await f.frame.locator('#cmdList').selectOption('tldr');
  await f.frame.locator('#cmdDelete').click();
  await f.frame.waitForFunction(() => /Deleted \/tldr/.test(document.querySelector('#cmdStatus').textContent));
  assert.deepEqual(f.state.commands, []);
});

browserTest('Page actions: the permission mode, and the skip warning that Esc closes before it closes Settings', async t => {
  const f = await fixture(t, { width: 720 });
  await f.opens(); await f.go('actions');
  assert.equal(await f.vis('#actAvail'), false);
  assert.equal(await f.frame.locator('#actAsk').getAttribute('aria-checked'), 'true');
  await f.frame.locator('#actSkip').click();
  assert.equal(await f.vis('#actWarn'), true);
  assert.equal(f.reqs('/api/prefs').length, 0, 'nothing is saved before the confirmation');
  await f.frame.locator('#actSkip').focus();
  await f.page.keyboard.press('Escape');
  assert.equal(await f.vis('#actWarn'), false, 'the first Esc closes the warning');
  assert.equal(await f.vis('#sheet'), true, 'and leaves Settings open');
  await f.frame.locator('#actSkip').click();
  await f.frame.locator('#actYes').click();
  await f.frame.waitForFunction(() => document.querySelector('#actSkip').getAttribute('aria-checked') === 'true');
  assert.deepEqual(f.reqs('/api/prefs').at(-1).body, { actionsAuto: true });
  await f.frame.locator('#actAsk').click();
  await f.frame.waitForFunction(() => document.querySelector('#actAsk').getAttribute('aria-checked') === 'true');
  assert.deepEqual(f.reqs('/api/prefs').at(-1).body, { actionsAuto: false });
});

browserTest('on an old bookmark Page actions is unavailable, with the reason the + menu gives', async t => {
  const f = await fixture(t, { width: 720, hostV: 8 });
  await f.frame.locator('#addBtn').click();
  const menuReason = await f.frame.locator('#actNote').innerText();
  assert.match(menuReason, /new bookmark/);
  await f.frame.locator('#setBtn').click(); // (this closes the menu)
  await f.go('actions');
  assert.equal(await f.frame.locator('#actBtn').isDisabled(), true);
  assert.equal(await f.vis('#actAvail'), true);
  assert.ok((await f.frame.locator('#actAvail').innerText()).includes(menuReason), 'the same words');
  assert.equal(await f.frame.locator('#actAvail a').getAttribute('href'), '/?update', 'with the way to fix it');
  assert.equal(await f.frame.locator('#actAsk').isDisabled(), true);
  assert.equal(await f.frame.locator('#actSkip').isDisabled(), true);
  assert.equal(await f.vis('#actWarn'), false);
  assert.doesNotMatch(await f.frame.locator('#cat-actions').innerText(), /Turn page actions on from the \+ menu/, 'no instruction to use a menu item that is greyed out');
  assert.match(await f.frame.locator('#tab-actions small').innerText(), /Not available/);
  // /chat has no page to act on
  const chat = await fixture(t, { width: 900, standalone: true });
  await chat.opens(); await chat.go('actions');
  assert.match(await chat.frame.locator('#actAvail').innerText(), /need a web page/);
  assert.equal(await chat.frame.locator('#actSkip').isDisabled(), true);
  // and a new bookmark has none of that
  const ok = await fixture(t, { width: 720 });
  await ok.opens(); await ok.go('actions');
  assert.equal(await ok.frame.locator('#actSkip').isEnabled(), true);
  assert.match(await ok.frame.locator('#actHow').innerText(), /Turn page actions on from the \+ menu/);
});

browserTest('Files & chats: PDF storage bar, Manage PDFs, history, and Remove all from history asks first', async t => {
  const pdfs = [{ id: 1, name: 'a.pdf', size: 3 * 1048576, pages: 4, createdAt: '2026-10-01T12:00:00Z', inChat: false }, { id: 2, name: 'b.pdf', size: 1048576, pages: 2, createdAt: '2026-10-02T12:00:00Z', inChat: false }];
  const f = await fixture(t, { width: 720, pdfs, chats: 3 });
  await f.opens(); await f.go('files');
  await f.frame.waitForFunction(() => /4\.0 MB of 10\.0 MB used/.test(document.querySelector('#fsUsed').textContent));
  assert.equal(await f.frame.locator('#fsBar').getAttribute('aria-valuenow'), '40');
  assert.match(await f.frame.locator('#dsPdf').innerText(), /2 PDFs stored/);
  assert.match(await f.frame.locator('#fsClearHelp').innerText(), /owner can still see them/, 'an account is told');
  // Manage PDFs opens the existing sheet
  await f.frame.locator('#fsManage').click();
  await f.frame.locator('#pdfs').waitFor({ state: 'visible' });
  assert.equal(await f.vis('#sheet'), false);
  await f.frame.locator('#pdfsDone').click();
  // history
  await f.opens();
  await f.frame.locator('#fsHist').click();
  await f.frame.locator('#hist').waitFor({ state: 'visible' });
  await f.frame.locator('#histBtn').click();
  // remove all: Cancel, then Esc, then confirm
  await f.opens();
  assert.equal(await f.vis('#cat-files'), true, 'back where it was');
  await f.frame.locator('#fsClear').click();
  assert.match(await f.frame.locator('#fsClearRow').innerText(), /Remove every chat from your history\?[\s\S]*hidden from you only. The owner of this pagebot can still see them/);
  await f.frame.locator('#fsClearRow button', { hasText: 'Cancel' }).click();
  assert.equal(f.reqs('/api/chats').filter(r => r.method === 'DELETE').length, 0, 'nothing was removed');
  await f.frame.locator('#fsClear').click();
  await f.page.keyboard.press('Escape');
  assert.equal(await f.vis('#fsClear'), true, 'Esc closes the question');
  assert.equal(await f.vis('#sheet'), true, 'and leaves Settings open');
  await f.frame.locator('#fsClear').click();
  await f.frame.locator('#fsClearRow button.bad').click();
  await f.frame.waitForFunction(() => /Removed 3 chats from your history/.test(document.querySelector('#fsMsg').textContent));
  const del = f.reqs('/api/chats').find(r => r.method === 'DELETE');
  assert.equal(del.search, '?all=1');
  assert.equal(await f.vis('#fsClear'), true, 'the row is back');
});

browserTest('the owner is told removed chats still show in /admin, and has no account or password section', async t => {
  const f = await fixture(t, { width: 720, who: 'owner' });
  await f.opens(); await f.go('files');
  assert.match(await f.frame.locator('#fsClearHelp').innerText(), /still show in Activity in \/admin/);
  await f.go('account');
  assert.equal(await f.vis('#acctOwner'), true);
  assert.equal(await f.vis('#acctName'), false, 'no account name');
  assert.equal(await f.vis('#pwSec'), false, 'no password section');
  assert.equal(await f.frame.locator('#pwChange').isVisible(), false);
  assert.equal(await f.vis('#pcSec'), false, 'the passcode is set in /admin');
  assert.equal(await f.vis('#outBtn'), true);
  assert.match(await f.frame.locator('#tab-account small').innerText(), /Owner/);
  await f.go('usage');
  assert.equal(await f.vis('#quotaSec'), false);
  assert.equal(await f.vis('#adminLink'), true);
  assert.equal(await f.frame.locator('#adminLink').getAttribute('href'), '/admin');
  assert.equal(await f.vis('#wrapBtn'), true);
  await f.go('privacy');
  assert.match(await f.frame.locator('#privOwner').innerText(), /That’s you/);
});

browserTest('Privacy lists what pagebot can see, with its state, and links to the + menu', async t => {
  const f = await fixture(t, { width: 720 });
  await f.opens(); await f.go('privacy');
  const rows = await f.frame.locator('#seeList .row').evaluateAll(els => els.map(e => [e.querySelector('.rl').textContent, e.querySelector('.chip').textContent]));
  assert.deepEqual(rows, [['Page text', 'On'], ['Highlighted text', 'Nothing selected'], ['Screenshots', 'Off'], ['PDFs', 'None attached'], ['Web search', 'Off'], ['Page actions', 'Off']]);
  assert.match(await f.frame.locator('#privOwner').innerText(), /can see your chats, including ones you remove from your history/);
  await f.frame.locator('#pageBtn').evaluate(e => e.click()); // Page text off in the + menu
  await f.frame.locator('#setBtn').click(); await f.opens();
  assert.equal(await f.frame.locator('#seeList .row', { hasText: 'Page text' }).locator('.chip').innerText(), 'Off');
  await f.frame.locator('#seeList .row', { hasText: 'Web search' }).getByRole('button', { name: /show in the \+ menu/ }).click();
  assert.equal(await f.vis('#sheet'), false, 'Settings closes');
  assert.equal(await f.vis('#addMenu'), true, 'and the + menu opens');
  assert.equal(await f.frame.evaluate(() => document.activeElement.id), 'webBtn');
  const g = await fixture(t, { width: 900, standalone: true });
  await g.opens(); await g.go('privacy');
  assert.equal(await g.frame.locator('#seeList .row', { hasText: 'Page text' }).locator('.chip').innerText(), 'No page on /chat');
});

browserTest('Account: the name, change password and passcode forms open, and Log out signs out', async t => {
  const f = await fixture(t, { width: 720 });
  await f.opens(); await f.go('account');
  assert.equal(await f.frame.locator('#acctName').innerText(), 'Signed in as Maya');
  assert.equal(await f.vis('#pcSec'), true);
  await f.frame.locator('#pwChange').click();
  assert.equal(await f.vis('#pwForm'), true);
  assert.equal(await f.vis('#pwChange'), false);
  await f.frame.locator('#pwCancel').click();
  assert.equal(await f.vis('#pwForm'), false);
  await f.frame.locator('#pcSet').click();
  assert.equal(await f.vis('#pcForm'), true);
  await f.frame.locator('#pcA').fill('12345'); await f.frame.locator('#pcB').fill('54321');
  await f.frame.locator('#pcPw').fill('secret');
  await f.frame.locator('#pcForm button[type=submit]').click();
  assert.match(await f.frame.locator('#pcMsg').innerText(), /don’t match/);
  await f.frame.locator('#pcCancel').click();
  assert.match(await f.frame.locator('#acctElse').innerText(), /Changing your password signs them all out/, 'there is no sign-out-everywhere route, so it says what does that');
  await f.frame.locator('#outBtn').click();
  await f.frame.locator('#login').waitFor({ state: 'visible' });
  assert.equal(f.reqs('/api/logout').length, 1);
});

browserTest('About: version, update strip and the keyboard shortcuts cheat sheet', async t => {
  const f = await fixture(t, { width: 720, version: 12, hostV: 7 });
  await f.opens(); await f.go('about');
  assert.match(await f.frame.locator('#verLine').innerText(), /pagebot v12.*your bookmark is v7/);
  assert.equal(await f.vis('#aboutUpd'), true);
  assert.equal(await f.frame.locator('#aboutUpd a').getAttribute('href'), '/?update');
  const keys = await f.frame.locator('#keysList').innerText();
  for (const word of ['Enter', 'Shift', 'Esc', '/', 'V', 'Paste an image or a PDF', 'slash commands', 'Move through the categories']) assert.ok(keys.includes(word), word);
  assert.ok(await f.frame.locator('#keysList kbd').count() >= 8);
  const g = await fixture(t, { width: 720, version: 11, hostV: 11 });
  await g.opens(); await g.go('about');
  assert.equal(await g.vis('#aboutUpd'), false, 'an up-to-date bookmark has no update strip');
});

browserTest('Usage keeps the quota block as it was, and hides it when there is no limit', async t => {
  const f = await fixture(t, { width: 720, quota: { kind: 'usd', used: 0.4, limit: 1, left: 0.6 } });
  await f.opens(); await f.go('usage');
  assert.equal(await f.frame.locator('#quotaSec #quotaFill').evaluate(e => e.style.width), '40%');
  assert.match(await f.frame.locator('#quotaText').innerText(), /\$0\.40 of \$1\.00 used/);
  assert.match(await f.frame.locator('#quotaSub').innerText(), /resets at midnight/);
  assert.equal(await f.frame.locator('#quotaSec').evaluate(e => e.parentElement.id), 'cat-usage', 'it lives in the Usage category');
  const g = await fixture(t, { width: 720 });
  await g.opens(); await g.go('usage');
  assert.equal(await g.vis('#quotaSec'), false);
  assert.equal(await g.vis('#wrapBtn'), true, 'Wrapped is here too');
});

browserTest('keyboard: arrows move through the categories, Esc closes a confirmation, then Settings, then the panel', async t => {
  const f = await fixture(t, { width: 720 });
  await f.opens();
  assert.equal(await f.frame.evaluate(() => document.activeElement.id), 'tab-general', 'focus lands on the list');
  await f.page.keyboard.press('ArrowDown');
  assert.equal(await f.frame.evaluate(() => document.activeElement.id), 'tab-appearance');
  assert.equal(await f.vis('#cat-appearance'), true, 'a wide panel shows each category as you land on it');
  await f.page.keyboard.press('End');
  assert.equal(await f.frame.evaluate(() => document.activeElement.id), 'tab-about');
  await f.page.keyboard.press('ArrowDown');
  assert.equal(await f.frame.evaluate(() => document.activeElement.id), 'tab-general', 'it wraps');
  await f.page.keyboard.press('ArrowUp');
  assert.equal(await f.frame.evaluate(() => document.activeElement.id), 'tab-about');
  assert.equal(await f.frame.locator('#stabs [tabindex="0"]').count(), 1, 'one tab stop');
  await f.page.keyboard.press('Home');
  await f.page.keyboard.press('Tab');
  assert.ok(await f.frame.evaluate(() => document.activeElement.closest('#cat-general') !== null || document.activeElement.id === 'cat-general'), 'Tab goes on into the category');
  // Esc layering
  await f.go('files');
  await f.frame.locator('#fsClear').click();
  await f.page.keyboard.press('Escape');
  assert.equal(await f.vis('#sheet'), true, 'a confirmation closes first');
  await f.page.keyboard.press('Escape');
  assert.equal(await f.vis('#sheet'), false, 'then Settings');
  assert.equal((await f.host()).filter(r => r.type === 'close').length, 0, 'the panel stays');
  await f.page.keyboard.press('Escape');
  await f.page.waitForFunction(() => window.hostRequests.some(r => r.type === 'close'));
  assert.equal((await f.host()).filter(r => r.type === 'close').length, 1, 'then the panel');
  // narrow: arrows only move the highlight; Enter opens
  const n = await fixture(t, { width: 300 });
  await n.opens();
  await n.page.keyboard.press('ArrowDown');
  assert.equal(await n.frame.evaluate(() => document.activeElement.id), 'tab-appearance');
  assert.equal(await n.vis('#spane'), false, 'a narrow list waits for Enter');
  await n.page.keyboard.press('Enter');
  assert.equal(await n.vis('#cat-appearance'), true);
});

for (const theme of ['glass', 'clear']) browserTest(`${theme}: the sheet has a backing and hides the chat behind it, wide and narrow`, async t => {
  for (const width of [720, 300]) {
    const f = await fixture(t, { width, theme });
    await f.frame.locator('#q').fill('something behind the sheet');
    await f.opens();
    await f.frame.waitForFunction(() => ['#log', '#composer'].every(s => getComputedStyle(document.querySelector(s)).visibility === 'hidden'));
    const alpha = await f.frame.evaluate(() => { const m = getComputedStyle(document.querySelector('#sheet')).backgroundColor.match(/[\d.]+/g); return m.length > 3 ? +m[3] : 1; });
    assert.ok(alpha >= 0.8, `${theme} ${width}: the sheet is nearly opaque (${alpha})`);
    const cards = await f.frame.evaluate(() => { const c = document.querySelector('#cat-general .card'); return c ? getComputedStyle(c).backgroundColor : null; });
    assert.ok(cards, 'cards render');
    await f.frame.locator('#setBtn').click();
    await f.frame.waitForFunction(() => getComputedStyle(document.querySelector('#log')).visibility === 'visible', null, { timeout: 3000 });
  }
});

browserTest('every theme draws Settings with readable text (WCAG 4.5), and nothing spills at 300px', async t => {
  const f = await fixture(t, { width: 300 });
  await f.opens(); await f.frame.locator('#tab-general').click();
  const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  const bad = [];
  for (const theme of THEMES.filter(x => x !== 'glass' && x !== 'clear')) {
    const probe = await f.frame.evaluate(async theme2 => {
      document.documentElement.dataset.theme = theme2 === 'auto' ? 'ember' : theme2;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))); // let the colours settle
      const rgb = s => (s.match(/[\d.]+/g) || []).map(Number);
      const over = (top, bottom) => { const a = top[3] ?? 1; return [0, 1, 2].map(i => Math.round(top[i] * a + bottom[i] * (1 - a))); };
      const cs = s => getComputedStyle(document.querySelector(s));
      const sheet = rgb(cs('#sheet').backgroundColor);
      const result = {};
      // text on the sheet, on a card, and the selected button of a segmented control
      result.nav = [rgb(cs('#tab-appearance').color), over(rgb(cs('#tab-appearance').backgroundColor), sheet)];
      const card = over(rgb(cs('#cat-general .card').backgroundColor), sheet);
      result.help = [rgb(cs('#cat-general .rh').color), card];
      result.label = [rgb(cs('#cat-general .rl').color), card];
      result.seg = [rgb(cs('#modelSeg .on').color), over(rgb(cs('#modelSeg .on').backgroundColor), card)];
      return result;
    }, theme);
    for (const [what, [fg, bg]] of Object.entries(probe)) { const r = ratio(fg.slice(0, 3), bg.slice(0, 3)); if (r < 4.5) bad.push(`${theme} ${what}: ${r.toFixed(2)}`); }
  }
  assert.deepEqual(bad, []);
  // glass and clear are checked for their backing above; here every theme at 300px has no sideways scroll in any category
  for (const theme of THEMES) {
    await f.frame.evaluate(x => { document.documentElement.dataset.theme = x === 'auto' ? 'ember' : x; }, theme);
    for (const c of ['appearance', 'memory', 'privacy']) {
      await f.go(c);
      const over = await f.frame.evaluate(() => { const b = document.querySelector('#sbody'); return b.scrollWidth - b.clientWidth; });
      assert.ok(over <= 0, `${theme} ${c} spills ${over}px`);
    }
  }
});

browserTest('/chat at full width: two panes in a centred column, and Done returns to the chat', async t => {
  const f = await fixture(t, { width: 1440, height: 900, standalone: true });
  await f.opens();
  const g = await f.frame.evaluate(() => { const r = s => document.querySelector(s).getBoundingClientRect(); return { sheet: r('#sheet'), inner: r('.sin'), pane: r('#spane'), nav: r('#snav') }; });
  assert.equal(Math.round(g.sheet.width), 1440);
  assert.equal(Math.round(g.inner.width), 900);
  assert.ok(g.pane.width <= 600 && g.nav.right <= g.pane.left);
  assert.equal(await f.vis('#snav'), true);
  await f.frame.locator('#shDone').click();
  assert.equal(await f.vis('#sheet'), false);
  assert.equal(await f.frame.evaluate(() => document.activeElement.id), 'q', 'the keyboard goes back to the message box');
});

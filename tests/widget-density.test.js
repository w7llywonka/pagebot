import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// Settings > Appearance > Density (Comfortable or Compact) with Playwright and a local Chromium. Every HTTP response is a fixture.
// The panel is an iframe of the width being tested inside a host page (or /chat for the full-page one).
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
const THEMES = ['auto', 'ember', 'paper', 'midnight', 'forest', 'dusk', 'sakura', 'terminal', 'pond', 'orbit', 'void', 'arcade', 'glass', 'clear'];
const CONCRETE = THEMES.filter(t => t !== 'auto'); // Auto is Ember or Paper, whichever the device prefers; it has no look of its own
const done = { t: 'done', conversationId: 42, model: 'haiku', usage: { in: 50, out: 20 }, stop: 'end_turn' };
const ANSWER = '## The two plans\n\nHere is how they compare:\n\n| Plan | Price | Seats |\n|---|---:|---:|\n| Starter | $5 | 1 |\n| Team | $20 | 10 |\n\nWhat you get:\n\n- Fast answers on any page\n- A **shared** history\n- Works with `Haiku` and Sonnet\n\n```js\nconst plan = pick(\'team\');\nconsole.log(plan.price, "a long line to make the block scroll sideways instead of wrapping");\n```\n\n> A quote, for good measure.\n\nIf you want the Team plan, say so.';

// width: the panel's width; standalone: /chat in a window that wide; density: what is saved; extraBoot: lock screen, ban notice
async function fixture(t, { width = 720, height = 760, standalone = false, density, theme = 'ember', boot: extraBoot = {}, store = {}, query = '' } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: standalone ? { width, height } : { width: width + 40, height: height + 40 } });
  context.setDefaultTimeout(5000);
  const state = { errors: [], prefs: { theme, model: 'haiku', web: false, actions: false } };
  t.after(async () => { await context.close(); assert.deepEqual(state.errors, [], 'no browser errors or unexpected requests'); });
  await context.addInitScript(([items, d]) => {
    localStorage.setItem('pb_token', 'test-session');
    for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
    if (d && !location.search.includes('density')) localStorage.setItem('pb_density', d);
    // what the page looked like at the earliest moments: when <body> appeared, and at DOMContentLoaded
    window.__dense = {};
    new MutationObserver((_, o) => { if (document.body) { window.__dense.atBody = document.documentElement.classList.contains('dense'); o.disconnect(); } }).observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => { window.__dense.dcl = document.documentElement.classList.contains('dense'); });
  }, [store, density]);
  const hostPage = `<!doctype html><html><body style="margin:0"><iframe title="Pagebot" src="${ORIGIN}/widget?v=12" style="width:${width}px;height:${height}px;border:0"></iframe>
    <script>addEventListener('message', e => { if (e.data.type === 'page') e.source.postMessage({ id: e.data.id, page: { url: 'https://news.example.test/a', title: 'A', text: 'x' }, selection: '' }, e.origin); });</script></body></html>`;
  const boot = () => ({
    version: 12, authed: true, who: 'user', theme: state.prefs.theme, lockMinutes: 0, lock: 'password', passwordSet: true, accounts: { on: true, signup: false },
    user: { id: 1, name: 'Maya', status: 'trusted', allowWeb: true, allowSonnet: true, allowActions: true, passcode: false },
    prefs: state.prefs, limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 }, models: [{ key: 'haiku', label: 'Haiku' }, { key: 'sonnet', label: 'Sonnet' }],
    commands: [], commandLimits: { maxCommands: 50, maxPrompt: 2000, maxStarters: 3, reserved: [] }, ...extraBoot,
  });
  const chats = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, title: ['Summarise this article', 'Why is the sky blue?', 'A rather long title that has to be cut off by the row'][i % 3], site: 'news.example.test', updatedAt: new Date(Date.now() - i * 8e6).toISOString(), snippet: null }));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const json = v => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) });
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: hostPage });
    if (url.pathname === '/widget' || url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    if (url.pathname === '/api/boot') return json(boot());
    if (url.pathname === '/api/prefs') { Object.assign(state.prefs, request.postDataJSON()); return json({ prefs: state.prefs, limits: boot().limits }); }
    if (url.pathname === '/api/logout' || url.pathname === '/api/ping') return json({ ok: true });
    if (url.pathname === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
    if (url.pathname === '/api/commands') return json({ commands: [] });
    if (url.pathname === '/api/pdf') return json({ used: 0, cap: 10485760, pdfs: [] });
    if (url.pathname === '/api/chats' && method === 'GET') return json({ chats, next: null });
    if (url.pathname === '/api/wrapped') return json({ year: 2026, questions: 482, days: 61, sites: [{ site: 'github.com', n: 120 }, { site: 'news.example.test', n: 80 }], hours: Array.from({ length: 24 }, (_, h) => (h * 7) % 13), models: [{ label: 'Haiku', n: 300 }, { label: 'Sonnet', n: 182 }], theme, themeIsCurrent: true, streak: { days: 9, start: '2026-03-01', stop: '2026-03-09' } });
    if (url.pathname === '/api/chat') return route.fulfill({ contentType: 'application/x-ndjson', body: [{ t: 'd', v: ANSWER }, done].map(e => JSON.stringify(e)).join('\n') + '\n' });
    state.errors.push(`Unexpected request: ${method} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  const open = async () => {
    await page.goto(standalone ? ORIGIN + '/chat' + query : 'https://news.example.test/article');
    const frame = standalone ? page.mainFrame() : page.frames().find(f => f.url().startsWith(ORIGIN));
    await frame.locator('#boot').waitFor({ state: 'detached' });
    return frame;
  };
  let frame = await open();
  const reload = async () => { frame = await open(); return frame; };
  const f = {
    page, state, reload, get frame() { return frame; },
    dense: () => frame.evaluate(() => document.documentElement.classList.contains('dense')),
    saved: () => frame.evaluate(() => localStorage.getItem('pb_density')),
    // one question and its answer, so there are two messages (and a table, code block and list) to measure
    ask: async () => { await frame.locator('#q').fill('Compare the plans.'); await frame.locator('#sendBtn').click(); await frame.locator('.msg.bot .meta').waitFor(); },
    metrics: () => frame.evaluate(() => {
      const r = s => document.querySelector(s).getBoundingClientRect(), msgs = [...document.querySelectorAll('#log .msg')], cs = e => getComputedStyle(e);
      const user = msgs.find(m => m.classList.contains('user')), bot = msgs.find(m => m.classList.contains('bot'));
      return { header: r('header').height, composer: r('#composer').height, font: parseFloat(cs(bot).fontSize), root: parseFloat(cs(document.documentElement).fontSize), gap: bot.getBoundingClientRect().top - user.getBoundingClientRect().bottom,
        botPadY: parseFloat(cs(bot).paddingTop), line: parseFloat(cs(bot).lineHeight), answer: bot.getBoundingClientRect().height, code: parseFloat(cs(bot.querySelector('pre code')).fontSize), cell: parseFloat(cs(bot.querySelector('td')).paddingTop) };
    }),
    opens: () => frame.locator('#setBtn').click(),
    go: async name => { if (await frame.locator('#shBack').isVisible()) await frame.locator('#shBack').click(); await frame.locator('#tab-' + name).click(); await frame.locator('#cat-' + name).waitFor({ state: 'visible' }); },
  };
  return f;
}

// no horizontal scrolling anywhere inside the panel, and nothing sticking out of its right edge
const OVERFLOW = () => {
  const out = [], W = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > W) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${W}`);
  for (const sel of ['#log', '#composer', '#sheet', '.sbody', '#hist', '#histList', '#login', '#ban', '#wrap', '.wslide']) {
    const e = document.querySelector(sel);
    if (e && e.getClientRects().length && e.scrollWidth > e.clientWidth + 1) out.push(`${sel} scrolls sideways: ${e.scrollWidth} > ${e.clientWidth}`);
  }
  for (const e of document.querySelectorAll('header button, #composer button, #composer .pill, .msg, .acard, #sheet .card, #sheet .seg, #sheet .stab, .hrow, .pad button, #login input, #ban p')) {
    if (!e.getClientRects().length) continue;
    const r = e.getBoundingClientRect(); if (r.width && (r.right > W + 1 || r.left < -1)) out.push(`${e.tagName}.${e.className} sticks out: ${Math.round(r.left)}..${Math.round(r.right)} of ${W}`);
  }
  return out;
};
const CONTRAST = `(() => {
  const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = c => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); return [...cv.getImageData(0, 0, 1, 1).data]; };
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const over = (top, under) => { const a = top[3] / 255; return [0, 1, 2].map(i => Math.round(top[i] * a + under[i] * (1 - a))).concat(255); };
  const bgOf = el => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3]) layers.push(c); if (c[3] === 255) break; } return layers.reduceRight((under, c) => over(c, under), [255, 255, 255, 255]); };
  window.__contrast = el => ratio(over(rgba(getComputedStyle(el).color), bgOf(el)), bgOf(el));
})()`;

browserTest('the default is Comfortable: no class on <html>, nothing saved, and Settings shows it chosen', async t => {
  const f = await fixture(t);
  assert.equal(await f.dense(), false);
  assert.equal(await f.saved(), null);
  assert.equal(await f.frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--hd').trim()), '52px', 'today’s header, unchanged');
  await f.opens(); await f.go('appearance');
  assert.deepEqual(await f.frame.locator('#densitySeg button').allInnerTexts(), ['Comfortable', 'Compact']);
  assert.equal(await f.frame.locator('#densitySeg .on').innerText(), 'Comfortable');
  assert.equal(await f.frame.locator('#densitySeg').getAttribute('role'), 'radiogroup');
  assert.deepEqual(await f.frame.locator('#densitySeg button').evaluateAll(bs => bs.map(b => [b.getAttribute('role'), b.getAttribute('aria-checked')])), [['radio', 'true'], ['radio', 'false']]);
  assert.equal(await f.frame.locator('#denLbl').innerText(), 'Density');
  assert.match(await f.frame.locator('#denLbl').locator('xpath=following-sibling::span').innerText(), /Compact fits more on screen/, 'one line of help');
  assert.equal(await f.frame.locator('#densitySeg').evaluate(e => e.classList.contains('seg') && e.parentElement.parentElement.classList.contains('row')), true, 'the same control as Animations');
  assert.equal(await f.frame.locator('#motionSeg').count(), 1, 'the rest of Appearance is untouched');
  assert.match(widget, /name: 'new'/, 'sanity: the slash registry is in this file');
  assert.doesNotMatch(widget, /name: 'density'/, 'no slash command for it');
});

browserTest('choosing Compact in Settings applies at once, is saved, and is still there after a reload; Comfortable puts it back', async t => {
  const f = await fixture(t);
  await f.ask();
  const before = await f.metrics();
  await f.opens(); await f.go('appearance');
  await f.frame.locator('#densitySeg button', { hasText: 'Compact' }).click();
  assert.equal(await f.dense(), true, 'applied immediately, no reload');
  assert.equal(await f.saved(), 'compact');
  assert.equal(await f.frame.locator('#densitySeg .on').innerText(), 'Compact');
  assert.equal(await f.frame.locator('#densitySeg .on').getAttribute('aria-checked'), 'true');
  assert.ok((await f.frame.evaluate(() => document.querySelector('header').getBoundingClientRect().height)) < before.header, 'the header got shorter on the spot');
  await f.frame.locator('#shDone').first().click().catch(() => {});
  await f.reload();
  assert.equal(await f.dense(), true, 'still compact after a reload');
  await f.opens(); await f.go('appearance');
  assert.equal(await f.frame.locator('#densitySeg .on').innerText(), 'Compact');
  await f.frame.locator('#densitySeg button', { hasText: 'Comfortable' }).click();
  assert.equal(await f.dense(), false);
  assert.equal(await f.saved(), null, 'Comfortable is just the default again');
  await f.reload();
  assert.equal(await f.dense(), false);
});

browserTest('Compact is on before the first paint: the class is on <html> when <body> appears and at DOMContentLoaded', async t => {
  for (const standalone of [false, true]) {
    const f = await fixture(t, { standalone, density: 'compact' });
    assert.deepEqual(await f.frame.evaluate(() => window.__dense), { atBody: true, dcl: true }, standalone ? '/chat' : 'in the panel');
    const c = await fixture(t, { standalone });
    assert.deepEqual(await c.frame.evaluate(() => window.__dense), { atBody: false, dcl: false }, 'and not when it isn’t chosen');
  }
});

browserTest('?density=compact (for tests and debugging) turns it on and is saved like the setting; junk values and a broken localStorage do nothing', async t => {
  const f = await fixture(t, { standalone: true, query: '?density=compact' });
  assert.equal(await f.dense(), true);
  assert.equal(await f.saved(), 'compact');
  const g = await fixture(t, { standalone: true, query: '?density=huge' });
  assert.equal(await g.dense(), false);
  assert.equal(await g.saved(), null);
  // storage that throws (a private window, blocked site data): the panel still opens and is Comfortable
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 800, height: 700 } });
  t.after(() => context.close());
  await context.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    if (url.pathname === '/api/boot') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 12, authed: false, lock: 'password', passwordSet: true, theme: 'ember', accounts: { on: false } }) });
    return route.fulfill({ status: 404, body: '' });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/chat');
  await page.locator('#login').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dense')), false);
});

browserTest('Compact is measurably tighter at 300, 420 and 720px wide and in /chat at 1440: message gap, bubble padding, line height, base font, header and composer', async t => {
  for (const [width, standalone] of [[300, false], [420, false], [720, false], [1440, true]]) {
    const a = await fixture(t, { width, standalone }), b = await fixture(t, { width, standalone, density: 'compact' });
    await a.ask(); await b.ask();
    const [x, y] = [await a.metrics(), await b.metrics()], at = `${width}px${standalone ? ' /chat' : ''}`;
    assert.equal(await a.dense(), false); assert.equal(await b.dense(), true);
    assert.ok(y.gap < x.gap, `${at}: gap between messages ${y.gap} < ${x.gap}`);
    assert.ok(y.botPadY < x.botPadY, `${at}: bubble padding ${y.botPadY} < ${x.botPadY}`);
    assert.ok(y.line < x.line, `${at}: line height ${y.line} < ${x.line}`);
    assert.ok(y.font < x.font, `${at}: message font ${y.font} < ${x.font}`);
    assert.ok(y.root < x.root, `${at}: base font ${y.root} < ${x.root}`);
    assert.ok(y.font >= 12, `${at}: still readable: ${y.font}`);
    assert.ok(y.header < x.header, `${at}: header ${y.header} < ${x.header}`);
    assert.ok(y.composer < x.composer, `${at}: composer ${y.composer} < ${x.composer}`);
    assert.ok(y.answer < x.answer * .95, `${at}: the whole answer is shorter: ${y.answer} vs ${x.answer}`);
    assert.ok(y.code < x.code, `${at}: code ${y.code} < ${x.code}`);
    assert.ok(y.cell < x.cell, `${at}: table cells ${y.cell} < ${x.cell}`);
  }
});

browserTest('the big reading column keeps its width in Compact', async t => {
  const a = await fixture(t, { width: 1440, standalone: true }), b = await fixture(t, { width: 1440, standalone: true, density: 'compact' });
  await a.ask(); await b.ask();
  const col = f => f.frame.evaluate(() => { const r = document.querySelector('.msg.bot').getBoundingClientRect(), c = document.querySelector('#composer .box').getBoundingClientRect(); return { bot: Math.round(r.width), left: Math.round(r.left), box: Math.round(c.width) }; });
  const [x, y] = [await col(a), await col(b)];
  assert.ok(Math.abs(x.bot - y.bot) <= 1 && Math.abs(x.left - y.left) <= 1, `the answer column: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
  assert.ok(Math.abs(x.box - y.box) <= 28, `the message box: ${x.box} vs ${y.box}`);
});

browserTest('nothing overflows sideways at 300px and 420px in Compact: the chat, the menu, Settings (every category), history, Wrapped, the lock screen and the ban notice', async t => {
  for (const width of [300, 420]) {
    const f = await fixture(t, { width, density: 'compact' });
    await f.ask();
    await f.frame.locator('#log').evaluate(e => { e.scrollTop = 0; });
    assert.deepEqual(await f.frame.evaluate(OVERFLOW), [], `${width}: chat`);
    assert.ok(await f.frame.evaluate(() => document.querySelector('.msg.bot .tw').scrollWidth > 0));
    await f.frame.locator('#addBtn').first().click();
    assert.deepEqual(await f.frame.evaluate(OVERFLOW), [], `${width}: + menu`);
    await f.page.keyboard.press('Escape');
    await f.opens();
    for (const cat of ['general', 'appearance', 'memory', 'actions', 'files', 'privacy', 'account', 'usage', 'about']) {
      await f.go(cat);
      assert.deepEqual(await f.frame.evaluate(OVERFLOW), [], `${width}: settings > ${cat}`);
    }
    await f.go('usage');
    await f.frame.locator('#wrapBtn').click();
    await f.frame.locator('.wslide').waitFor();
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await f.frame.evaluate(OVERFLOW), [], `${width}: wrapped slide ${i}`);
      await f.frame.locator('#wrap').click({ position: { x: width - 20, y: 200 } });
    }
    await f.reload();
    await f.frame.locator('#histBtn').click();
    await f.frame.locator('.hrow').first().waitFor();
    assert.deepEqual(await f.frame.evaluate(OVERFLOW), [], `${width}: history`);
    // the screens that replace the chat
    const lock = await fixture(t, { width, density: 'compact', boot: { authed: false, user: undefined } });
    await lock.frame.locator('#login').waitFor({ state: 'visible' });
    assert.deepEqual(await lock.frame.evaluate(OVERFLOW), [], `${width}: lock screen`);
    const ban = await fixture(t, { width, density: 'compact', boot: { ban: { id: 7, key: 'k', state: 'active', hours: 24, endsAt: new Date(Date.now() + 864e5).toISOString(), at: new Date().toISOString(), name: 'Maya', reason: 'Spam, and a longer line of explanation that has to wrap', note: 'Please read the rules.', appeal: null } } });
    await ban.frame.locator('#ban').waitFor({ state: 'visible' });
    assert.deepEqual(await ban.frame.evaluate(OVERFLOW), [], `${width}: ban notice`);
  }
});

browserTest('all 14 themes in Compact: nothing overflows or is cut off at 300px and 720px, and the message box stays inside the panel', async t => {
  for (const width of [300, 720]) {
    const f = await fixture(t, { width, density: 'compact' });
    await f.ask();
    await f.frame.waitForTimeout(600); // the answer's entrance animation has to finish before anything is measured
    for (const theme of CONCRETE) {
      await f.frame.evaluate(n => { document.documentElement.dataset.theme = n; }, theme);
      const r = await f.frame.evaluate(() => {
        const b = document.querySelector('#composer').getBoundingClientRect(), box = document.querySelector('#composer .box').getBoundingClientRect(), H = innerHeight;
        const last = [...document.querySelectorAll('#log .msg')].pop().getBoundingClientRect(), log = document.querySelector('#log').getBoundingClientRect();
        return { composerBottom: b.bottom, H, boxBottom: box.bottom, hdr: document.querySelector('header').getBoundingClientRect().height, lastInLog: last.bottom <= log.bottom + 1 || document.querySelector('#log').scrollHeight > document.querySelector('#log').clientHeight };
      });
      assert.ok(r.composerBottom <= r.H + 0.5 && r.boxBottom <= r.H, `${theme} ${width}: the message box is on screen`);
      assert.ok(r.hdr >= 40 && r.hdr <= 46, `${theme} ${width}: header ${r.hdr}`);
      assert.ok(r.lastInLog, `${theme} ${width}: the log holds its messages`);
      assert.deepEqual(await f.frame.evaluate(OVERFLOW), [], `${theme} ${width}`);
    }
    await f.opens();
    for (const theme of CONCRETE) {
      await f.frame.evaluate(n => { document.documentElement.dataset.theme = n; }, theme);
      assert.deepEqual(await f.frame.evaluate(OVERFLOW), [], `${theme} ${width}: settings`);
    }
  }
});

browserTest('Auto in Compact is just Ember or Paper: it lays out the same way', async t => {
  const f = await fixture(t, { width: 300, density: 'compact', theme: 'auto' });
  await f.ask();
  await f.frame.waitForTimeout(600);
  assert.deepEqual(await f.frame.evaluate(OVERFLOW), []);
  assert.ok(await f.frame.evaluate(() => document.querySelector('#composer').getBoundingClientRect().bottom <= innerHeight));
});

browserTest('buttons never get smaller in Compact: the toolbar and header buttons keep their height (32px and up from 560px wide), and Settings buttons stay as tall as they were', async t => {
  const SEL = '#composer .tb, header .ib, #composer .go';
  for (const width of [300, 420, 720]) {
    const a = await fixture(t, { width }), b = await fixture(t, { width, density: 'compact' });
    const heights = async f => f.frame.evaluate(sel => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length).map(e => [e.id || e.className, Math.round(e.getBoundingClientRect().height * 10) / 10]), SEL);
    const [x, y] = [await heights(a), await heights(b)];
    assert.ok(y.length > 4, 'found the buttons');
    assert.deepEqual(y, x, `${width}: same buttons, same heights`);
    if (width >= 560) for (const [name, h] of y) assert.ok(h >= 32, `${width}: ${name} is ${h}px tall`);
    for (const f of [a, b]) { await f.opens(); await f.go('appearance'); }
    const sheet = async f => f.frame.evaluate(() => [...document.querySelectorAll('#cat-appearance .seg button, #cat-appearance .ghost, #sheet .sh .ghost')].filter(e => e.getClientRects().length).map(e => Math.round(e.getBoundingClientRect().height)));
    const [p, q] = [await sheet(a), await sheet(b)];
    assert.ok(q.length >= 7, 'found Settings buttons');
    assert.ok(q.every(h => h >= 30), `${width}: ${q}`);
    assert.deepEqual(q, p, `${width}: Settings buttons keep their heights`);
  }
});

browserTest('text contrast does not change in Compact (WCAG 4.5 or better where it is measurable): ember, paper, midnight and pond, plus glass and clear colours are untouched', async t => {
  const a = await fixture(t, { width: 720 }), b = await fixture(t, { width: 720, density: 'compact' });
  for (const f of [a, b]) { await f.ask(); await f.frame.evaluate(CONTRAST); }
  const SEL = [['bot text', '.msg.bot .body p'], ['user text', '.msg.user .body'], ['link', '.msg.bot .body a'], ['meta', '.msg.bot .meta'], ['code', '.msg.bot pre code'], ['table head', '.msg.bot th'], ['table cell', '.msg.bot td'],
    ['quote', '.msg.bot blockquote'], ['heading', '.msg.bot .h'], ['message box', '#q'], ['header title', 'header .name']];
  const read = (f, theme) => f.frame.evaluate(([theme, sel]) => { return Object.fromEntries(sel.map(([k, s]) => [k, document.querySelector(s) ? window.__contrast(document.querySelector(s)) : null])); }, [theme, SEL]);
  const colors = (f, theme) => f.frame.evaluate(([theme, sel]) => { const out = {}; for (const [k, s] of sel) { const e = document.querySelector(s); if (e) { const c = getComputedStyle(e); out[k] = [c.color, c.backgroundColor, c.textShadow]; } } return out; }, [theme, SEL]);
  for (const theme of ['ember', 'paper', 'midnight', 'pond', 'glass', 'clear']) {
    for (const f of [a, b]) { await f.frame.evaluate(n => { document.documentElement.dataset.theme = n; }, theme); await f.frame.waitForTimeout(450); } // colours ease between themes
    assert.deepEqual(await colors(b, theme), await colors(a, theme), `${theme}: colours are exactly the same`);
    if (['glass', 'clear'].includes(theme)) continue; // over a see-through panel the page decides; the colours being identical is the point
    const [x, y] = [await read(a, theme), await read(b, theme)];
    for (const [k, v] of Object.entries(y)) {
      if (v == null) continue;
      assert.ok(Math.abs(v - x[k]) < 0.01, `${theme}: ${k} ${v} vs ${x[k]}`);
      assert.ok(v >= 4.5, `${theme}: ${k} has contrast ${v?.toFixed(2)}`);
    }
  }
});

browserTest('Compact works in /chat and the pop-up window too, and an old panel without the setting reads nothing it shouldn’t', async t => {
  const f = await fixture(t, { width: 1000, standalone: true });
  await f.ask();
  const x = await f.metrics();
  await f.opens(); await f.go('appearance');
  await f.frame.locator('#densitySeg button', { hasText: 'Compact' }).click();
  assert.equal(await f.dense(), true);
  assert.equal(await f.frame.evaluate(() => getComputedStyle(document.body).getPropertyValue('--hd').trim()), '46px', '/chat has its own header height; Compact trims it');
  await f.frame.locator('#shDone').first().click().catch(() => {});
  assert.ok((await f.metrics()).gap < x.gap);
  await f.reload();
  assert.equal(await f.dense(), true, 'saved for /chat');
  const popup = await fixture(t, { width: 700, standalone: true, query: '?popup=1', density: 'compact' });
  assert.equal(await popup.dense(), true, 'the pop-up window');
});

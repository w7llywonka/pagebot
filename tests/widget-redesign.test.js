import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// Workspace navigation, finishes, responsive panel sizing, and fast static loading.
// Like widget.test.js: Playwright and a local Chromium, every HTTP response a fixture, no server or database.
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
const browserTest = chromium ? test : test.skip;
const widget = await readFile(new URL('../public/widget.html', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const bookmarkletSource = await readFile(new URL('../bookmarklet.js', import.meta.url), 'utf8');
const ORIGIN = 'https://pagebot.example.test';
const NEW_THEMES = ['pond', 'orbit', 'void', 'arcade'];
let browser;
before(async () => {
  if (chromium) browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); });

const boot = {
  authed: true, who: 'user', theme: 'ember', lockMinutes: 0,
  user: { id: 1, name: 'Test reader', status: 'trusted', allowWeb: true, passcode: false },
  prefs: { theme: 'ember', model: 'haiku', web: false },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku' }],
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const RICH = [
  '## A heading\n\nSome **bold** text with a [link](https://example.com/x) and `code`.\n\n- one\n- two\n\n',
  '| Theme | Mood |\n|:---|:---:|\n| Pond | cave |\n| Orbit | night |\n\n> A quote\n\n```js\nconst a = 1;\n```\n\nThe end.',
];
const answer = [{ t: 'd', v: RICH.join('') }, { t: 'done', conversationId: 42, model: 'haiku', usage: { in: 50, out: 20 }, stop: 'end_turn' }];

// Opens the widget the way people meet it: inside a host page (the real bookmarklet makes the iframe), or on /chat.
// bookmark: the bookmarklet's VERSION (the panel's ?v=), so 11 is a new bookmark and 8 an old one.
async function fixture(t, { standalone = false, theme = 'ember', viewport = { width: 1440, height: 900 }, reduced = false, bookmark = 11, store = {},
  screen, bootGate, chatGate, bootExtra = {}, boxed } = {}) {
  const context = await browser.newContext({ reducedMotion: reduced ? 'reduce' : 'no-preference', viewport, ...(screen && { screen }) });
  context.setDefaultTimeout(5000);
  const state = { requests: [], errors: [], prefs: [], hostRequests: [] };
  t.after(async () => { await context.close(); assert.deepEqual(state.errors, [], 'no browser errors or unexpected requests'); });
  await context.addInitScript(([items]) => {
    localStorage.setItem('pb_token', 'test-session');
    for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
  }, [store]);
  const hostPage = `<!doctype html><html><body style="margin:0"><p>Host page text.</p>
    <script>
      window.hostRequests = [];
      addEventListener('message', event => {
        const f = document.getElementById('__pagebot');
        if (!f || event.source !== f.contentWindow) return;
        window.hostRequests.push(event.data);
        if (event.data.type === 'page') event.source.postMessage({ id: event.data.id, page: { url: 'https://news.example.test/a', title: 'A', text: 'Page text' }, selection: '' }, event.origin);
      });
    </script>${boxed ? `<iframe id="__pagebot" title="Pagebot" src="${ORIGIN}/widget?v=${bookmark}" style="position:fixed;right:0;bottom:0;width:${boxed.w}px;height:${boxed.h}px;border:0"></iframe>` : ''}
    </body></html>`;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: hostPage });
    if (url.pathname === '/widget' || url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    state.requests.push({ path: url.pathname, method: request.method(), body: request.postDataJSON?.() });
    if (url.pathname === '/api/boot') {
      if (bootGate) await bootGate.promise;
      return json({ ...boot, theme, prefs: { ...boot.prefs, theme }, version: 11, ...bootExtra });
    }
    if (url.pathname === '/api/prefs') { const body = request.postDataJSON(); state.prefs.push(body); return json({ prefs: { ...boot.prefs, ...body }, limits: boot.limits }); }
    if (url.pathname === '/api/ping' || url.pathname === '/api/logout') return json({ ok: true });
    if (url.pathname === '/api/chats') return json({ chats: [{ id: 1, title: 'First chat', site: 'news.example.test', updatedAt: new Date().toISOString() }, { id: 2, title: 'Second chat', site: 'news.example.test', updatedAt: new Date().toISOString() }], next: null });
    if (url.pathname === '/api/chat') {
      if (chatGate) await chatGate.promise;
      return route.fulfill({ contentType: 'application/x-ndjson', body: answer.map(e => JSON.stringify(e)).join('\n') + '\n' });
    }
    if (url.pathname === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
    if (url.pathname === '/api/commands') return json({ commands: [] });
    if (url.pathname === '/api/pdf') return json({ used: 0, cap: 10 * 1048576, pdfs: [] });
    state.errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.location().url || '')) state.errors.push('console: ' + m.text()); });
  let frame;
  if (standalone) { await page.goto(ORIGIN + '/chat'); frame = page.mainFrame(); }
  else {
    await page.goto('https://news.example.test/a');
    if (!boxed) { // the real bookmarklet, as the homepage serves it
      await page.evaluate(bookmarkletSource.replaceAll('__ORIGIN__', ORIGIN).replaceAll('__VERSION__', String(bookmark)).replace(/\n\s*/g, ''));
      await page.waitForSelector('#__pagebot', { state: 'attached' });
    }
    for (let i = 0; i < 50 && !frame; i++) { frame = page.frames().find(f => f.url().startsWith(ORIGIN + '/widget')); if (!frame) await page.waitForTimeout(50); }
    assert.ok(frame, 'the widget frame loaded');
  }
  // two frames, then any CSS transitions still running (a theme switch fades colours over .15s; measuring mid-fade reads the wrong theme)
  const settle = () => frame.evaluate(async () => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.all(document.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {})));
  });
  const ready = async () => {
    await frame.locator('#boot').waitFor({ state: 'detached' });
    await frame.locator('#q').waitFor({ state: 'visible' });
    // The fast widget boot may finish before its host iframe's size transition does.
    if (!standalone) await page.evaluate(async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const iframe = document.getElementById('__pagebot');
      await Promise.all(iframe.getAnimations().map(a => a.finished.catch(() => {})));
    });
    await settle();
  };
  const iframeBox = () => page.evaluate(() => { const f = document.getElementById('__pagebot'); const r = f.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: innerWidth - Math.round(r.right), bottom: innerHeight - Math.round(r.bottom) }; });
  return { context, page, frame, state, settle, ready, iframeBox };
}

// WCAG contrast, in the page: any CSS colour is read through a canvas, and see-through backgrounds are blended down the ancestors
const CONTRAST = `(() => {
  const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = c => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); return [...cv.getImageData(0, 0, 1, 1).data]; };
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const over = (top, under) => { const a = top[3] / 255; return [0, 1, 2].map(i => Math.round(top[i] * a + under[i] * (1 - a))).concat(255); };
  const bgOf = el => { // what is really behind the text: the background colours down the chain, blended
    const layers = [];
    for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3]) layers.push(c); if (c[3] === 255) break; }
    return layers.reduceRight((under, c) => over(c, under), [255, 255, 255, 255]);
  };
  const colorOf = el => over(rgba(getComputedStyle(el).color), bgOf(el));
  window.__contrast = { rgba, ratio, over, bgOf, colorOf, of: el => ratio(colorOf(el), bgOf(el)) };
})()`;

browserTest('the theme lists agree: the server accepts every theme the panel offers, and the four new ones are among them', () => {
  const panel = [...widget.slice(widget.indexOf('const THEMES = ['), widget.indexOf('const light = matchMedia')).matchAll(/^\s*\['([a-z]+)'/gm)].map(m => m[1]);
  const theirs = /const THEMES = \[([^\]]+)\]/.exec(server)[1].split(',').map(s => s.trim().replace(/'/g, ''));
  assert.deepEqual(panel, theirs);
  for (const name of NEW_THEMES) assert.ok(panel.includes(name), name);
  assert.equal(new Set(panel).size, panel.length);
});

browserTest('each new theme is in the picker, applies to the panel, is saved as a preference, and is there again on reload', async t => {
  const f = await fixture(t);
  await f.ready();
  await f.frame.locator('#setBtn').click();
  await f.frame.locator('#tab-appearance').click(); // the picker is in Settings > Appearance
  assert.equal(await f.frame.locator('.themes .sw').count(), 14);
  await f.frame.locator('.more-themes summary').click();
  for (const name of NEW_THEMES) {
    await f.frame.locator(`.sw[data-t=${name}]`).click();
    assert.equal(await f.frame.evaluate(() => document.documentElement.dataset.theme), name);
    assert.equal(await f.frame.evaluate(() => localStorage.getItem('pb_theme')), name);
    assert.deepEqual(f.state.prefs.at(-1), { theme: name });
    assert.equal(await f.frame.locator(`.sw[data-t=${name}]`).getAttribute('class'), 'sw on');
  }
  // the first frame after a reload already has the theme, before the server has answered
  const gate = deferred();
  const g = await fixture(t, { store: { pb_theme: 'orbit' }, bootGate: gate, theme: 'orbit' });
  assert.equal(await g.frame.evaluate(() => document.documentElement.dataset.theme), 'orbit');
  gate.resolve();
  await g.ready();
  assert.equal(await g.frame.evaluate(() => document.documentElement.dataset.theme), 'orbit');
  assert.equal(await g.frame.locator('.sw[data-t=orbit]').count(), 1);
});

browserTest('Settings keeps its sections and exposes curated finishes with accurate previews', async t => {
  const f = await fixture(t);
  await f.ready();
  await f.frame.locator('#setBtn').click();
  // the sections moved into categories (see tests/widget-settings.test.js); every one of the old ones is still there
  const headings = await f.frame.locator('#sheet h3').evaluateAll(els => els.map(e => e.textContent.toLowerCase()));
  for (const old of ['today’s limit', 'notes for websites', 'your / commands', 'answer length', 'passcode']) assert.ok(headings.includes(old), old);
  assert.deepEqual(await f.frame.locator('#stabs [role=tab] b').allInnerTexts(), ['Answers', 'Look & feel', 'Site notes & shortcuts', 'Clicking for you', 'Your chats & files', 'Privacy', 'Account', 'Your usage', 'Help & shortcuts']);
  await f.frame.locator('#tab-appearance').click();
  await f.frame.locator('.more-themes summary').click();
  const names = await f.frame.locator('.themes .sw .nm').allInnerTexts();
  assert.deepEqual(names, ['Auto', 'Cocoa', 'Cream', 'Tide', 'Forest', 'Plum', 'Blossom', 'Terminal', 'Pond', 'Blueprint', 'Olive', 'Arcade', 'Glass', 'Clear']);
  // a swatch carries its theme's colours, like the older ones
  assert.equal(await f.frame.locator('.sw[data-t=pond]').evaluate(e => e.style.getPropertyValue('--sw-acc')), '#8ddcc2');
  assert.equal(await f.frame.locator('.sw[data-t=void]').evaluate(e => e.style.getPropertyValue('--sw-acc')), '#d8dc96');
});

browserTest('every solid finish has readable text: the palette pairs and the real components, all at WCAG 4.5 or better', async t => {
  const f = await fixture(t);
  await f.ready();
  await f.frame.evaluate(CONTRAST);
  // a conversation with a heading, link, code block and table, then a few components added by hand
  await f.frame.locator('#q').fill('Summarize this page.');
  await f.frame.locator('#sendBtn').click();
  await f.frame.locator('.msg.bot .meta').waitFor();
  await f.frame.evaluate(() => {
    const body = document.querySelector('.msg.bot .body');
    body.insertAdjacentHTML('beforeend', '<div class="acard nav"><div class="aq"><span>🖱</span><span>Click “Pay”</span></div><div class="aw">Leaves this page</div><div class="ad">https://example.com</div><div class="ab"><button class="aok">Allow</button><button>Skip</button></div></div>' +
      '<div class="fchip"><span class="fn">paper.pdf</span><span class="fpg">12 pages</span></div><span class="cite">1</span><div class="src"><span>Sources</span><a href="#">example.com</a></div>');
    const drop = document.querySelector('#drop'); drop.hidden = false; drop.style.animation = 'none';
  });
  const checks = (name) => f.frame.evaluate(({ name }) => {
    const C = window.__contrast, q = s => document.querySelector(s), out = {};
    const v = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const col = n => C.rgba(v(n));
    const flat = (a, b) => C.ratio(C.over(col(a), col(b)), col(b)); // a text colour over a background colour
    out['text / bg'] = C.ratio(col('--text'), col('--bg'));
    out['text / panel'] = C.ratio(col('--text'), col('--panel'));
    out['text / user'] = C.ratio(col('--text'), col('--user'));
    out['text / code'] = C.ratio(col('--text'), col('--code'));
    out['text / chip-on'] = C.ratio(col('--text'), col('--chip-on'));
    out['muted / bg'] = C.ratio(col('--muted'), col('--bg'));
    out['muted / panel'] = C.ratio(col('--muted'), col('--panel'));
    out['muted / chip-on'] = C.ratio(col('--muted'), col('--chip-on'));
    out['accent / bg'] = C.ratio(col('--accent'), col('--bg'));
    out['accent / panel'] = C.ratio(col('--accent'), col('--panel'));
    out['on-accent / accent'] = C.ratio(col('--on-accent'), col('--accent'));
    out['err / bg'] = C.ratio(col('--err'), col('--bg'));
    out['err / panel'] = C.ratio(col('--err'), col('--panel'));
    out['warn / panel'] = C.ratio(col('--warn'), col('--panel'));
    // Wrapped's big numbers sit on the accent's glow over the background; the ban notice's kicker is --err on the background
    out['accent / wrapped glow'] = C.ratio(col('--accent'), C.over([...col('--accent').slice(0, 3), 56], col('--bg')));
    for (const [label, sel] of [['bot text', '.msg.bot .body p'], ['user text', '.msg.user .body'], ['link', '.msg.bot .body a'], ['meta', '.msg.bot .meta'], ['code', '.msg.bot pre code'],
      ['table head', '.msg.bot th'], ['table cell', '.msg.bot td'], ['quote', '.msg.bot blockquote'], ['heading', '.msg.bot .h'], ['approval card', '.acard .aq'], ['approval note', '.acard .ad'],
      ['approval warning', '.acard .aw'], ['approve button', '.acard .aok'], ['pdf chip', '.fchip .fn'], ['citation', '.cite'], ['source link', '.src a'], ['pdf drop', '#drop b'], ['drop hint', '#drop span'],
      ['message box', '#q'], ['send button', '#sendBtn'], ['model button', '#modelBtn'], ['page pill', '#pagePill'], ['header title', 'header .name']]) {
      const e = q(sel); if (e) out[label] = C.of(e); else out[label] = NaN;
    }
    return out;
  }, { name });
  const failures = [];
  for (const name of ['ember', 'paper', 'midnight', 'forest', 'dusk', 'sakura', 'terminal', ...NEW_THEMES]) {
    await f.frame.evaluate(n => { document.documentElement.dataset.theme = n; }, name);
    await f.settle();
    const r = await checks(name);
    for (const [label, ratio] of Object.entries(r)) {
      if (!(ratio >= 4.5)) failures.push(`${name}: ${label} has contrast ${ratio?.toFixed?.(2)}, needs 4.5`);
    }
  }
  assert.deepEqual(failures, []);
});

browserTest('solid finishes have no decorative texture layers; transparent modes retain their behavior', async t => {
  const f = await fixture(t); await f.ready();
  for (const name of ['ember', 'paper', 'midnight', 'forest', 'dusk', 'sakura', ...NEW_THEMES]) {
    const result = await f.frame.evaluate(n => {
      document.documentElement.dataset.theme = n;
      const body = getComputedStyle(document.body);
      return { before: getComputedStyle(document.body, '::before').content, after: getComputedStyle(document.body, '::after').content, image: body.backgroundImage };
    }, name);
    assert.equal(result.before, 'none', name); assert.equal(result.after, 'none', name); assert.equal(result.image, 'none', name);
  }
  for (const theme of ['glass', 'clear']) {
    const r = await f.frame.evaluate(n => { document.documentElement.dataset.theme = n; return getComputedStyle(document.body).backgroundColor; }, theme);
    assert.match(r, /^rgba/, `${theme} still has a transparent background`);
  }
});

browserTest('the static loading mark yields on boot, uses no animation loop, and does not block input', async t => {
  const gate = deferred(), f = await fixture(t, { bootGate: gate });
  const canvas = f.frame.locator('#bootPbl');
  assert.equal(await canvas.isVisible(), false);
  assert.equal(await canvas.getAttribute('data-frames'), null);
  const mark = await f.frame.locator('#boot .orb').evaluate(e => {
    const s = getComputedStyle(e, '::before'); return { content: s.content, animation: s.animationName };
  });
  assert.equal(mark.content, '""'); assert.equal(mark.animation, 'none');
  gate.resolve(); await f.ready();
  await f.frame.locator('#q').fill('hello');
  assert.equal(await f.frame.locator('#q').inputValue(), 'hello');
  assert.equal(await f.frame.evaluate(() => { const r = document.querySelector('#q').getBoundingClientRect(); return document.elementFromPoint(r.x+20,r.y+10)?.id; }), 'q');
});

browserTest('the Thinking bubble is plain dots, not the loader, and never blocks the message box', async t => {
  const chatGate = deferred();
  const f = await fixture(t, { chatGate });
  await f.ready();
  await f.frame.locator('#q').fill('Summarize this page.');
  await f.frame.locator('#sendBtn').click();
  await f.frame.locator('.msg.bot .typing').waitFor({ state: 'visible' });
  assert.equal(await f.frame.locator('.msg.bot canvas').count(), 0, 'no pet in the answer bubble');
  assert.equal(await f.frame.locator('#sendBtn').isDisabled(), false);
  await f.frame.locator('#q').fill('next question');
  assert.equal(await f.frame.locator('#q').inputValue(), 'next question');
  chatGate.resolve();
  await f.frame.locator('.msg.bot .meta').waitFor();
  assert.equal(await f.frame.locator('.msg.bot .typing').count(), 0, 'the dots go when the words arrive');
});

browserTest('a slow boot cannot keep the splash up; reduced motion also schedules no canvas frames', async t => {
  const gate = deferred(), f = await fixture(t, { reduced: true, bootGate: gate });
  const canvas = f.frame.locator('#bootPbl');
  assert.equal(await canvas.getAttribute('data-frames'), null);
  assert.equal(await canvas.isVisible(), false);
  await f.frame.locator('#boot').waitFor({ state: 'detached', timeout: 1800 });
  gate.resolve(); await f.ready();
});

browserTest('theme keyboard navigation reaches additional finishes and restores a saved legacy finish', async t => {
  const f = await fixture(t); await f.ready();
  await f.frame.locator('#setBtn').click(); await f.frame.locator('#tab-appearance').click();
  await f.frame.locator('.sw[data-t=sakura]').focus();
  await f.page.keyboard.press('ArrowRight');
  assert.equal(await f.frame.evaluate(() => document.activeElement.dataset.t), 'terminal');
  assert.equal(await f.frame.locator('.more-themes').getAttribute('open'), '');
  await f.page.keyboard.press('Enter');
  assert.equal(await f.frame.evaluate(() => document.documentElement.dataset.theme), 'terminal');
  const g = await fixture(t, { store: { pb_theme: 'orbit' }, theme: 'orbit' }); await g.ready();
  await g.frame.locator('#setBtn').click(); await g.frame.locator('#tab-appearance').click();
  assert.equal(await g.frame.locator('.sw[data-t=orbit]').isVisible(), true);
  assert.equal(await g.frame.locator('.sw[data-t=orbit]').getAttribute('aria-checked'), 'true');
});

browserTest('the big layout switches on with the panel: a centred reading column and bigger type at half-screen, a comfortable composer when narrow', async t => {
  const wide = await fixture(t, { boxed: { w: 1400, h: 800 }, viewport: { width: 1440, height: 900 } });
  await wide.ready();
  await wide.frame.locator('#q').fill('Summarize this page.');
  await wide.frame.locator('#sendBtn').click();
  await wide.frame.locator('.msg.bot .meta').waitFor();
  await wide.settle();
  const w = await wide.frame.evaluate(() => {
    const px = (s, p) => parseFloat(getComputedStyle(document.querySelector(s))[p]);
    const bot = document.querySelector('.msg.bot').getBoundingClientRect(), log = document.querySelector('#log').getBoundingClientRect(), box = document.querySelector('.box').getBoundingClientRect();
    return { gutter: px('#log', 'paddingLeft'), msgFont: px('.msg.bot', 'fontSize'), botWidth: Math.round(bot.width), botLeft: Math.round(bot.left - log.left), boxWidth: Math.round(box.width), boxLeft: Math.round(box.left),
      hd: px('header', 'height'), qFont: px('#q', 'fontSize'), qMin: px('#q', 'minHeight'), botMax: getComputedStyle(document.querySelector('.msg.bot')).maxWidth };
  });
  const narrow = await fixture(t, { boxed: { w: 380, h: 560 }, viewport: { width: 1440, height: 900 } });
  await narrow.ready();
  await narrow.frame.locator('#q').fill('Summarize this page.');
  await narrow.frame.locator('#sendBtn').click();
  await narrow.frame.locator('.msg.bot .meta').waitFor();
  await narrow.settle();
  const n = await narrow.frame.evaluate(() => {
    const px = (s, p) => parseFloat(getComputedStyle(document.querySelector(s))[p]);
    const bot = document.querySelector('.msg.bot').getBoundingClientRect(), log = document.querySelector('#log').getBoundingClientRect(), box = document.querySelector('.box').getBoundingClientRect();
    return { gutter: px('#log', 'paddingLeft'), msgFont: px('.msg.bot', 'fontSize'), botWidth: Math.round(bot.width), botLeft: Math.round(bot.left - log.left), boxWidth: Math.round(box.width), boxLeft: Math.round(box.left),
      hd: px('header', 'height'), qFont: px('#q', 'fontSize'), qMin: px('#q', 'minHeight') };
  });
  // wide: the column is at most 760 and centred, the type is bigger, the box is as wide as the column
  assert.equal(w.botMax, 'min(100%, 760px)', 'answers are at most 760px wide');
  assert.ok(w.botWidth <= 760, `reading column ${w.botWidth}`);
  assert.ok(Math.abs(w.gutter - 320) <= 1 && Math.abs(w.botLeft - w.gutter) <= 1, `the column is centred: ${w.gutter} / ${w.botLeft}`);
  assert.ok(w.msgFont >= 16, `type ${w.msgFont}`);
  assert.ok(w.boxWidth <= 788 && w.boxWidth > 700 && Math.abs(w.boxLeft - (1400 - w.boxWidth) / 2) <= 2, `message box ${w.boxWidth} at ${w.boxLeft}`);
  assert.equal(w.hd, 52);
  assert.ok(w.qMin >= 52);
  // narrow: exactly what it always was (14px type, 12px of side space, the box the full width less its padding, 46px header)
  assert.equal(n.msgFont, 14);
  assert.ok(n.gutter >= 12 && n.gutter < 13, `side space ${n.gutter}`);
  assert.equal(n.hd, 46);
  assert.ok(n.qMin >= 52, 'the narrow composer leaves comfortable room for input');
  assert.ok(n.boxWidth >= 355 && n.boxWidth <= 360, `box ${n.boxWidth}`);
  assert.ok(n.botWidth <= 356);
});

browserTest('history cards use two columns when there is room and one when narrow; the slash list runs one command per line when wide', async t => {
  const wide = await fixture(t, { boxed: { w: 900, h: 700 } });
  await wide.ready();
  await wide.frame.locator('#histBtn').click();
  await wide.frame.locator('.hrow').nth(1).waitFor();
  const cols = await wide.frame.evaluate(() => { const a = document.querySelectorAll('.hrow'); return [a[0].getBoundingClientRect().top === a[1].getBoundingClientRect().top, getComputedStyle(document.querySelector('#histList')).display]; });
  assert.deepEqual(cols, [true, 'grid'], 'two cards side by side');
  await wide.frame.locator('#histBtn').click();
  await wide.frame.locator('#q').fill('/');
  await wide.frame.locator('#slashMenu button').first().waitFor();
  const row = await wide.frame.evaluate(() => { const b = document.querySelector('#slashMenu .sl button'); return [getComputedStyle(b.querySelector('.mt')).display, b.getBoundingClientRect().height < 44]; });
  assert.deepEqual(row, ['flex', true]);
  const narrow = await fixture(t, { boxed: { w: 380, h: 560 } });
  await narrow.ready();
  await narrow.frame.locator('#histBtn').click();
  await narrow.frame.locator('.hrow').nth(1).waitFor();
  const stacked = await narrow.frame.evaluate(() => { const a = document.querySelectorAll('.hrow'); return [a[0].getBoundingClientRect().top < a[1].getBoundingClientRect().top, getComputedStyle(document.querySelector('#histList')).display]; });
  assert.deepEqual(stacked, [true, 'block']);
});

browserTest('/chat uses the whole window with the reading column in the middle, and Settings keeps a centred column of its own', async t => {
  const f = await fixture(t, { standalone: true, viewport: { width: 1440, height: 900 } });
  await f.ready();
  await f.frame.locator('#q').fill('Summarize.');
  await f.frame.locator('#sendBtn').click();
  await f.frame.locator('.msg.bot .meta').waitFor();
  const m = await f.frame.evaluate(() => { const b = document.querySelector('.msg.bot').getBoundingClientRect(); return { body: document.body.getBoundingClientRect().width, left: Math.round(b.left), width: Math.round(b.width) }; });
  assert.equal(m.body, 1440);
  assert.ok(m.width <= 760 && m.left === 444, JSON.stringify(m)); // 208px rail + (1440 - 208 - 760) / 2
  await f.frame.locator('#setBtn').click();
  // the sheet fills the window like history does; its two panes sit in a centred column of at most 900px
  const sheet = await f.frame.evaluate(() => { const r = document.querySelector('#sheet').getBoundingClientRect(), c = document.querySelector('.sin').getBoundingClientRect(); return [Math.round(r.width), Math.round(c.width), Math.round(c.left)]; });
  assert.deepEqual(sheet, [1232, 900, 374], 'Settings uses a centred 900px column beside the workspace rail');
});

// ---- the panel's size: the real bookmarklet in a host page; the panel is the iframe it makes ----
const hostReady = f => f.page.evaluate(() => window.hostRequests.find(r => r.type === 'ready'));

browserTest('a new bookmark opens the panel at about half the window and the panel does not override it', async t => {
  const f = await fixture(t, { viewport: { width: 1440, height: 900 } });
  await f.ready();
  assert.deepEqual(await f.iframeBox(), { w: 720, h: 720, right: 16, bottom: 16 });
  const ready = await hostReady(f);
  assert.equal(ready.size, undefined, 'a v11 bookmark has worked its own size out; the panel sends none when nothing is saved');
  assert.equal(ready.dw, undefined);
  assert.equal(await f.frame.evaluate(() => innerWidth), 720);
  const small = await fixture(t, { viewport: { width: 1024, height: 700 } });
  await small.ready();
  assert.deepEqual(await small.iframeBox(), { w: 512, h: 560, right: 16, bottom: 16 });
  const phone = await fixture(t, { viewport: { width: 390, height: 780 } });
  await phone.ready();
  const box = await phone.iframeBox();
  assert.deepEqual([box.w, box.h], [358, 624]);
});

browserTest('a size saved on this site wins over the default, for a new bookmark and for an old one', async t => {
  const store = { pb_size: JSON.stringify({ w: 450, h: 600 }) };
  const a = await fixture(t, { viewport: { width: 1440, height: 900 }, store });
  await a.ready();
  assert.equal((await hostReady(a)).size.w, 450);
  assert.deepEqual([(await a.iframeBox()).w, (await a.iframeBox()).h], [450, 600]);
  const b = await fixture(t, { viewport: { width: 1440, height: 900 }, store, bookmark: 8, screen: { width: 1920, height: 1080 } });
  await b.ready();
  assert.deepEqual([(await b.iframeBox()).w, (await b.iframeBox()).h], [450, 600], 'a v8 bookmark gets the saved size too, not the screen-sized one');
});

browserTest('an old bookmark gets a bigger panel too: the panel sends a size worked out from the screen, only when none is saved', async t => {
  const f = await fixture(t, { viewport: { width: 1440, height: 900 }, bookmark: 8, screen: { width: 1600, height: 1000 } });
  await f.ready();
  const ready = await hostReady(f);
  assert.deepEqual(ready.size, { w: 800, h: 720 }); // 50% of the screen's width, 72% of its height (the browser's own bars take the rest)
  assert.equal(ready.dw, 640);
  assert.deepEqual([(await f.iframeBox()).w, (await f.iframeBox()).h], [800, 720]);
  // the panel never fights a resize afterwards: it said its piece once, on ready
  const count = await f.page.evaluate(() => window.hostRequests.filter(r => r.type === 'ready').length);
  assert.equal(count, 1, 'sent once, at start');
  // a bookmark that is too old to take a size message at all still opens at the new size (v6 can't resize, but it takes the size on ready)
  const g = await fixture(t, { viewport: { width: 1440, height: 900 }, bookmark: 6, screen: { width: 1600, height: 1000 } });
  await g.ready();
  assert.deepEqual([(await g.iframeBox()).w, (await g.iframeBox()).h], [800, 720]);
  // clamped to the window when the screen is bigger than the window
  const h = await fixture(t, { viewport: { width: 700, height: 600 }, bookmark: 8, screen: { width: 2560, height: 1440 } });
  await h.ready();
  assert.deepEqual([(await h.iframeBox()).w, (await h.iframeBox()).h], [668, 568]);
});

browserTest('the docked sidebar defaults to about 40% of the window, and a saved width wins', async t => {
  const f = await fixture(t, { viewport: { width: 1440, height: 900 }, store: { pb_dock: '1' } });
  await f.ready();
  const box = await f.iframeBox();
  assert.equal(box.w, 576);
  assert.equal(box.h, 900);
  const g = await fixture(t, { viewport: { width: 1440, height: 900 }, store: { pb_dock: '1', pb_dockw: '500' } });
  await g.ready();
  assert.equal((await g.iframeBox()).w, 500);
  const old = await fixture(t, { viewport: { width: 1440, height: 900 }, bookmark: 9, store: { pb_dock: '1' }, screen: { width: 1600, height: 1000 } });
  await old.ready();
  assert.equal((await old.iframeBox()).w, 640);
  // floating it again keeps the half-window size
  await f.frame.locator('#dockBtn').click();
  await f.page.waitForTimeout(450);
  assert.deepEqual([(await f.iframeBox()).w, (await f.iframeBox()).h], [720, 720]);
});

browserTest('an old bookmark still gets its update strip, with the new layout and loader', async t => {
  const f = await fixture(t, { bookmark: 8, viewport: { width: 1440, height: 900 }, screen: { width: 1600, height: 1000 } });
  await f.ready();
  assert.equal(await f.frame.locator('#upd').isVisible(), true);
  assert.equal(await f.frame.locator('#updGo').getAttribute('href'), '/?update');
  assert.equal(await f.frame.evaluate(() => getComputedStyle(document.querySelector('#composer')).maxWidth), '788px');
});

browserTest('the pending-approval screen shows the loader instead of the hourglass, and the check mark once you are in', async t => {
  const f = await fixture(t, { bootExtra: { user: { ...boot.user, status: 'pending' } } });
  await f.frame.locator('#wait').waitFor({ state: 'visible' });
  const canvas = f.frame.locator('#waitPbl');
  await canvas.waitFor({ state: 'visible' });
  assert.equal(await canvas.getAttribute('data-anim'), 'on');
  assert.equal(await f.frame.locator('.hg').isVisible(), false);
  await f.frame.evaluate(() => document.querySelector('#wait').classList.add('in')); // what the panel does the moment you're accepted
  await f.frame.locator('.hg').waitFor({ state: 'visible' }); // it pops in
  assert.equal(await f.frame.locator('.wl').isVisible(), false);
});

browserTest('the workspace navigation opens existing features and task starters send useful prompts', async t => {
  const f = await fixture(t, { standalone: true, reduced: true }); await f.ready();
  assert.equal(await f.frame.locator('#workspaceNav').isVisible(), true);
  await f.frame.locator('#workspaceHistory').click();
  assert.equal(await f.frame.locator('#hist').isVisible(), true);
  await f.frame.locator('#workspaceSettings').click();
  assert.equal(await f.frame.locator('#sheet').isVisible(), true);
  assert.equal(await f.frame.locator('#hist').isVisible(), false);
  await f.frame.locator('#workspaceFiles').click();
  assert.equal(await f.frame.locator('#pdfs').isVisible(), true);
  await f.frame.locator('#workspaceNew').click();
  assert.equal(await f.frame.locator('#pdfs').isVisible(), false);
  for (const [label, part] of [['Explain something', 'how much I already know'], ['Help me choose', 'what matters most'], ['Help me write', 'who it’s for']]) {
    await f.frame.locator('.starters button').filter({ has: f.frame.locator('.starter-name', { hasText: label }) }).click();
    await f.frame.locator('.msg.bot .meta').waitFor();
    const req = f.state.requests.filter(r => r.path === '/api/chat').at(-1);
    assert.ok(JSON.stringify(req.body).includes(part));
    await f.frame.locator('#workspaceNew').click();
    assert.equal(await f.frame.locator('.msg').count(), 0);
  }
  await f.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await f.frame.locator('#workspaceNav').isVisible(), false);
  assert.equal(await f.frame.locator('#setBtn').isVisible(), true);
});

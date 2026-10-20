import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// The redesign: new themes, the half-screen panel's layout and sizes, and the pixel loader.
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
  const ready = async () => { await frame.locator('#boot').waitFor({ state: 'detached' }); await frame.locator('#q').waitFor({ state: 'visible' }); await settle(); };
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

browserTest('Settings keeps its sections and its picker; only the swatches are new', async t => {
  const f = await fixture(t);
  await f.ready();
  await f.frame.locator('#setBtn').click();
  // the sections moved into categories (see tests/widget-settings.test.js); every one of the old ones is still there
  const headings = await f.frame.locator('#sheet h3').evaluateAll(els => els.map(e => e.textContent.toLowerCase()));
  for (const old of ['usage today', 'website memory', 'slash commands', 'answer length', 'quick unlock']) assert.ok(headings.includes(old), old);
  assert.deepEqual(await f.frame.locator('#stabs [role=tab] b').allInnerTexts(), ['General', 'Appearance', 'Memory & commands', 'Page actions', 'Files & chats', 'Privacy', 'Account', 'Usage', 'About']);
  await f.frame.locator('#tab-appearance').click();
  const names = await f.frame.locator('.themes .sw .nm').allInnerTexts();
  assert.deepEqual(names, ['Auto', 'Ember', 'Paper', 'Midnight', 'Forest', 'Dusk', 'Sakura', 'Terminal', 'Pond', 'Orbit', 'Void', 'Arcade', 'Glass', 'Clear']);
  // a swatch carries its theme's colours, like the older ones
  assert.equal(await f.frame.locator('.sw[data-t=pond]').evaluate(e => e.style.getPropertyValue('--sw-acc')), '#4fd6b8');
  assert.equal(await f.frame.locator('.sw[data-t=void]').evaluate(e => e.style.getPropertyValue('--sw-acc')), '#f6a05a');
});

browserTest('every new theme has readable text: the palette pairs and the real components, all at WCAG 4.5 or better', async t => {
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
  for (const name of NEW_THEMES) {
    await f.frame.evaluate(n => { document.documentElement.dataset.theme = n; }, name);
    await f.settle();
    const r = await checks(name);
    for (const [label, ratio] of Object.entries(r)) {
      assert.ok(ratio >= 4.5, `${name}: ${label} has contrast ${ratio?.toFixed?.(2)}, needs 4.5`);
    }
  }
});

browserTest('the new themes draw a static dither texture and leave glass and clear alone', async t => {
  const f = await fixture(t);
  await f.ready();
  const pseudo = (theme) => f.frame.evaluate(n => {
    document.documentElement.dataset.theme = n;
    const b = getComputedStyle(document.body), before = getComputedStyle(document.body, '::before'), after = getComputedStyle(document.body, '::after');
    return { iso: b.isolation, before: before.content, after: after.content, beforeAnim: before.animationName, afterAnim: after.animationName, pos: after.position, events: after.pointerEvents };
  }, theme);
  for (const name of NEW_THEMES) {
    const r = await pseudo(name);
    assert.equal(r.iso, 'isolate', name);
    assert.equal(r.before, '""', name);
    assert.equal(r.after, '""', name);
    assert.equal(r.beforeAnim, 'none', `${name}: the texture must not animate`);
    assert.equal(r.afterAnim, 'none', `${name}: the texture must not animate`);
    assert.equal(r.pos, 'fixed');
    assert.equal(r.events, 'none');
  }
  for (const name of ['ember', 'paper', 'clear']) {
    const r = await pseudo(name);
    assert.equal(r.iso, 'auto', name);
    assert.equal(r.after, 'none', name);
  }
  const glass = await pseudo('glass'); // glass has its own sheen layer on ::before and nothing else
  assert.equal(glass.iso, 'auto');
  assert.equal(glass.after, 'none');
});

browserTest('the pixel loader plays on the splash, never blocks, and is gone with it', async t => {
  const gate = deferred();
  const f = await fixture(t, { bootGate: gate });
  const canvas = f.frame.locator('#bootPbl');
  await canvas.waitFor({ state: 'visible' });
  assert.equal(await canvas.getAttribute('data-anim'), 'on');
  assert.equal(await canvas.getAttribute('aria-hidden'), 'true');
  const size = await canvas.evaluate(c => [c.width, c.height, c.getBoundingClientRect().width > 100]);
  assert.ok(size[0] >= 60 && size[1] >= 60 && size[2], 'a real, sizeable canvas');
  // it paints something: the animal and strings are not transparent
  assert.ok(await canvas.evaluate(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++; return n > 200; }));
  // the panda dangles from three strings: they start at the top edge of the canvas, and the red panda's fur is on it
  assert.ok(await canvas.evaluate(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, 1).data; let runs = 0, on = false; for (let i = 3; i < d.length; i += 4) { const o = d[i] > 150; if (o && !on) runs++; on = o; } return runs >= 3; }), 'three strings come down from the top');
  assert.ok(await canvas.evaluate(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255 && d[i] === 217 && d[i + 1] === 85 && d[i + 2] === 43) return true; return false; }), 'it is the red panda');
  const frames = Number(await canvas.getAttribute('data-frames'));
  await f.page.waitForTimeout(500);
  assert.ok(Number(await canvas.getAttribute('data-frames')) > frames + 2, 'it animates while the splash is up');
  // the splash waits on the network at most a couple of seconds, and the panel behind it is not covered afterwards
  gate.resolve();
  await f.frame.locator('#boot').waitFor({ state: 'detached' });
  assert.equal(await f.frame.locator('#bootPbl').count(), 0);
  await f.frame.locator('#q').fill('hello');
  assert.equal(await f.frame.locator('#q').inputValue(), 'hello');
  const hit = await f.frame.evaluate(() => { const r = document.querySelector('#q').getBoundingClientRect(); return document.elementFromPoint(r.x + 20, r.y + 10)?.id; });
  assert.equal(hit, 'q', 'nothing from the splash sits over the message box');
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

browserTest('with reduced motion the loader draws one still frame and never runs a loop', async t => {
  const gate = deferred(), chatGate = deferred();
  const f = await fixture(t, { reduced: true, bootGate: gate, chatGate });
  const canvas = f.frame.locator('#bootPbl');
  await canvas.waitFor({ state: 'visible' });
  assert.equal(await canvas.getAttribute('data-anim'), 'off');
  assert.equal(await canvas.getAttribute('data-frames'), null, 'no animation frames were ever scheduled');
  assert.ok(await canvas.evaluate(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++; return n > 200; }), 'the still frame is drawn');
  gate.resolve();
  chatGate.resolve();
});

browserTest('the panda keeps its own colours on every theme; only the void behind it follows the theme', async t => {
  const f = await fixture(t, { bootGate: deferred() });
  const canvas = f.frame.locator('#bootPbl');
  await canvas.waitFor({ state: 'visible' });
  const has = rgb => canvas.evaluate((c, rgb) => { // is a colour drawn, exactly
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255 && `${d[i]},${d[i + 1]},${d[i + 2]}` === rgb) return true;
    return false;
  }, rgb);
  const dither = () => canvas.evaluate(c => { // the void's dots: translucent, in the theme's text colour
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 20 && d[i + 3] < 80) return `${d[i]},${d[i + 1]},${d[i + 2]}`;
    return '';
  });
  assert.equal(await has('217,85,43'), true); // the red panda's fur, #d9552b
  const ember = await dither();
  assert.ok(ember);
  await f.frame.evaluate(() => document.querySelector('.sw[data-t=paper]').click()); // the picker's own code path
  await f.page.waitForTimeout(300);
  assert.equal(await has('217,85,43'), true, 'the fur does not take the theme\'s colour');
  assert.notEqual(await dither(), ember, 'the void follows the theme');
});

browserTest('the big layout switches on with the panel: a centred reading column and bigger type at half-screen, the old compact one when narrow', async t => {
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
  assert.ok(n.qMin < 40);
  assert.ok(n.boxWidth >= 355 && n.boxWidth <= 360, `box ${n.boxWidth}`);
  assert.ok(n.botWidth <= 340);
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
  assert.ok(m.width <= 760 && m.left === 340, JSON.stringify(m)); // (1440 - 760) / 2
  await f.frame.locator('#setBtn').click();
  // the sheet fills the window like history does; its two panes sit in a centred column of at most 900px
  const sheet = await f.frame.evaluate(() => { const r = document.querySelector('#sheet').getBoundingClientRect(), c = document.querySelector('.sin').getBoundingClientRect(); return [Math.round(r.width), Math.round(c.width), Math.round(c.left)]; });
  assert.deepEqual(sheet, [1440, 900, 270], 'Settings fills the window with its panes centred in 900px');
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

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// The pet (bookmarklet v13): Minimize turns the panel into a red panda. Playwright and a local Chromium, every HTTP response a fixture,
// the real bookmarklet making the iframe in a host page (so the see-through frame, sizes and drag are the real ones).
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
const browserTest = chromium ? test : test.skip;
const widget = await readFile(new URL('../public/widget.html', import.meta.url), 'utf8');
const bookmarkletSource = await readFile(new URL('../bookmarklet.js', import.meta.url), 'utf8');
const ORIGIN = 'https://pagebot.example.test';
const THEMES = ['auto', 'ember', 'paper', 'midnight', 'forest', 'dusk', 'sakura', 'terminal', 'pond', 'orbit', 'void', 'arcade', 'glass', 'clear'];
let browser;
before(async () => {
  if (chromium) browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); });

const boot = {
  authed: true, who: 'user', theme: 'ember', lockMinutes: 0,
  user: { id: 1, name: 'Test reader', status: 'trusted', allowWeb: true, passcode: true },
  prefs: { theme: 'ember', model: 'haiku', web: false },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku' }],
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const done = { t: 'done', conversationId: 42, model: 'haiku', usage: { in: 50, out: 20 }, stop: 'end_turn' };
const ANSWER = 'The article argues that small teams ship faster because they talk less and decide more, and it backs that with three case studies.';

async function fixture(t, { bookmark = 13, reduced = false, store = {}, theme = 'ember', chatGate, events = [{ t: 'd', v: ANSWER }, done], chatStatus = 200, viewport = { width: 1280, height: 800 } } = {}) {
  const context = await browser.newContext({ reducedMotion: reduced ? 'reduce' : 'no-preference', viewport });
  context.setDefaultTimeout(5000);
  const state = { requests: [], errors: [] };
  t.after(async () => { await context.close(); assert.deepEqual(state.errors, [], 'no browser errors or unexpected requests'); });
  await context.addInitScript(([items]) => {
    if (!sessionStorage.getItem('seeded')) { localStorage.setItem('pb_token', 'test-session'); for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); }
  }, [store]);
  const hostPage = `<!doctype html><html><body style="margin:0;background:#fff"><p>Host page text.</p>
    <script>
      window.hostRequests = [];
      addEventListener('message', event => {
        const f = document.getElementById('__pagebot');
        if (!f || event.source !== f.contentWindow) return;
        window.hostRequests.push(event.data);
        if (event.data.type === 'page') event.source.postMessage({ id: event.data.id, page: { url: 'https://news.example.test/a', title: 'A', text: 'Page text' }, selection: '' }, event.origin);
      });
    </script></body></html>`;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: hostPage });
    if (url.pathname === '/widget' || url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    state.requests.push({ path: url.pathname, method: request.method() });
    if (url.pathname === '/api/boot') return json({ ...boot, theme, prefs: { ...boot.prefs, theme }, version: 13 });
    if (url.pathname === '/api/prefs') return json({ prefs: { ...boot.prefs, ...request.postDataJSON() }, limits: boot.limits });
    if (url.pathname === '/api/ping' || url.pathname === '/api/logout') return json({ ok: true });
    if (url.pathname === '/api/chats') return json({ chats: [], next: null });
    if (url.pathname === '/api/chat') {
      if (chatGate) await chatGate.promise;
      if (chatStatus !== 200) return route.fulfill({ status: chatStatus, contentType: 'application/json', body: JSON.stringify({ error: 'nope' }) });
      return route.fulfill({ contentType: 'application/x-ndjson', body: events.map(e => JSON.stringify(e)).join('\n') + '\n' });
    }
    if (url.pathname === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
    if (url.pathname === '/api/commands') return json({ commands: [] });
    state.errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.location().url || '') && !(chatStatus === 401 && /401/.test(m.text()))) state.errors.push('console: ' + m.text()); });
  const open = async () => {
    await page.goto('https://news.example.test/a');
    await page.evaluate(bookmarkletSource.replaceAll('__ORIGIN__', ORIGIN).replaceAll('__VERSION__', String(bookmark)).replace(/\n\s*/g, ''));
    await page.waitForSelector('#__pagebot', { state: 'attached' });
    let frame;
    for (let i = 0; i < 50 && !frame; i++) { frame = page.frames().find(f => f.url().startsWith(ORIGIN + '/widget')); if (!frame) await page.waitForTimeout(50); }
    assert.ok(frame, 'the widget frame loaded');
    await frame.locator('#boot').waitFor({ state: 'detached' });
    await frame.locator('#q').waitFor({ state: 'visible' });
    return frame;
  };
  let frame = await open();
  const f = {
    context, page, state, get frame() { return frame; },
    reopen: async () => { frame = await open(); return frame; },
    style: () => page.evaluate(() => { const e = document.getElementById('__pagebot'), s = e.style; return { w: s.width, h: s.height, r: s.right, b: s.bottom, radius: s.borderRadius, shadow: s.boxShadow, display: s.display }; }),
    host: type => page.evaluate(t => window.hostRequests.filter(r => r.type === t), type),
    minimize: async () => { await frame.locator('#minBtn').click(); await page.waitForTimeout(260); },
    petBox: async () => { const b = await frame.locator('#pet').boundingBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, // page coordinates already
    send: async text => { await frame.locator('#q').fill(text); await frame.locator('#sendBtn').click(); },
  };
  return f;
}
// the pet's canvas: how many pixels are drawn (opaque), and the box they fill
const ink = c => c.evaluate(cv => {
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { n++; const x = (i / 4) % cv.width, y = Math.floor(i / 4 / cv.width); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { n, x0, y0, x1, y1, w: cv.width, h: cv.height };
});

browserTest('the sprite draws something in every animation state and every frame, and the states look different', async t => {
  const f = await fixture(t, { reduced: true });
  await f.minimize();
  const cv = f.frame.locator('#petCv');
  const r = await cv.evaluate(c => {
    const s = c.sprite, out = {}, seen = new Map();
    for (const name of s.states) {
      out[name] = [];
      for (let i = 0; i < s.frames(name); i++) {
        s.draw(name, i);
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, h = 0;
        for (let k = 0; k < d.length; k += 4) { if (d[k + 3] > 200) n++; h = (h * 31 + d[k] + d[k + 1] * 3 + d[k + 3]) | 0; }
        out[name].push(n); seen.set(h, name + i);
      }
    }
    return { out, distinct: seen.size, total: Object.values(out).flat().length, states: s.states };
  });
  for (const name of ['idle', 'working', 'nap', 'locked', 'dangle', 'hop', 'happy', 'shrug', 'wave', 'stretch', 'settle', 'wake', 'blink'])
    assert.ok(r.states.includes(name), name + ' is a state');
  for (const [name, counts] of Object.entries(r.out)) for (const n of counts) assert.ok(n > 250, `${name} draws a panda (${n} pixels)`);
  assert.ok(r.distinct > r.total * 0.6, `the frames are mostly different from each other (${r.distinct} of ${r.total})`);
});

browserTest('the pet animates while it is on screen, and stops when it is off the page or the panel opens again', async t => {
  const f = await fixture(t);
  await f.minimize();
  const cv = f.frame.locator('#petCv');
  assert.equal(await cv.getAttribute('data-anim'), 'on');
  const a = Number(await cv.getAttribute('data-frames'));
  await f.page.waitForTimeout(700);
  const b = Number(await cv.getAttribute('data-frames'));
  assert.ok(b >= a + 4 && b <= a + 14, `about 11 frames a second (${b - a} in 0.7 s)`);
  await f.frame.locator('#pet').click();
  await f.page.waitForTimeout(300);
  const c = Number(await cv.getAttribute('data-frames'));
  await f.page.waitForTimeout(500);
  assert.equal(Number(await cv.getAttribute('data-frames')), c, 'hidden with the panel open: no frames');
  await f.minimize();
  await f.page.waitForTimeout(500);
  assert.ok(Number(await cv.getAttribute('data-frames')) > c, 'it picks up again when minimized');
  const d = await cv.evaluate(async el => { el.remove(); await new Promise(r => setTimeout(r, 400)); const n = el.dataset.frames; await new Promise(r => setTimeout(r, 400)); return [n, el.dataset.frames]; });
  assert.equal(d[0], d[1], 'a canvas that left the page runs no more frames');
});

browserTest('with reduced motion the pet is one still frame; the Animations setting overrides the system either way', async t => {
  const still = await fixture(t, { reduced: true });
  await still.minimize();
  const cv = still.frame.locator('#petCv');
  assert.equal(await cv.getAttribute('data-anim'), 'off');
  assert.equal(await cv.getAttribute('data-frames'), null, 'no loop was ever started');
  assert.ok((await ink(cv)).n > 250);
  const full = await fixture(t, { reduced: true, store: { pb_motion: 'full' } });
  await full.minimize();
  assert.equal(await full.frame.locator('#petCv').getAttribute('data-anim'), 'on', 'Full animates even when the system asks for less');
  const less = await fixture(t, { store: { pb_motion: 'less' } });
  await less.minimize();
  assert.equal(await less.frame.locator('#petCv').getAttribute('data-anim'), 'off', 'Less holds still');
  assert.equal(await less.frame.locator('#petCv').getAttribute('data-frames'), null);
});

browserTest('Minimize on a v13 bookmark sends pet:true and leaves a see-through 120 px frame with the panda button in it', async t => {
  const f = await fixture(t);
  await f.minimize();
  const min = (await f.host('min')).at(-1);
  assert.deepEqual([min.on, min.pet, min.w, min.h], [true, true, 120, 120]);
  assert.deepEqual(await f.style(), { w: '120px', h: '120px', r: '16px', b: '16px', radius: '0px', shadow: 'none', display: 'block' });
  const pet = f.frame.locator('#pet');
  assert.equal(await pet.isVisible(), true);
  assert.equal(await pet.evaluate(e => e.tagName), 'BUTTON');
  assert.equal(await pet.getAttribute('aria-label'), 'Open pagebot');
  assert.equal(await f.frame.locator('header').isVisible(), false, 'no pill');
  const bg = await f.frame.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor, getComputedStyle(document.documentElement).colorScheme]);
  assert.deepEqual(bg, ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'light'], 'a dark theme still leaves the frame see-through (a light colour scheme, so Chrome adds no backing)');
  const box = await f.petBox();
  assert.ok(box.w === 120 && box.h === 120, 'the button fills the frame');
});

browserTest('clicking the panda, or Enter and Space on it, opens the panel again; the bookmark still toggles', async t => {
  const f = await fixture(t);
  const size = await f.style();
  await f.minimize();
  await f.frame.locator('#pet').click();
  await f.page.waitForTimeout(260);
  assert.equal((await f.host('min')).at(-1).on, false);
  assert.equal(await f.frame.locator('#pet').isVisible(), false);
  assert.equal(await f.frame.locator('#q').isVisible(), true);
  assert.deepEqual((await f.style()).w, size.w);
  for (const key of ['Enter', 'Space']) {
    await f.minimize();
    await f.frame.locator('#pet').focus();
    await f.frame.locator('#pet').press(key);
    await f.page.waitForTimeout(260);
    assert.equal(await f.frame.locator('#pet').isVisible(), false, key + ' opens it');
  }
  await f.minimize();
  await f.page.evaluate(bookmarkletSource.replaceAll('__ORIGIN__', ORIGIN).replaceAll('__VERSION__', '13').replace(/\n\s*/g, '')); // the bookmark, clicked
  await f.page.waitForTimeout(300);
  assert.equal(await f.frame.locator('#pet').isVisible(), false, 'the bookmark click restores it too');
});

browserTest('dragging the panda moves it and does not open the panel; a few pixels of wobble is still a click; the spot is remembered', async t => {
  const f = await fixture(t);
  await f.minimize();
  const b = await f.petBox();
  const before = await f.style();
  const x = b.x + 60, y = b.y + 60;
  await f.page.mouse.move(x, y); await f.page.mouse.down();
  await f.page.mouse.move(x - 40, y - 30, { steps: 6 }); await f.page.mouse.move(x - 120, y - 90, { steps: 6 });
  await f.page.mouse.up();
  await f.page.waitForTimeout(300);
  const after = await f.style();
  assert.equal(after.w, '120px');
  assert.ok(parseInt(after.r) > parseInt(before.r) + 100 && parseInt(after.b) > parseInt(before.b) + 70, `it moved (${before.r},${before.b}) to (${after.r},${after.b})`);
  assert.equal(await f.frame.locator('#pet').isVisible(), true, 'still the panda: a drag is not a click');
  assert.ok((await f.host('drag')).length > 2, 'the same drag message the panel uses');
  assert.deepEqual(JSON.parse(await f.frame.evaluate(() => localStorage.getItem('pb_petpos'))), { r: parseInt(after.r), b: parseInt(after.b) });
  // it stays on screen when dragged off the edge
  const c = await f.petBox();
  await f.page.mouse.move(c.x + 60, c.y + 60); await f.page.mouse.down(); await f.page.mouse.move(c.x - 2000, c.y - 2000, { steps: 8 }); await f.page.mouse.up();
  await f.page.waitForTimeout(300);
  const edge = await f.petBox();
  assert.ok(edge.x >= -1 && edge.y >= -1, `kept on screen (${edge.x}, ${edge.y})`);
  // wobble under the threshold is a click
  const d = await f.petBox();
  await f.page.mouse.move(d.x + 60, d.y + 60); await f.page.mouse.down(); await f.page.mouse.move(d.x + 62, d.y + 61); await f.page.mouse.up();
  await f.page.waitForTimeout(260);
  assert.equal(await f.frame.locator('#pet').isVisible(), false, 'a 2 px wobble opens the panel');
  // remembered: a new page load opens the panel there, and minimizing sits the panda there
  const pos = JSON.parse(await f.frame.evaluate(() => localStorage.getItem('pb_petpos')));
  await f.reopen();
  await f.minimize();
  const s = await f.style();
  assert.deepEqual([parseInt(s.r), parseInt(s.b)], [pos.r, pos.b]);
});

browserTest('an answer finishing while minimized: working while it writes, then a hop and a bubble with the start of it, and the frame grows and shrinks back', async t => {
  const gate = deferred();
  const f = await fixture(t, { chatGate: gate });
  await f.send('Summarize this page.');
  await f.frame.locator('.msg.bot').waitFor();
  await f.minimize();
  const cv = f.frame.locator('#petCv');
  assert.equal(await cv.getAttribute('data-state'), 'working', 'paws tapping while the answer is still coming');
  gate.resolve();
  await f.frame.locator('#petSay').waitFor({ state: 'visible' });
  const say = await f.frame.locator('#petSay').innerText();
  assert.equal(say, 'Done — ' + ANSWER.slice(0, 60) + '…');
  assert.equal(await cv.getAttribute('data-state'), 'hop');
  await f.page.waitForTimeout(260);
  const grown = await f.style();
  const sizes = (await f.host('min')).filter(m => m.pet);
  assert.ok(parseInt(grown.w) > 120 && parseInt(grown.h) > 140, `the frame makes room for the bubble (${grown.w} x ${grown.h})`);
  assert.equal(grown.radius, '0px'); assert.equal(grown.shadow, 'none');
  const bubble = await f.frame.locator('#petSay').boundingBox(), fr = await f.page.locator('#__pagebot').boundingBox();
  assert.ok(bubble.x >= fr.x - 1 && bubble.y >= fr.y - 1 && bubble.x + bubble.width <= fr.x + fr.width + 1 && bubble.y + bubble.height <= fr.y + fr.height + 1, 'the bubble is inside the frame');
  const pet = await f.petBox();
  assert.ok(Math.abs(pet.x + pet.w - (fr.x + fr.width)) < 2 && Math.abs(pet.y + pet.h - (fr.y + fr.height)) < 2, 'the panda stays at the corner while the frame grows');
  await f.frame.locator('#petSay').waitFor({ state: 'hidden', timeout: 8000 });
  await f.page.waitForTimeout(300);
  assert.equal((await f.style()).w, '120px', 'back to the small frame');
  assert.equal(sizes.at(-1).w > 120, true);
  assert.deepEqual([(await f.host('min')).at(-1).w, (await f.host('min')).at(-1).h], [120, 120]);
  assert.equal(await cv.getAttribute('data-state'), 'idle');
});

browserTest('a refusal or an error while minimized makes the panda shrug instead', async t => {
  for (const events of [[{ t: 'done', conversationId: 42, model: 'haiku', usage: { in: 5, out: 1 }, stop: 'refusal', refusal: 'policy' }], [{ t: 'd', v: 'Partial' }, { t: 'err', v: 'The model fell over' }]]) {
    const gate = deferred();
    const f = await fixture(t, { events, chatGate: gate });
    await f.send('something');
    await f.frame.locator('.msg.bot').waitFor();
    await f.minimize();
    gate.resolve();
    await f.frame.locator('#petCv[data-state=shrug]').waitFor({ timeout: 3000 });
    assert.match(await f.frame.locator('#petSay').innerText(), /didn’t work/);
    assert.ok(parseInt((await f.style()).w) > 120, 'room for the bubble');
  }
});

browserTest('a locked panel shows a sleepy panda with a small lock; nothing about why', async t => {
  const f = await fixture(t);
  await f.frame.locator('#lockBtn').click();
  await f.frame.locator('#login').waitFor({ state: 'visible' });
  await f.minimize();
  assert.equal(await f.frame.locator('#petCv').getAttribute('data-state'), 'locked');
  assert.equal(await f.frame.locator('#petLock').isVisible(), true);
  assert.equal(await f.frame.locator('#petLock').innerText(), '🔒');
  await f.frame.locator('#pet').click();
  await f.page.waitForTimeout(260);
  assert.equal(await f.frame.locator('#login').isVisible(), true, 'opening it again shows the lock screen');
  // an answer that finds the session gone while minimized locks it
  const g = deferred();
  const h = await fixture(t, { chatGate: g, chatStatus: 401 });
  await h.send('hello');
  await h.frame.locator('.msg.bot').waitFor();
  await h.minimize();
  assert.equal(await h.frame.locator('#petCv').getAttribute('data-state'), 'working');
  g.resolve();
  await h.frame.locator('#petLock').waitFor({ state: 'visible' });
  assert.equal(await h.frame.locator('#petCv').getAttribute('data-state'), 'locked');
});

browserTest('a v12 bookmark keeps the pill: min without pet, the old frame, no panda', async t => {
  const f = await fixture(t, { bookmark: 12 });
  await f.minimize();
  const min = (await f.host('min')).at(-1);
  assert.deepEqual([min.on, min.pet, min.w, min.h], [true, undefined, 200, 46]);
  const s = await f.style();
  assert.deepEqual([s.w, s.h, s.radius], ['200px', '46px', '23px']);
  assert.equal(await f.frame.locator('#pet').isVisible(), false);
  assert.equal(await f.frame.locator('header').isVisible(), true);
  await f.frame.locator('#minBtn').click();
  await f.page.waitForTimeout(260);
  assert.equal(await f.frame.locator('#q').isVisible(), true);
});

browserTest('Settings > Appearance > Panel > Minimize to switches between the panda and the pill, and is remembered', async t => {
  const f = await fixture(t);
  const seg = f.frame.locator('#miniSeg');
  await f.frame.locator('#setBtn').click();
  await f.frame.locator('#tab-appearance').click();
  assert.equal(await f.frame.locator('#miniLbl').innerText(), 'Minimize to');
  assert.deepEqual(await seg.locator('button').allInnerTexts(), ['Panda', 'Pill']);
  assert.equal(await seg.locator('button.on').innerText(), 'Panda', 'the panda is the default on a v13 bookmark');
  await seg.getByText('Pill').click();
  assert.equal(await f.frame.evaluate(() => localStorage.getItem('pb_mini')), 'pill');
  await f.frame.locator('#shClose').click().catch(() => f.page.keyboard.press('Escape'));
  await f.frame.locator('#minBtn').click();
  await f.page.waitForTimeout(260);
  assert.equal((await f.host('min')).at(-1).pet, undefined);
  assert.equal((await f.style()).w, '200px');
  await f.frame.locator('header').click({ position: { x: 20, y: 20 } });
  await f.page.waitForTimeout(260);
  await f.frame.locator('#setBtn').click();
  await f.frame.locator('#tab-appearance').click();
  await seg.getByText('Panda').click();
  assert.equal(await f.frame.evaluate(() => localStorage.getItem('pb_mini')), null);
  await f.page.keyboard.press('Escape');
  await f.minimize();
  assert.equal(await f.frame.locator('#pet').isVisible(), true);
  // an older bookmark can't do the panda: that choice is greyed out, with the reason
  const old = await fixture(t, { bookmark: 12 });
  await old.frame.locator('#setBtn').click();
  await old.frame.locator('#tab-appearance').click();
  assert.equal(await old.frame.locator('#miniSeg button', { hasText: 'Panda' }).isDisabled(), true);
  assert.equal(await old.frame.locator('#miniSeg button.on').innerText(), 'Pill');
  assert.match(await old.frame.locator('#miniNote').innerText(), /newest bookmark/);
});

browserTest('hovering the panda makes it wave and look toward the pointer; left alone it curls up for a nap and wakes when you come back', async t => {
  const f = await fixture(t);
  await f.minimize();
  const cv = f.frame.locator('#petCv'), b = await f.petBox();
  await f.page.mouse.move(b.x + 100, b.y + 60);
  await f.page.waitForTimeout(200);
  assert.equal(await cv.getAttribute('data-state'), 'wave');
  await f.page.waitForTimeout(1300);
  await f.page.mouse.move(b.x + 4, b.y + 62);
  await f.page.waitForTimeout(250);
  assert.equal(await cv.getAttribute('data-gaze'), 'l', 'looks left when the pointer is to its left');
  await f.page.mouse.move(b.x + 116, b.y + 62);
  await f.page.waitForTimeout(250);
  assert.equal(await cv.getAttribute('data-gaze'), 'r');
  await f.page.mouse.move(b.x + 300, b.y - 200); // away
  await f.page.waitForTimeout(150);
  assert.equal(await cv.getAttribute('data-gaze'), '');
  await cv.evaluate(c => c.sprite.idleFor(25000));
  await cv.locator('xpath=self::*[@data-state="nap"]').waitFor({ timeout: 4000 });
  const nap = await ink(cv);
  assert.ok(nap.n > 250);
  await f.page.mouse.move(b.x + 60, b.y + 60);
  await cv.locator('xpath=self::*[@data-state="wake" or @data-state="idle"]').waitFor({ timeout: 2000 });
});

browserTest('all 14 themes show the whole panda, unclipped, in a see-through frame', async t => {
  for (const theme of THEMES) {
    const f = await fixture(t, { reduced: true, theme, store: { pb_theme: theme } });
    await f.minimize();
    const cv = f.frame.locator('#petCv'), r = await ink(cv);
    assert.ok(r.n > 400, theme + ': drawn');
    assert.ok(r.x0 >= 1 && r.y0 >= 1 && r.x1 <= r.w - 2 && r.y1 <= r.h - 2, `${theme}: nothing touches the canvas edge (${JSON.stringify(r)})`);
    const st = await f.style();
    assert.deepEqual([st.w, st.h, st.radius, st.shadow], ['120px', '120px', '0px', 'none'], theme);
    const bg = await f.frame.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
    assert.deepEqual(bg, ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'], theme + ': see-through');
    const box = await f.petBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= 1280 && box.y + box.h <= 800, theme + ': on screen');
    // the fur is the panda's own colour whatever the theme
    assert.equal(await cv.evaluate(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255 && d[i] === 217 && d[i + 1] === 85 && d[i + 2] === 43) return true; return false; }), true, theme + ': fur colour');
  }
});

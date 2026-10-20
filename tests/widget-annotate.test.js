import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// Screenshot annotation (the ✏ Annotate sheet) in a real browser. Every HTTP response is a fixture: no server, database or
// API key. A screenshot comes in by pasting an image (or from a fake shared tab for the "screenshots stay on" tests), and
// the checks read pixels: from the sheet's canvas, and from the picture the panel sends in /api/chat.
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

const boot = (theme = 'ember') => ({
  authed: true, who: 'user', theme, lockMinutes: 0,
  user: { id: 1, name: 'Test reader', status: 'trusted', allowWeb: true, passcode: false },
  prefs: { theme, model: 'haiku', web: false },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku' }],
});
const done = { t: 'done', conversationId: 42, model: 'haiku', usage: { in: 50, out: 20 }, stop: 'end_turn' };

// The panel on /chat, or inside a host page in an iframe of the given size. `hold`: the next answer waits (to stop it, or unsend).
async function fixture(t, { standalone = true, theme = 'ember', viewport = { width: 900, height: 900 }, frame: size = { width: 440, height: 840 }, motion = 'reduce' } = {}) {
  const context = await browser.newContext({ reducedMotion: motion, viewport });
  context.setDefaultTimeout(5000);
  const state = { requests: [], errors: [], hold: null };
  t.after(async () => {
    state.hold?.resolve();
    await context.close();
    assert.deepEqual(state.errors, [], 'the widget must not raise browser errors or make unexpected requests');
  });
  await context.addInitScript(([theme]) => {
    if (location.hostname !== 'pagebot.example.test') return;
    localStorage.setItem('pb_token', 'test-session'); localStorage.setItem('pb_theme', theme);
    // the shared tab (for "screenshots stay on"): a grey 1200×800 picture with a green square; it counts the frames it hands out
    window.__shares = 0;
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.__shares++;
      const c = document.createElement('canvas'), g = c.getContext('2d');
      c.width = 1200; c.height = 800;
      const paint = () => { g.fillStyle = '#808080'; g.fillRect(0, 0, 1200, 800); g.fillStyle = '#00a000'; g.fillRect(40, 40, 100, 100); };
      paint(); setInterval(paint, 100);
      return c.captureStream(10);
    };
  }, [theme]);
  const hostPage = `<!doctype html><html><body style="margin:0"><script>
    addEventListener('message', e => {
      const f = document.querySelector('iframe'); if (e.source !== f.contentWindow) return;
      const r = e.data;
      if (r.type === 'page') e.source.postMessage({ id: r.id, page: { url: 'https://news.example.test/a', title: 'Article', text: r.max <= 1 ? '' : 'From the page' }, selection: '' }, e.origin);
      else if (r.id) e.source.postMessage({ id: r.id, ok: true }, e.origin);
    });
  </script><iframe title="Pagebot" src="https://pagebot.example.test/widget?v=7" style="width:${size.width}px;height:${size.height}px;border:0"></iframe></body></html>`;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: hostPage });
    if (url.pathname === '/widget' || url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    state.requests.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
    if (url.pathname === '/api/boot') return json({ ...boot(theme), version: 7 });
    if (url.pathname === '/api/logout' || url.pathname === '/api/ping') return json({ ok: true });
    if (url.pathname === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
    if (url.pathname === '/api/chat') {
      if (state.hold) { const h = state.hold; state.hold = null; await h.promise; }
      return route.fulfill({ contentType: 'application/x-ndjson', body: [{ t: 'd', v: 'A helpful answer.' }, done].map(e => JSON.stringify(e)).join('\n') + '\n' }).catch(() => {});
    }
    state.errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  await page.goto(standalone ? 'https://pagebot.example.test/chat' : 'https://news.example.test/article');
  const frame = standalone ? page.mainFrame() : page.frames().find(f => f.url().startsWith('https://pagebot.example.test/'));
  assert.ok(frame, 'the panel loaded');
  await frame.locator('#setBtn').waitFor({ state: 'visible' });
  await frame.locator('#boot').waitFor({ state: 'detached' });
  const f = { context, page, frame, state, q: frame.locator('#q') };
  // paste a picture: w×h, mid-grey with a green square at the top left (so a mark's colour is easy to tell from the picture)
  f.paste = async (w = 800, h = 500) => {
    await frame.evaluate(async ([w, h]) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, w, h); g.fillStyle = '#00a000'; g.fillRect(w * .05, h * .05, w * .125, h * .2);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const d = new DataTransfer(); d.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
      document.querySelector('#q').dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }));
    }, [w, h]);
    await frame.locator('#att img[src^="data:image"]').waitFor();
  };
  f.open = async () => { await frame.locator('#inkBtn').click(); await frame.locator('#ink').waitFor({ state: 'visible' }); await f.settle(); };
  f.settle = () => frame.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  f.tool = async name => { await frame.locator(`#inkTools [role=radio][aria-label="${name}"]`).click(); };
  f.color = async name => { await frame.locator(`#inkColors [role=radio][aria-label="${name}"]`).click(); };
  f.size = async name => { await frame.locator(`#inkSizes [role=radio][aria-label^="${name}"]`).click(); };
  f.box = async () => frame.locator('#inkCv').boundingBox();
  // a point on the picture (0..1 each way) as screen coordinates
  f.at = async (x, y) => { const b = await f.box(); return { x: b.x + b.width * x, y: b.y + b.height * y }; };
  f.drag = async (a, b, { steps = 8 } = {}) => {
    const p = await f.at(...a), q = await f.at(...b);
    await f.page.mouse.move(p.x, p.y); await f.page.mouse.down();
    for (let i = 1; i <= steps; i++) await f.page.mouse.move(p.x + (q.x - p.x) * i / steps, p.y + (q.y - p.y) * i / steps);
    await f.page.mouse.up(); await f.settle();
  };
  f.click = async (x, y) => { const p = await f.at(x, y); await f.page.mouse.click(p.x, p.y); await f.settle(); };
  // the sheet's canvas colour at a point (0..1), as [r, g, b]
  f.px = (x, y) => frame.evaluate(([x, y]) => {
    const c = document.querySelector('#inkCv'), d = c.getContext('2d').getImageData(Math.round((c.width - 1) * x), Math.round((c.height - 1) * y), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);
  // the colour at a point of the attached picture (what is sent, by the time you look), and its size
  f.attached = () => look(frame, null);
  f.sendQ = async text => {
    const n = await frame.locator('.msg.bot .meta').count();
    await f.q.fill(text); await frame.locator('#sendBtn').click();
    await frame.waitForFunction(n => document.querySelectorAll('.msg.bot .meta').length > n, n);
  };
  f.chats = () => state.requests.filter(r => r.path === '/api/chat').map(r => r.body);
  return f;
}
// a picture (a data URL, or the attached one when src is null): its size and colours at points (0..1)
async function look(frame, src, points = []) {
  return frame.evaluate(async ([src, points]) => {
    const im = new Image(); im.src = src || document.querySelector('#att img').src; await im.decode();
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    return { w: im.naturalWidth, h: im.naturalHeight, px: points.map(([x, y]) => [...g.getImageData(Math.round((c.width - 1) * x), Math.round((c.height - 1) * y), 1, 1).data].slice(0, 3)) };
  }, [src, points]);
}
const GREY = [128, 128, 128];
// close to a colour (JPEG blurs edges a little)
const near = (got, want, tol = 40) => got.every((v, i) => Math.abs(v - want[i]) <= tol);
const isRed = p => p[0] > 200 && p[1] < 90 && p[2] < 90;
const isBlack = p => p.every(v => v < 25);
const isGrey = p => near(p, GREY, 12);

browserTest('Annotate opens from the preview button and from the thumbnail, and closes with Esc and Cancel', async t => {
  const f = await fixture(t);
  assert.equal(await f.frame.locator('#inkBtn').isVisible(), false, 'nothing to annotate until there is a screenshot');
  await f.paste();
  assert.equal(await f.frame.locator('#inkBtn').innerText(), '✏ Annotate');
  await f.open();
  assert.equal(await f.frame.locator('#ink').getAttribute('role'), 'dialog');
  const cv = await f.box();
  assert.ok(Math.abs(cv.width / cv.height - 800 / 500) < 0.02, 'the picture keeps its shape');
  assert.deepEqual(await f.px(0.1, 0.1), [0, 160, 0], 'the screenshot is drawn on the sheet');
  assert.ok(isGrey(await f.px(0.8, 0.8)));
  await f.page.keyboard.press('Escape');
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
  assert.equal(await f.frame.locator('#att').isVisible(), true, 'Esc with no marks closes at once and keeps the screenshot');
  // the thumbnail opens it too, and Cancel closes it
  await f.frame.locator('#att img').click();
  await f.frame.locator('#ink').waitFor({ state: 'visible' });
  await f.frame.locator('#inkCancel').click();
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
  // the panel's other Esc behaviour (closing the history/settings sheet) is not triggered by the sheet's Esc
  assert.equal(await f.frame.locator('#q').isVisible(), true);
});

browserTest('each tool draws where it was dragged: pen, arrow, circle, rectangle, highlighter, text, and a black redact box', async t => {
  const f = await fixture(t);
  await f.paste(800, 500);
  await f.open();
  await f.tool('Pen'); await f.size('Thick');
  await f.drag([0.55, 0.15], [0.9, 0.15]);
  assert.ok(isRed(await f.px(0.72, 0.15)), 'the pen line is red, halfway along');
  assert.ok(isGrey(await f.px(0.72, 0.3)), 'and not elsewhere');

  await f.tool('Arrow'); await f.color('Blue');
  await f.drag([0.1, 0.9], [0.5, 0.5]);
  const blue = p => p[2] > 200 && p[0] < 60;
  assert.ok(blue(await f.px(0.3, 0.7)), 'the shaft');
  assert.ok(blue(await f.px(0.48, 0.52)), 'the head sits at the end you dragged to');
  assert.ok(isGrey(await f.px(0.12, 0.88)) || blue(await f.px(0.12, 0.88)), 'the tail');
  assert.ok(isGrey(await f.px(0.5, 0.9)), 'nothing past the tail');

  await f.tool('Circle'); await f.color('Green'); await f.size('Medium');
  await f.drag([0.55, 0.4], [0.95, 0.85]);
  const lime = p => p[1] > 190 && p[0] < 90 && p[2] < 120;
  assert.ok(lime(await f.px(0.75, 0.4)) || lime(await f.px(0.75, 0.405)), 'the circle’s top edge');
  assert.ok(lime(await f.px(0.55, 0.625)) || lime(await f.px(0.553, 0.625)), 'its left edge');
  assert.ok(isGrey(await f.px(0.75, 0.625)), 'it is an outline, not filled');

  await f.tool('Rectangle'); await f.color('Yellow');
  await f.drag([0.05, 0.35], [0.4, 0.6]);
  const yellow = p => p[0] > 200 && p[1] > 180 && p[2] < 120;
  assert.ok(yellow(await f.px(0.22, 0.35)) || yellow(await f.px(0.22, 0.352)), 'the top edge');
  assert.ok(isGrey(await f.px(0.22, 0.48)), 'hollow');

  await f.tool('Highlighter'); await f.color('Yellow');
  await f.drag([0.4, 0.05], [0.5, 0.05]);
  const hl = await f.px(0.45, 0.05);
  assert.ok(hl[0] > 150 && hl[1] > 150 && hl[2] < 100 && !near(hl, [255, 214, 10], 25), `translucent yellow over the picture: ${hl}`);

  await f.tool('Text'); await f.color('Red'); await f.size('Thick');
  await f.click(0.6, 0.62);
  await f.frame.locator('#inkText').fill('Look here');
  await f.frame.locator('#inkText').press('Enter');
  await f.settle();
  assert.equal(await f.frame.locator('#inkText').isVisible(), false);
  const text = await f.frame.evaluate(() => {
    const c = document.querySelector('#inkCv'), g = c.getContext('2d'), x0 = Math.round(c.width * .6), y0 = Math.round(c.height * .62), w = Math.round(c.width * .3), h = Math.round(c.height * .1);
    const d = g.getImageData(x0, y0, w, h).data; let red = 0, white = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90) red++; if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) white++; }
    return { red, white };
  });
  assert.ok(text.red > 150, `the label is drawn in the picked colour (${text.red} red pixels)`);
  assert.ok(text.white > 30, `with a light outline so it reads on any picture (${text.white} light pixels)`);

  await f.tool('Redact');
  await f.color('Red'); // the colour doesn't matter: it is always solid black
  await f.drag([0.6, 0.78], [0.85, 0.95]);
  assert.ok(isBlack(await f.px(0.72, 0.86)), 'the redact box is solid black');
  assert.match(await f.frame.locator('#inkTools [aria-label=Redact]').getAttribute('title'), /hide private information/);
});

browserTest('undo, redo and clear (buttons and Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z)', async t => {
  const f = await fixture(t);
  await f.paste();
  await f.open();
  const undo = f.frame.locator('#inkUndo'), redo = f.frame.locator('#inkRedo'), clear = f.frame.locator('#inkClear');
  assert.ok(await undo.isDisabled() && await redo.isDisabled() && await clear.isDisabled(), 'nothing to undo yet');
  await f.tool('Rectangle'); await f.size('Thick');
  await f.drag([0.1, 0.4], [0.3, 0.8]);
  await f.tool('Redact');
  await f.drag([0.5, 0.4], [0.7, 0.8]);
  assert.ok(isBlack(await f.px(0.6, 0.6)));
  await undo.click();
  assert.ok(isGrey(await f.px(0.6, 0.6)), 'undo takes the last mark off');
  assert.equal(await redo.isDisabled(), false);
  await f.page.keyboard.press('Control+Shift+Z');
  assert.ok(isBlack(await f.px(0.6, 0.6)), 'Ctrl+Shift+Z puts it back');
  await f.page.keyboard.press('Control+Z');
  assert.ok(isGrey(await f.px(0.6, 0.6)), 'Ctrl+Z');
  await f.page.keyboard.press('Meta+Shift+Z');
  assert.ok(isBlack(await f.px(0.6, 0.6)), 'Cmd+Shift+Z');
  await f.page.keyboard.press('Control+Z'); await f.page.keyboard.press('Control+Z');
  assert.ok(await undo.isDisabled(), 'back at the start');
  await f.page.keyboard.press('Control+Y');
  await f.tool('Redact');
  await f.drag([0.6, 0.1], [0.8, 0.3]);
  assert.ok(await redo.isDisabled(), 'a new mark ends the redo line');
  await clear.click();
  assert.ok(isGrey(await f.px(0.7, 0.2)) && isGrey(await f.px(0.1, 0.6)), 'Clear takes every mark off');
  assert.ok(await clear.isDisabled());
  await undo.click();
  assert.ok(isBlack(await f.px(0.7, 0.2)), 'and Clear can be undone');
});

browserTest('Esc cancels without changing the screenshot (asking first when there are marks); Done applies and marks it annotated', async t => {
  const f = await fixture(t);
  await f.paste(800, 500);
  const before = await f.frame.locator('#att img').getAttribute('src');
  await f.open();
  await f.tool('Redact');
  await f.drag([0.3, 0.3], [0.6, 0.6]);
  await f.page.keyboard.press('Escape');
  assert.equal(await f.frame.locator('#inkConf').isVisible(), true, 'unsaved marks ask before they are thrown away');
  assert.equal(await f.frame.locator('#ink').isVisible(), true);
  await f.page.keyboard.press('Escape'); // Esc on the question means "keep drawing"
  assert.equal(await f.frame.locator('#inkConf').isVisible(), false);
  assert.equal(await f.frame.locator('#ink').isVisible(), true);
  await f.page.keyboard.press('Escape');
  await f.frame.locator('#inkDiscard').click();
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
  assert.equal(await f.frame.locator('#att img').getAttribute('src'), before, 'the screenshot is as it was');
  assert.equal(await f.frame.locator('#att').getAttribute('class') || '', '');
  assert.equal(await f.frame.locator('#inkBtn').innerText(), '✏ Annotate');

  await f.open();
  await f.tool('Redact');
  await f.drag([0.3, 0.3], [0.6, 0.6]);
  await f.frame.locator('#inkDone').click();
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
  const after = await f.frame.locator('#att img').getAttribute('src');
  assert.notEqual(after, before, 'Done replaces the preview');
  assert.equal(await f.frame.locator('#att.marked').count(), 1);
  assert.equal(await f.frame.locator('#inkBtn').innerText(), '✏ Edit marks');
  const shot = await look(f.frame, null, [[0.45, 0.45], [0.8, 0.8], [0.1, 0.1]]);
  assert.deepEqual([shot.w, shot.h], [800, 500], 'at the screenshot’s own size');
  assert.ok(isBlack(shot.px[0]) && isGrey(shot.px[1]), 'the box is in the preview');
  assert.ok(near(shot.px[2], [0, 160, 0], 30), 'and the rest of the picture is the original');
  assert.equal(await f.frame.evaluate(() => document.activeElement.id), 'inkBtn', 'the keyboard goes back to the button');
});

browserTest('reopening shows the earlier marks, lets you delete one, and removing them all gives the plain screenshot back', async t => {
  const f = await fixture(t);
  await f.paste(800, 500);
  const plain = await f.frame.locator('#att img').getAttribute('src');
  await f.open();
  await f.tool('Redact');
  await f.drag([0.1, 0.5], [0.3, 0.9]);
  await f.tool('Rectangle'); await f.size('Thick');
  await f.drag([0.5, 0.5], [0.9, 0.9]);
  await f.frame.locator('#inkDone').click();
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });

  await f.open();
  assert.ok(isBlack(await f.px(0.2, 0.7)), 'the redact box is still there to edit (not baked into the picture)');
  assert.ok(isRed(await f.px(0.7, 0.5)) || isRed(await f.px(0.7, 0.503)), 'and the rectangle');
  await f.tool('Select');
  await f.click(0.2, 0.7);
  assert.equal(await f.frame.locator('#inkDel').isDisabled(), false, 'clicking a mark selects it');
  await f.frame.locator('#inkDel').click();
  assert.ok(isGrey(await f.px(0.2, 0.7)), 'the box is gone');
  assert.ok(isRed(await f.px(0.7, 0.5)) || isRed(await f.px(0.7, 0.503)), 'the other mark stays');
  await f.frame.locator('#inkDone').click();
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
  const one = await look(f.frame, null, [[0.2, 0.7], [0.7, 0.5]]);
  assert.ok(isGrey(one.px[0]), 'the picture sent has no box any more');

  // moving a mark: drag the rectangle (select tool) by its edge
  await f.open();
  await f.tool('Select');
  await f.drag([0.7, 0.5], [0.7, 0.3]);
  assert.ok(isGrey(await f.px(0.7, 0.55)) && isRed(await f.px(0.7, 0.3)), 'the rectangle moved up with the drag');
  await f.page.keyboard.press('Delete');
  assert.ok(isGrey(await f.px(0.7, 0.3)), 'Delete removes the selected mark');
  await f.frame.locator('#inkDone').click();
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
  assert.equal(await f.frame.locator('#att img').getAttribute('src'), plain, 'with every mark gone it is the original screenshot again');
  assert.equal(await f.frame.locator('#inkBtn').innerText(), '✏ Annotate');
  await f.sendQ('Plain again?');
  assert.equal(f.chats()[0].annotated, undefined, 'and a plain screenshot is not marked annotated');
});

browserTest('the request says annotated:true with a JPEG under 8 MB and within 2000 px; the bubble shows the tag and the marked picture', async t => {
  const f = await fixture(t);
  await f.paste(2400, 1500); // a big paste: the panel brings it to 1568 px first
  await f.open();
  await f.tool('Redact');
  await f.drag([0.4, 0.4], [0.7, 0.7]);
  await f.frame.locator('#inkDone').click();
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
  await f.sendQ('What does this mean?');
  const [body] = f.chats();
  assert.equal(body.annotated, true);
  assert.match(body.image, /^data:image\/jpeg;base64,/);
  assert.ok(body.image.length < 8_000_000, 'well under the server’s limit');
  const shot = await look(f.frame, body.image, [[0.55, 0.55], [0.1, 0.9]]);
  assert.ok(Math.max(shot.w, shot.h) <= 2000, `${shot.w}×${shot.h}`);
  assert.ok(isBlack(shot.px[0]) && isGrey(shot.px[1]));
  assert.match(await f.frame.locator('.msg.user .tags').innerText(), /^(📷 screenshot|🖼 image) · ✏ annotated$/);
  assert.equal(await f.frame.locator('.msg.user img.thumb').count(), 1);
  const thumb = await look(f.frame, await f.frame.locator('.msg.user img.thumb').getAttribute('src'), [[0.55, 0.55]]);
  assert.ok(isBlack(thumb.px[0]), 'the thumbnail in the bubble is the annotated picture');
  assert.equal(await f.frame.locator('#att').isVisible(), false, 'it is sent, so the preview is empty');

  // a plain screenshot sends no annotated flag
  await f.paste(400, 300);
  await f.sendQ('And this one?');
  assert.equal('annotated' in f.chats()[1], false);
  assert.doesNotMatch(await f.frame.locator('.msg.user .tags').last().innerText(), /annotated/);
});

browserTest('removing the screenshot throws the marks away, and so does taking a different one', async t => {
  const f = await fixture(t);
  await f.paste();
  await f.open();
  await f.tool('Redact');
  await f.drag([0.2, 0.2], [0.5, 0.5]);
  await f.frame.locator('#inkDone').click();
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
  assert.equal(await f.frame.locator('#inkBtn').innerText(), '✏ Edit marks');
  await f.frame.locator('#rmAtt').click();
  assert.equal(await f.frame.locator('#att').isVisible(), false);
  await f.paste();
  assert.equal(await f.frame.locator('#inkBtn').innerText(), '✏ Annotate', 'a new screenshot starts clean');
  await f.open();
  assert.ok(isGrey(await f.px(0.35, 0.35)), 'no marks come back');
  assert.equal(await f.frame.locator('#inkUndo').isDisabled(), true);
  // marks, then a different picture pasted over it
  await f.tool('Redact');
  await f.drag([0.2, 0.2], [0.5, 0.5]);
  await f.frame.locator('#inkDone').click();
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
  await f.paste(600, 400);
  await f.open();
  assert.ok(!isBlack(await f.px(0.35, 0.35)), 'the old marks are gone from the new picture');
  await f.page.keyboard.press('Escape');
  await f.sendQ('Plain?');
  assert.equal('annotated' in f.chats()[0], false);
});

browserTest('mouse, touch and pen pointers all draw', async t => {
  const f = await fixture(t);
  await f.paste();
  await f.open();
  await f.tool('Pen'); await f.size('Thick');
  // synthetic pointer events of each type, as a touch screen or a stylus sends them
  for (const [type, y] of [['touch', .2], ['pen', .5], ['mouse', .8]]) {
    const b = await f.box();
    await f.frame.evaluate(([type, x0, x1, y]) => {
      const cv = document.querySelector('#inkCv'), id = type === 'mouse' ? 1 : type === 'pen' ? 2 : 3;
      const ev = (name, x) => new PointerEvent(name, { pointerId: id, pointerType: type, isPrimary: true, button: name === 'pointermove' ? -1 : 0, buttons: name === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true });
      cv.dispatchEvent(ev('pointerdown', x0));
      for (let i = 1; i <= 6; i++) cv.dispatchEvent(ev('pointermove', x0 + (x1 - x0) * i / 6));
      cv.dispatchEvent(ev('pointerup', x1));
    }, [type, b.x + b.width * .2, b.x + b.width * .8, b.y + b.height * y]);
    await f.settle();
    assert.ok(isRed(await f.px(0.5, y)), `${type} drew a line`);
  }
  // a second finger while one is down doesn't start another mark
  assert.equal(await f.frame.locator('#inkCv').evaluate(c => getComputedStyle(c).touchAction), 'none', 'the canvas doesn’t scroll or zoom under a finger');
  await f.frame.locator('#inkUndo').click(); await f.frame.locator('#inkUndo').click(); await f.frame.locator('#inkUndo').click();
  assert.ok(isGrey(await f.px(0.5, 0.2)) && isGrey(await f.px(0.5, 0.5)) && isGrey(await f.px(0.5, 0.8)), 'one undo each');
});

browserTest('the keyboard can pick tools, draw with the cursor keys, select and delete, and Tab stays inside the sheet', async t => {
  const f = await fixture(t);
  await f.paste();
  await f.open();
  const tools = f.frame.locator('#inkTools');
  assert.equal(await tools.getAttribute('role'), 'radiogroup');
  assert.equal(await f.frame.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Arrow', 'focus starts on the chosen tool');
  await f.page.keyboard.press('ArrowRight'); // Circle
  await f.page.keyboard.press('ArrowRight'); // Rectangle
  assert.equal(await f.frame.locator('#inkTools [aria-checked=true]').getAttribute('aria-label'), 'Rectangle');
  assert.equal(await f.frame.locator('#inkTools [role=radio]').evaluateAll(b => b.filter(x => x.tabIndex === 0).length), 1, 'one tab stop in the group');
  // Tab order: the tool, the colour, the size, undo (disabled: skipped)... on to the canvas
  const order = [];
  for (let i = 0; i < 12; i++) {
    await f.page.keyboard.press('Tab');
    order.push(await f.frame.evaluate(() => document.activeElement.id || document.activeElement.getAttribute('aria-label')));
  }
  assert.ok(order.includes('inkCv') && order.includes('Red') && order.includes('Medium lines and text') && order.includes('inkDone') && order.includes('inkCancel'), order.join(', '));
  assert.ok(order.indexOf('inkCancel') > 0, 'the loop comes back round to the top');
  await f.frame.locator('#inkCv').focus();
  // the cursor starts in the middle: Space starts a mark, arrows move, Space finishes it
  await f.page.keyboard.press('Space');
  for (let i = 0; i < 10; i++) await f.page.keyboard.press('ArrowRight');
  for (let i = 0; i < 10; i++) await f.page.keyboard.press('ArrowDown');
  await f.page.keyboard.press('Space');
  await f.settle();
  assert.ok(isRed(await f.px(0.6, 0.5)) || isRed(await f.px(0.6, 0.503)), 'a rectangle was drawn from the cursor');
  await f.tool('Select');
  await f.frame.locator('#inkCv').focus();
  await f.page.keyboard.press(']');
  assert.equal(await f.frame.locator('#inkDel').isDisabled(), false, '] selects a mark');
  await f.page.keyboard.press('Delete');
  assert.ok(isGrey(await f.px(0.6, 0.5)), 'Delete removes it');
  await f.page.keyboard.press('Escape');
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
});

browserTest('a label is typed in a box on the picture: Enter places it, Esc drops it, and the size and colour follow the swatches', async t => {
  const f = await fixture(t);
  await f.paste();
  await f.open();
  await f.tool('Text');
  await f.click(0.2, 0.5);
  await f.frame.locator('#inkText').fill('dropped');
  await f.page.keyboard.press('Escape');
  assert.equal(await f.frame.locator('#ink').isVisible(), true, 'Esc while typing only drops the label');
  assert.equal(await f.frame.locator('#inkText').isVisible(), false);
  assert.equal(await f.frame.locator('#inkUndo').isDisabled(), true);
  await f.click(0.2, 0.5);
  await f.frame.locator('#inkText').fill('two\nlines');
  await f.color('Blue'); // changes the label being typed
  await f.frame.waitForFunction(() => getComputedStyle(document.querySelector('#inkText')).color === 'rgb(10, 132, 255)');
  await f.frame.locator('#inkText').press('Enter');
  assert.equal(await f.frame.locator('#inkUndo').isDisabled(), false);
  await f.frame.locator('#inkDone').click();
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
  await f.sendQ('?');
  assert.equal(f.chats()[0].annotated, true);
});

browserTest('"screenshots stay on" skips its automatic shot exactly once for an annotated screenshot', async t => {
  const f = await fixture(t);
  await f.frame.locator('#addBtn').click();
  await f.frame.locator('#shotBtn').click();
  await f.frame.locator('#att img[src^="data:image"]').waitFor();
  assert.equal(await f.frame.locator('#areaPill').isVisible(), true, 'screenshots stay on');
  await f.open();
  await f.tool('Redact');
  await f.drag([0.3, 0.3], [0.6, 0.6]);
  await f.frame.locator('#inkDone').click();
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
  const shares = () => f.frame.evaluate(() => window.__shares);
  await f.sendQ('First, marked up');
  let first = await look(f.frame, f.chats()[0].image, [[0.45, 0.45], [0.9, 0.9]]);
  assert.equal(f.chats()[0].annotated, true);
  assert.ok(isBlack(first.px[0]), 'the marked picture is what went, not a new shot');
  assert.equal(await f.frame.locator('#areaPill').isVisible(), true, 'the pill is still on');
  // the very next message takes a new shot again, with no marks and no flag
  await f.sendQ('Second, no marks');
  const second = await look(f.frame, f.chats()[1].image, [[0.45, 0.45], [0.05, 0.1]]);
  assert.equal('annotated' in f.chats()[1], false);
  assert.ok(isGrey(second.px[0]), 'a fresh shot of the tab');
  assert.ok(near(second.px[1], [0, 160, 0], 40));
  assert.equal(await shares(), 1, 'the tab is still the one share');
  assert.doesNotMatch(await f.frame.locator('.msg.user .tags').last().innerText(), /annotated/);
  await f.sendQ('Third');
  assert.equal(f.chats().length, 3);
  assert.equal('annotated' in f.chats()[2], false);
  assert.match(f.chats()[2].image, /^data:image\/jpeg/);
});

browserTest('stopping before the model answers puts the annotated picture back, marks included', async t => {
  const f = await fixture(t);
  await f.paste();
  await f.open();
  await f.tool('Redact');
  await f.drag([0.3, 0.3], [0.6, 0.6]);
  await f.frame.locator('#inkDone').click();
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
  f.state.hold = (() => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; })();
  await f.q.fill('Please look');
  await f.frame.locator('#sendBtn').click();
  await f.frame.locator('.msg.user').waitFor();
  await f.frame.locator('#sendBtn[aria-label=Stop]').waitFor();
  await f.page.waitForTimeout(450); // a click on Stop right after Send doesn't count
  await f.frame.locator('#sendBtn').click(); // stop
  await f.frame.locator('#att img[src^="data:image"]').waitFor();
  assert.equal(await f.q.inputValue(), 'Please look');
  assert.equal(await f.frame.locator('.msg.user').count(), 0);
  assert.equal(await f.frame.locator('#inkBtn').innerText(), '✏ Edit marks');
  const back = await look(f.frame, null, [[0.45, 0.45]]);
  assert.ok(isBlack(back.px[0]), 'the annotated picture is back');
  await f.open();
  assert.ok(isBlack(await f.px(0.45, 0.45)), 'and its marks can still be edited');
  await f.frame.locator('#inkCancel').click();
  await f.sendQ('Please look');
  assert.equal(f.chats().at(-1).annotated, true, 'sending it again still says annotated');
});

browserTest('a docked 300px panel fits the whole sheet: nothing overflows, the picture and every control are reachable', async t => {
  const f = await fixture(t, { standalone: false, frame: { width: 300, height: 560 }, viewport: { width: 900, height: 700 } });
  await f.paste(900, 600);
  await f.open();
  const sheet = await f.frame.locator('#ink').boundingBox();
  assert.ok(sheet.width <= 300 + 1);
  const bad = await f.frame.evaluate(() => {
    const ink = document.querySelector('#ink'), r = ink.getBoundingClientRect(), out = [];
    for (const e of ink.querySelectorAll('button, canvas, .inkrow, .inkhint')) {
      if (!e.getClientRects().length) continue;
      const b = e.getBoundingClientRect();
      if (b.left < r.left - .5 || b.right > r.right + .5 || b.top < r.top - .5 || b.bottom > r.bottom + .5) out.push((e.id || e.getAttribute('aria-label') || e.className) + ' ' + [b.left, b.right, b.top, b.bottom].map(Math.round));
    }
    return { out, scrollW: ink.scrollWidth, clientW: ink.clientWidth, docW: document.documentElement.scrollWidth };
  });
  assert.deepEqual(bad.out, [], 'every control is inside the panel');
  assert.ok(bad.scrollW <= bad.clientW && bad.docW <= 300, 'no sideways scroll');
  const cv = await f.box();
  assert.ok(cv.width >= 200 && cv.height >= 100, `the picture still has room: ${Math.round(cv.width)}×${Math.round(cv.height)}`);
  // and it works there: draw, done, send
  await f.tool('Arrow'); await f.drag([0.1, 0.8], [0.7, 0.3]);
  await f.frame.locator('#inkDone').click();
  await f.frame.locator('#ink').waitFor({ state: 'hidden' });
  await f.sendQ('Narrow');
  assert.equal(f.chats()[0].annotated, true);
});

browserTest('the big panel (a wide window) centres the tools and the picture fits', async t => {
  const f = await fixture(t, { viewport: { width: 1500, height: 950 } });
  await f.paste(1000, 600);
  await f.open();
  const cv = await f.box();
  assert.ok(cv.width > 600, `a big picture on a big panel: ${Math.round(cv.width)}px`);
  assert.ok(Math.abs(cv.width / cv.height - 1000 / 600) < 0.02);
  await f.tool('Circle'); await f.drag([0.2, 0.2], [0.5, 0.6]);
  assert.ok(isRed(await f.px(0.35, 0.2)) || isRed(await f.px(0.35, 0.203)), 'drawing maps right at this size too');
  // resizing the window refits the picture and keeps the marks where they were
  await f.page.setViewportSize({ width: 700, height: 600 });
  await f.settle(); await f.settle();
  const small = await f.box();
  assert.ok(small.width < cv.width && small.width <= 700);
  assert.ok(isRed(await f.px(0.35, 0.2)) || isRed(await f.px(0.35, 0.203)) || isRed(await f.px(0.35, 0.197)), 'the circle is where it was on the picture');
});

for (const theme of ['ember', 'paper', 'midnight', 'forest', 'dusk', 'sakura', 'terminal', 'pond', 'orbit', 'void', 'arcade', 'glass', 'clear']) {
  browserTest(`the sheet is readable and backed in the ${theme} theme`, async t => {
    const f = await fixture(t, { theme, standalone: false });
    await f.paste();
    await f.open();
    const look = await f.frame.evaluate(() => {
      const css = s => getComputedStyle(document.querySelector(s)), ink = css('#ink');
      return { bg: ink.backgroundColor, blur: ink.backdropFilter || ink.webkitBackdropFilter, visible: [...document.querySelectorAll('body > :not(#ink)')].filter(e => e.id && getComputedStyle(e).visibility === 'visible' && e.getClientRects().length && e.id !== 'drop').map(e => e.id),
        done: css('#inkDone').backgroundColor, text: ink.color, shadow: css('#ink .inkbar b').textShadow };
    });
    const alpha = c => { const m = /rgba?\(([^)]+)\)/.exec(c); const p = m[1].split(',').map(Number); return p.length > 3 ? p[3] : 1; };
    if (theme === 'glass' || theme === 'clear') {
      assert.ok(alpha(look.bg) >= .8, `${theme} gets a real backing (${look.bg})`);
      assert.deepEqual(look.visible, [], 'and the chat doesn’t ghost through it');
      if (theme === 'clear') assert.equal(look.shadow, 'none', 'no halo on top of the backing');
    } else assert.equal(alpha(look.bg), 1, 'opaque');
    assert.ok(alpha(look.done) === 1, 'Done is a solid button');
  });
}

browserTest('the sheet stays still when you prefer reduced motion', async t => {
  const f = await fixture(t, { motion: 'reduce' });
  await f.paste();
  await f.open();
  const d = await f.frame.locator('#ink').evaluate(e => parseFloat(getComputedStyle(e).animationDuration));
  assert.ok(d < 0.01, `animation ${d}s`);
});

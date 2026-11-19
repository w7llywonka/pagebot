import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// The homepage in a real browser, from a fixture (no server): the hint fits the device, every message lands in the hint line,
// and its colours pass contrast in light and dark, read from the page's own tokens.
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
const browserTest = chromium ? test : test.skip;
const ORIGIN = 'https://pagebot.example.test';
const HREF = "javascript:void('pagebot')";
const html = (await readFile(new URL('../public/install.html', import.meta.url), 'utf8'))
  .replace('{{HREF}}', HREF.replaceAll("'", '&#39;')).replace('{{VERSION}}', '14');
const extensionHtml = await readFile(new URL('../public/extension.html', import.meta.url), 'utf8');
let browser;
before(async () => {
  if (chromium) browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); });

async function open(t, { query = '', scheme = 'light', touch = false, viewport, init } = {}) {
  const context = await browser.newContext({
    colorScheme: scheme, ...(touch ? { viewport: viewport || { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: viewport || { width: 1280, height: 800 } }),
  });
  t.after(() => context.close());
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (init) await page.addInitScript(init);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/pagebot-extension.zip') return route.fulfill({ contentType: 'application/zip', headers: { 'Content-Disposition': 'attachment; filename=pagebot-extension.zip' }, body: Buffer.from('PK fixture archive') });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: url.pathname === '/extension' ? extensionHtml : html });
  });
  await page.goto(ORIGIN + '/' + query);
  t.after(() => assert.deepEqual(errors, []));
  return page;
}
const hint = page => page.locator('#hint').innerText();

browserTest('on a computer it says to drag, and a click explains the slip in the hint line', async t => {
  const page = await open(t);
  assert.equal(await hint(page), 'Drag this up to your bookmarks bar.');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('touch')), false);
  await page.locator('#bm').click();
  assert.match(await hint(page), /^Don’t click it, drag it: .*Ctrl\+Shift\+B \(⌘\+Shift\+B on a Mac\)\.$/);
  assert.equal(await page.locator('#hint.up').count(), 1, 'the changed hint stands out');
  assert.equal(new URL(page.url()).pathname, '/', 'clicking it does not run or follow it');
});

browserTest('?update leads with why you are here, and names the new version', async t => {
  const page = await open(t, { query: '?update' });
  assert.equal(await hint(page), 'Time for the new one (v14). Drag this up to your bookmarks bar, then delete the old bookmark.');
  assert.equal(await page.locator('#hint.up').count(), 1);
});

browserTest('on a phone or tablet, where nothing can be dragged, it leads with copying', async t => {
  const page = await open(t, { touch: true });
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('touch')), true);
  assert.equal(await hint(page), 'On a phone or tablet? Copy it, then save it as a bookmark’s address.');
  const box = await page.locator('#copy').boundingBox();
  assert.ok(box.height >= 44, `the copy button is ${box.height}px tall`);
  await page.locator('#bm').tap();
  assert.doesNotMatch(await hint(page), /drag|Ctrl/i, 'a tap does not send a phone back to dragging');
  const upd = await open(t, { touch: true, query: '?update' });
  const steps = 'Time for the new one (v14). Copy it, save it as a bookmark’s address, then delete the old one.';
  assert.equal(await hint(upd), steps);
  await upd.locator('#bm').tap();
  assert.equal(await hint(upd), steps, 'a tap points at the update steps instead of replacing them');
  assert.equal(await upd.locator('#hint.up').count(), 1);
});

browserTest('the button stays put under the pointer when a click makes the hint longer', async t => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 640, height: 400 }]) {
    const page = await open(t, { viewport });
    const top = () => page.locator('#bm').evaluate(el => el.offsetTop); // its place in the layout, without the hover lift
    const before = await top();
    await page.locator('#bm').click();
    await page.waitForSelector('#hint.up');
    const after = await top();
    assert.equal(after, before, `at ${viewport.width}x${viewport.height} the button moved from ${before} to ${after}`);
    const copy = await page.locator('#copy').boundingBox();
    assert.ok(copy.y + copy.height <= viewport.height, 'the copy button is still on screen');
  }
});

browserTest('copying puts the bookmark on the clipboard and the next steps in the hint line', async t => {
  const page = await open(t);
  await page.locator('#copy').click();
  await page.waitForFunction(() => document.querySelector('#copy').textContent === 'Copied');
  assert.equal(await hint(page), 'Copied! Now bookmark any page, edit that bookmark, and paste this in as its address.');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), HREF);
  assert.equal(await page.locator('#bm').innerText(), 'pagebot', 'the bookmark is still named just pagebot');
});

// no clipboard at all: the API refuses and the old copy command does nothing
const noClipboard = () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
  document.execCommand = () => false;
};

browserTest('when copying fails, the hint line says so and what to do instead, and the button still names its action', async t => {
  for (const touch of [false, true]) {
    const page = await open(t, { touch, init: noClipboard });
    await page.locator('#copy').click();
    await page.waitForSelector('#hint.up');
    assert.equal(await hint(page), touch ? 'Couldn’t copy it here. Try another browser, or drag the button on a computer.'
      : 'Couldn’t copy it here. Drag the button up to your bookmarks bar instead.');
    assert.equal(await page.locator('#hint').getAttribute('role'), 'status', 'the failure is announced');
    assert.equal(await page.locator('#copy').innerText(), 'Try copying again');
  }
});

browserTest('every colour pair passes contrast, light and dark, from the page’s own tokens', async t => {
  for (const scheme of ['light', 'dark']) for (const touch of [false, true]) {
    const page = await open(t, { scheme, touch });
    await page.emulateMedia({ reducedMotion: 'reduce' }); // no transitions: read each state's final colours
    const css = (sel, prop) => page.evaluate(([sel, prop]) => getComputedStyle(document.querySelector(sel))[prop], [sel, prop]);
    // the states as drawn: keyboard focus, hover, and the emphasised hint after a click or tap
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => document.activeElement.id === 'bm' && getComputedStyle(document.activeElement).outlineColor);
    assert.ok(ring, 'Tab reaches the button first');
    await page.keyboard.press('Tab');
    const copyRing = await page.evaluate(() => document.activeElement.id === 'copy' && getComputedStyle(document.activeElement).outlineColor);
    assert.ok(copyRing, 'then the copy button');
    await page.evaluate(() => document.activeElement.blur());
    const drawn = { ring, copyRing };
    if (!touch) {
      await page.hover('#bm');
      drawn.hoverLabel = await css('#bm', 'color'); drawn.hoverFill = await css('#bm', 'backgroundColor');
      await page.hover('#copy');
      drawn.copyHoverLabel = await css('#copy', 'color'); drawn.copyHoverFill = await css('#copy', 'backgroundColor');
      await page.mouse.move(0, 0);
    }
    await page.locator('#bm').click();
    await page.waitForSelector('#hint.up');
    drawn.upHint = await css('#hint', 'color');
    await page.mouse.move(0, 0); // and the rest at rest, not hovered
    await page.evaluate(() => document.querySelector('#hint').classList.remove('up'));
    const failures = await page.evaluate(({ scheme, touch, drawn }) => {
      const rgb = c => { const m = /rgba?\(([^)]+)\)/.exec(c); return m[1].split(',').map(Number); };
      const lum = c => { const [r, g, b] = rgb(c).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
      const bg = css('body', 'backgroundColor');
      const pairs = [
        ['hint text on the page', css('#hint', 'color'), bg, 4.5],
        ['emphasised hint on the page', drawn.upHint, bg, 4.5],
        ['button label on the button', css('#bm', 'color'), css('#bm', 'backgroundColor'), 4.5],
        ['the button against the page', css('#bm', 'backgroundColor'), bg, 3],
        ['the focus ring on the button against the page', drawn.ring, bg, 3],
        ['the focus ring on the copy button against the page', drawn.copyRing, bg, 3],
        ...(touch ? [
          ['copy label on its fill', css('#copy', 'color'), css('#copy', 'backgroundColor'), 4.5],
          ['copy label on the page', css('#copy', 'color'), bg, 4.5],
          // with no border, its edge is wherever its fill meets the page
          ['the copy button’s edge against the page', parseFloat(css('#copy', 'borderTopWidth')) ? css('#copy', 'borderTopColor') : css('#copy', 'backgroundColor'), bg, 3],
        ] : [
          ['button label on the hovered button', drawn.hoverLabel, drawn.hoverFill, 4.5],
          ['copy link on the page', css('#copy', 'color'), bg, 4.5],
          ['hovered copy link on its tinted fill', drawn.copyHoverLabel, drawn.copyHoverFill, 4.5],
        ]),
      ];
      return pairs.filter(([, a, b, need]) => !(ratio(a, b) >= need))
        .map(([what, a, b, need]) => `${scheme}${touch ? ' touch' : ''}: ${what} is ${ratio(a, b).toFixed(2)}:1, needs ${need}:1`);
    }, { scheme, touch, drawn });
    assert.deepEqual(failures, []);
  }
});


browserTest('the site extension option opens setup, switches browser instructions and downloads the ZIP', async t => {
  const page = await open(t);
  await page.getByRole('link', { name: 'Get the extension' }).click();
  assert.equal(new URL(page.url()).pathname, '/extension');
  assert.equal(await page.locator('h1').innerText(), 'Keep pagebot beside your page.');
  assert.equal(await page.locator('#extensionsAddress').innerText(), 'chrome://extensions');
  await page.getByRole('button', { name: 'Edge', exact: true }).click();
  assert.equal(await page.locator('#extensionsAddress').innerText(), 'edge://extensions');
  assert.equal(await page.locator('#edgeChoice').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Copy address', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#copyAddress').textContent === 'Copied');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'edge://extensions');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download extension ZIP' }).click(),
  ]);
  assert.equal(download.suggestedFilename(), 'pagebot-extension.zip');
  assert.equal(new URL(download.url()).pathname, '/pagebot-extension.zip');
  // (Chromium cancels a download that the fixture fulfils, so the address is fetched to see what it serves)
  assert.equal(await page.evaluate(async u => (await (await fetch(u)).text()).slice(0, 2), download.url()), 'PK', 'the link’s address serves the zip');
  assert.equal(await page.locator('.steps li').count(), 4);
  assert.match(await page.locator('.steps').innerText(), /Load unpacked/);
  assert.match(await page.locator('.steps').innerText(), /manifest.json/);
});

browserTest('the extension guide fits a narrow screen and leaves browser addresses copyable if clipboard access fails', async t => {
  const page = await open(t, { viewport: { width: 390, height: 844 }, init: noClipboard });
  await page.getByRole('link', { name: 'Get the extension' }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling');
  await page.getByRole('button', { name: 'Copy address', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#copyStatus').textContent.includes('Select the address'));
  assert.equal(await page.locator('#extensionsAddress').innerText(), 'chrome://extensions');
  assert.equal(await page.locator('#copyStatus').getAttribute('role'), 'status');
  assert.equal(await page.locator('#downloadExtension').isVisible(), true);
});

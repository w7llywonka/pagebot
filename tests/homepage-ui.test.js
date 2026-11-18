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
let browser;
before(async () => {
  if (chromium) browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); });

async function open(t, { query = '', scheme = 'light', touch = false } = {}) {
  const context = await browser.newContext({
    colorScheme: scheme, ...(touch ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } }),
  });
  t.after(() => context.close());
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.request().url().startsWith(ORIGIN + '/')
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort());
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
  assert.equal(await hint(upd), 'Time for the new one (v14). Copy it, save it as a bookmark’s address, then delete the old one.');
});

browserTest('copying puts the bookmark on the clipboard and the next steps in the hint line', async t => {
  const page = await open(t);
  await page.locator('#copy').click();
  await page.waitForFunction(() => document.querySelector('#copy').textContent === 'Copied');
  assert.equal(await hint(page), 'Copied! Now bookmark any page, edit that bookmark, and paste this in as its address.');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), HREF);
  assert.equal(await page.locator('#bm').innerText(), 'pagebot', 'the bookmark is still named just pagebot');
});

browserTest('every colour pair passes contrast, light and dark, from the page’s own tokens', async t => {
  for (const scheme of ['light', 'dark']) for (const touch of [false, true]) {
    const page = await open(t, { scheme, touch });
    const failures = await page.evaluate(({ scheme, touch }) => {
      const rgb = c => { const m = /rgba?\(([^)]+)\)/.exec(c); return m[1].split(',').map(Number); };
      const lum = c => { const [r, g, b] = rgb(c).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
      const tok = name => { const s = document.createElement('i'); s.style.color = `var(${name})`; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; };
      const bg = css('body', 'backgroundColor');
      const pairs = [
        ['hint text on the page', css('#hint', 'color'), bg, 4.5],
        ['emphasised hint on the page', tok('--ink'), bg, 4.5],
        ['button label on the button', css('#bm', 'color'), css('#bm', 'backgroundColor'), 4.5],
        ['button label on the hovered button', tok('--on-btn'), tok('--btn-h'), 4.5],
        ['the button against the page', css('#bm', 'backgroundColor'), bg, 3],
        ['the focus ring against the page', tok('--ink'), bg, 3],
        ['copy link on the page', touch ? css('#copy', 'color') : tok('--muted'), bg, 4.5],
        ['copy link on its tinted fill', tok('--ink'), tok('--tint'), 4.5],
      ];
      return pairs.filter(([, a, b, need]) => !(ratio(a, b) >= need))
        .map(([what, a, b, need]) => `${scheme}${touch ? ' touch' : ''}: ${what} is ${ratio(a, b).toFixed(2)}:1, needs ${need}:1`);
    }, { scheme, touch });
    assert.deepEqual(failures, []);
  }
});

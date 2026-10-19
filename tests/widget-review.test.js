import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// Regressions found by reviewing the panel after chat history, slash commands, PDF uploads and page actions were merged.
// Playwright with a local Chromium; every HTTP response is a fixture.
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

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n', 'latin1');
const boot = (theme, prefs) => ({
  authed: true, who: 'user', theme, lockMinutes: 0, version: 9,
  user: { id: 1, name: 'Reader', status: 'trusted', allowWeb: true, allowPdf: true, allowActions: true, passcode: false },
  prefs: { theme, model: 'haiku', web: false, actions: false, ...prefs },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku 5.5' }, { key: 'sonnet', label: 'Sonnet 5.5' }],
});
const CHATS = [1, 2, 3].map(id => ({ id, title: `Chat ${id}`, site: 'news.example.test', url: 'https://news.example.test/a', updatedAt: new Date().toISOString() }));

async function fixture(t, { width = 440, theme = 'ember', prefs } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1000, height: 900 } });
  context.setDefaultTimeout(5000);
  const errors = [];
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'the widget must not raise browser errors or make unexpected requests'); });
  await context.addInitScript(() => localStorage.setItem('pb_token', 'test-session'));
  const hostPage = `<!doctype html><html><body><script>
      addEventListener('message', event => {
        if (event.source !== document.querySelector('iframe')?.contentWindow) return;
        const r = event.data;
        if (r.type === 'page') event.source.postMessage({ id: r.id, page: { url: 'https://news.example.test/a', title: 'Article', text: 'From the page' }, selection: '' }, event.origin);
      });
    </script><iframe title="Pagebot" src="https://pagebot.example.test/widget?v=9" style="width:${width}px;height:700px;border:0"></iframe></body></html>`;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: hostPage });
    if (url.pathname === '/widget') return route.fulfill({ contentType: 'text/html', body: widget });
    if (url.pathname === '/api/pdf') return json({ id: 7, name: url.searchParams.get('name'), size: PDF.length, pages: 3, tokens: 7500 });
    if (url.pathname === '/api/boot') return json(boot(theme, prefs));
    if (url.pathname === '/api/chats') return json({ chats: CHATS, next: null });
    errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://news.example.test/article');
  const frame = page.frames().find(f => f.url().startsWith('https://pagebot.example.test/'));
  await frame.locator('#q').waitFor({ state: 'visible' });
  await frame.locator('#boot').waitFor({ state: 'detached' });
  return { page, frame };
}

// every visible pill, the + button, the model name and send, as boxes
const composerBoxes = frame => frame.evaluate(() => {
  const box = el => { const r = el.getBoundingClientRect(); return { id: el.id, l: r.left, r: r.right, t: r.top, b: r.bottom }; };
  return {
    outer: box(document.querySelector('.box')),
    pills: [...document.querySelectorAll('.pills > *')].filter(e => !e.hidden).map(box),
    others: ['#addBtn', '#modelBtn', '#sendBtn'].map(s => box(document.querySelector(s))),
  };
});
const overlap = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;

browserTest('the pills (PDF, page, highlight, web, actions) wrap in a narrow panel: all show, none overlap', async t => {
  const { page, frame } = await fixture(t, { width: 300, prefs: { web: true, actions: true } });
  await frame.locator('#addBtn').click();
  const chooser = page.waitForEvent('filechooser');
  await frame.locator('#pdfBtn').click();
  await (await chooser).setFiles({ name: 'Q3 report.pdf', mimeType: 'application/pdf', buffer: PDF });
  await frame.locator('#pdfPill:not([hidden]) .pi:text("📄")').waitFor();
  await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ type: 'sel', text: 'A highlighted passage from the page' }, '*'));
  await frame.locator('#selPill:not([hidden])').waitFor();
  await frame.waitForFunction(() => document.querySelector('.bar').classList.contains('stack')); // fitPills runs on the next frame
  const { outer, pills, others } = await composerBoxes(frame);
  assert.equal(pills.length, 5, 'PDF, page, highlight, web and actions pills are all there');
  for (const p of pills) assert.ok(p.l >= outer.l - 0.5 && p.r <= outer.r + 0.5, `${p.id} stays inside the message box`);
  for (const [i, p] of pills.entries()) {
    for (const q of pills.slice(i + 1)) assert.equal(overlap(p, q), false, `${p.id} and ${q.id} don't overlap`);
    for (const o of others) assert.equal(overlap(p, o), false, `${p.id} doesn't cover ${o.id}`);
  }
  assert.ok(await frame.locator('#pdfPill .pl').evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'the PDF name is shown, not squeezed to a few letters');
});

browserTest('a few pills stay on the same line as the buttons in a normal panel', async t => {
  const { frame } = await fixture(t, { width: 440, prefs: { web: true } });
  await frame.waitForFunction(() => !!document.querySelector('.bar'));
  const { pills, others } = await composerBoxes(frame);
  assert.equal(pills.length, 2, 'page and web');
  assert.equal(await frame.locator('.bar').evaluate(e => e.classList.contains('stack')), false);
  assert.ok(Math.abs(pills[0].t - others[0].t) < 12, 'beside the + button');
});

for (const theme of ['glass', 'clear']) browserTest(`the history sheet in ${theme} hides the chat behind it, so nothing shows between the rows`, async t => {
  const { frame } = await fixture(t, { theme });
  await frame.locator('#q').fill('/'); // the chat has things on it (the empty-chat text and starters)
  await frame.locator('#histBtn').click();
  await frame.locator('.hrow').first().waitFor();
  await frame.waitForFunction(() => ['#log', '#composer'].every(s => getComputedStyle(document.querySelector(s)).visibility === 'hidden'), null, { timeout: 3000 }); // the chat is hidden behind the sheet
  const alpha = await frame.locator('#hist').evaluate(e => +(getComputedStyle(e).backgroundColor.match(/rgba?\(([^)]+)\)/)[1].split(',')[3] ?? 1));
  assert.ok(alpha >= 0.8, 'the sheet has a backing, so the page behind a clear panel doesn’t cross the rows');
  await frame.locator('#histBtn').click();
  await frame.waitForFunction(() => getComputedStyle(document.querySelector('#log')).visibility === 'visible'); // (a transition under reduced motion lasts a frame)
  assert.equal(await frame.locator('#histBtn').getAttribute('aria-expanded'), 'false', 'closing history brings the chat back');
});

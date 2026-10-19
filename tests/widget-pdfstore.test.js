import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// The "Your PDFs" sheet in the panel (stored PDFs, the storage bar, deleting), with Playwright and a local Chromium. Every HTTP response is a fixture.
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
const MB = 1048576;
const boot = (theme = 'ember', user = {}) => ({
  authed: true, who: 'user', theme, lockMinutes: 0, version: 8,
  user: { id: 1, name: 'Reader', status: 'trusted', allowWeb: true, allowPdf: true, passcode: false, ...user },
  prefs: { theme, model: 'haiku', web: false },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku 5.5' }, { key: 'sonnet', label: 'Sonnet 5.5' }, { key: 'openrouter', label: 'Muse Spark 1.3' }],
});
const done = { t: 'done', conversationId: 42, model: 'Haiku 5.5', usage: { in: 50, out: 20 }, stop: 'end_turn' };
const stored = () => [
  { id: 11, name: 'Q3 report with a really quite long file name that has to be cut off somewhere.pdf', size: 3.5 * MB, pages: 12, createdAt: '2026-10-01T12:00:00Z', inChat: true, chatId: 42, chatTitle: 'What happened to revenue?' },
  { id: 10, name: 'notes.pdf', size: 0.25 * MB, pages: 2, createdAt: '2026-09-20T12:00:00Z', inChat: false, chatId: null, chatTitle: null },
];

async function fixture(t, { standalone = false, theme = 'ember', pdfs = stored(), cap = 10 * MB, upload, size = { width: 1000, height: 900 }, frameW = 440 } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: size });
  context.setDefaultTimeout(5000);
  const state = { requests: [], errors: [], pdfs: pdfs.map(p => ({ ...p })), deleteStatus: 200 };
  t.after(async () => {
    await context.close();
    assert.deepEqual(state.errors, [], 'the widget must not raise browser errors or make unexpected requests');
  });
  await context.addInitScript(() => localStorage.setItem('pb_token', 'test-session'));
  const used = () => state.pdfs.reduce((n, p) => n + p.size, 0);
  const hostPage = `<!doctype html><html><body><script>
      addEventListener('message', event => {
        if (event.source !== document.querySelector('iframe')?.contentWindow) return;
        const request = event.data;
        if (request.type === 'page') event.source.postMessage({ id: request.id, page: { url: 'https://news.example.test/a', title: 'Article', text: 'From the page' }, selection: '' }, event.origin);
      });
    </script><iframe title="Pagebot" src="https://pagebot.example.test/widget?v=8" style="width:${frameW}px;height:840px;border:0"></iframe></body></html>`;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: hostPage });
    if (url.pathname === '/widget' || url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    if (url.pathname === '/api/pdf' && method === 'POST') {
      const body = request.postDataBuffer(), name = url.searchParams.get('name');
      state.requests.push({ path: url.pathname, method, name });
      const [status, value] = upload ? upload({ name, body }) : [200, { id: 7, name, size: body.length, pages: 3, tokens: 7500 }];
      if (status === 200) state.pdfs.unshift({ id: value.id, name, size: value.size, pages: value.pages, createdAt: new Date().toISOString(), inChat: false, chatId: null, chatTitle: null });
      return json(value, status);
    }
    state.requests.push({ path: url.pathname, method, body: method === 'POST' ? request.postDataJSON() : undefined });
    if (url.pathname === '/api/boot') return json(boot(theme));
    if (url.pathname === '/api/pdf' && method === 'GET') return json({ used: used(), cap, pdfs: state.pdfs });
    const del = /^\/api\/pdf\/(\d+)$/.exec(url.pathname);
    if (del && method === 'DELETE') {
      const p = state.pdfs.find(x => x.id === +del[1]);
      if (state.deleteStatus !== 200) return json({ error: 'Server trouble.' }, state.deleteStatus);
      if (!p) return json({ error: 'That PDF isn’t stored anymore.' }, 404);
      state.pdfs = state.pdfs.filter(x => x !== p);
      return json({ ok: true, used: used(), cap });
    }
    if (url.pathname === '/api/chats' && method === 'GET') return json({ chats: [{ id: 42, title: 'What happened to revenue?', site: 'news.example.test', url: null, pageTitle: null, createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z' }], next: null });
    if (url.pathname === '/api/chats/42') return json({ chat: { id: 42, createdAt: '2026-10-01T12:00:00Z', url: null, site: null }, earlier: false, messages: [
      { role: 'user', text: 'First file', pdf: { id: 21, name: 'a.pdf', pages: 1, gone: false } }, { role: 'assistant', text: 'Fine.', model: 'Haiku 5.5', usage: { in: 5, out: 5 }, sources: [] },
      { role: 'user', text: 'Second file', pdf: { id: 22, name: 'b.pdf', pages: 1, gone: false } }, { role: 'assistant', text: 'Fine.', model: 'Haiku 5.5', usage: { in: 5, out: 5 }, sources: [] }] });
    if (url.pathname === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
    if (url.pathname === '/api/prefs') return json({ prefs: { ...boot().prefs, ...request.postDataJSON() }, limits: boot().limits });
    if (url.pathname === '/api/chat') return route.fulfill({
      contentType: 'application/x-ndjson',
      body: [{ t: 'id', conversationId: 42 }, { t: 'd', v: 'Revenue grew.' }, done].map(e => JSON.stringify(e)).join('\n') + '\n',
    });
    state.errors.push(`Unexpected request: ${method} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  await page.goto(standalone ? 'https://pagebot.example.test/chat' : 'https://news.example.test/article');
  const frame = standalone ? page.mainFrame() : page.frames().find(f => f.url().startsWith('https://pagebot.example.test/'));
  await frame.locator('#q').waitFor({ state: 'visible' });
  await frame.locator('#boot').waitFor({ state: 'detached' });
  const openFromMenu = async () => { await frame.locator('#addBtn').click(); await frame.locator('#pdfManage').click(); await frame.locator('#pdfs').waitFor({ state: 'visible' }); };
  return { page, frame, state, openFromMenu };
}
const rowsOf = f => f.frame.locator('#pdfList .prow');

browserTest('the + menu opens Your PDFs: name, pages, size, date, a used-of-cap bar, and Delete asks first', async t => {
  const f = await fixture(t);
  await f.openFromMenu();
  assert.equal(await f.frame.locator('#addMenu').isVisible(), false, 'the menu closes');
  assert.equal(await f.frame.locator('.phead b').innerText(), 'Your PDFs');
  assert.equal(await f.frame.locator('#pdfUsed').innerText(), '3.8 MB of 10.0 MB used');
  assert.equal(await f.frame.locator('#pdfStore .qbar').getAttribute('aria-valuenow'), '38');
  assert.equal(await rowsOf(f).count(), 2);
  const first = rowsOf(f).first();
  assert.match(await first.innerText(), /Q3 report with a really quite long[\s\S]*12 p\. · 3\.5 MB · Oct 1[\s\S]*In chat: What happened to revenue\?/);
  assert.match(await rowsOf(f).nth(1).innerText(), /notes\.pdf[\s\S]*2 p\. · 0\.25 MB · Sep 20[\s\S]*Not sent in a chat yet/);
  // a long name is cut off, never pushing Delete out of the panel
  const fits = await f.frame.evaluate(() => { const s = document.querySelector('#pdfs').getBoundingClientRect(), d = document.querySelector('#pdfList .prow button').getBoundingClientRect(); return d.right <= s.right && d.left >= s.left; });
  assert.equal(fits, true, 'Delete stays inside the panel');

  // Cancel keeps it; Delete asks, then goes through
  await rowsOf(f).nth(1).getByRole('button', { name: /Delete/ }).click();
  assert.match(await rowsOf(f).nth(1).innerText(), /Delete this PDF\?\s*This can’t be undone\./);
  await rowsOf(f).nth(1).getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await rowsOf(f).count(), 2);
  assert.equal(f.state.requests.some(r => r.method === 'DELETE'), false, 'nothing was asked of the server');
  await rowsOf(f).nth(1).getByRole('button', { name: /Delete/ }).click();
  await rowsOf(f).nth(1).getByRole('button', { name: 'Delete', exact: true }).click();
  await f.frame.waitForFunction(() => document.querySelectorAll('#pdfList .prow').length === 1);
  assert.deepEqual(f.state.requests.filter(r => r.method === 'DELETE').map(r => r.path), ['/api/pdf/10']);
  assert.equal(await f.frame.locator('#pdfUsed').innerText(), '3.5 MB of 10.0 MB used');
  assert.equal(await f.frame.locator('#pdfStore .qbar').getAttribute('aria-valuenow'), '35');

  // the one in a chat says what happens to the chat; the last one gone leaves the empty state
  await rowsOf(f).first().getByRole('button', { name: /Delete/ }).click();
  assert.match(await rowsOf(f).first().innerText(), /The chat keeps its messages/);
  await rowsOf(f).first().getByRole('button', { name: 'Delete', exact: true }).click();
  await f.frame.locator('#pdfList .hstate', { hasText: 'No PDFs stored.' }).waitFor();
  assert.equal(await f.frame.locator('#pdfUsed').innerText(), '0.00 MB of 10.0 MB used');

  await f.frame.locator('#pdfsDone').click();
  assert.equal(await f.frame.locator('#pdfs').isVisible(), false);
  assert.equal(await f.frame.locator('#q').isVisible(), true);
});

browserTest('a failed delete says so and can be retried; an already-gone PDF just leaves the list; Esc backs out', async t => {
  const f = await fixture(t);
  await f.openFromMenu();
  f.state.deleteStatus = 500;
  await rowsOf(f).nth(1).getByRole('button', { name: /Delete/ }).click();
  await rowsOf(f).nth(1).getByRole('button', { name: 'Delete', exact: true }).click();
  await rowsOf(f).nth(1).locator('p', { hasText: 'Couldn’t delete it: Server trouble.' }).waitFor();
  assert.equal(await rowsOf(f).count(), 2);
  f.state.deleteStatus = 200;
  f.state.pdfs = f.state.pdfs.filter(p => p.id !== 10); // deleted on another device meanwhile
  await rowsOf(f).nth(1).getByRole('button', { name: 'Delete', exact: true }).click();
  await f.frame.waitForFunction(() => document.querySelectorAll('#pdfList .prow').length === 1);
  await rowsOf(f).first().getByRole('button', { name: /Delete/ }).click();
  await f.page.keyboard.press('Escape');
  assert.match(await rowsOf(f).first().innerText(), /Q3 report/, 'Esc cancels the question first');
  assert.equal(await rowsOf(f).first().getByRole('button', { name: 'Delete' }).count(), 1);
  await f.page.keyboard.press('Escape');
  assert.equal(await f.frame.locator('#pdfs').isVisible(), false, 'and then closes the sheet, not the panel');
  assert.equal(await f.frame.locator('#q').isVisible(), true);
});

browserTest('the history sheet has a Manage your PDFs link, and the sheets swap', async t => {
  const f = await fixture(t);
  await f.frame.locator('#histBtn').click();
  await f.frame.locator('#histList .hfoot .plink', { hasText: 'Manage your PDFs' }).click();
  await f.frame.locator('#pdfs').waitFor({ state: 'visible' });
  assert.equal(await f.frame.locator('#hist').isVisible(), false);
  await f.frame.locator('#histBtn').click();
  assert.equal(await f.frame.locator('#pdfs').isVisible(), false, 'history takes its place');
  await f.frame.locator('#hist .plink', { hasText: 'Manage your PDFs' }).click();
  await f.frame.locator('#setBtn').click();
  assert.equal(await f.frame.locator('#pdfs').isVisible(), false, 'so does Settings');
  assert.equal(await f.frame.locator('#sheet').isVisible(), true);
  assert.equal(await f.frame.locator('#sheet', { hasText: 'Your PDFs' }).count(), 0, 'and Settings has nothing about PDF storage');
});

browserTest('when the cap is reached the upload note has a Manage PDFs button that opens the list', async t => {
  const f = await fixture(t, { standalone: true, upload: () => [413, { storage: true, used: 9.9 * MB, cap: 10 * MB, error: 'You have 9.9 MB of PDFs stored, out of 10.0 MB, and this one is 1.2 MB. Delete a PDF you’re done with to make room.' }] });
  await f.frame.locator('#pdfFile').setInputFiles({ name: 'big.pdf', mimeType: 'application/pdf', buffer: PDF });
  const note = f.frame.locator('.note', { hasText: 'Couldn’t add “big.pdf”: You have 9.9 MB of PDFs stored' });
  await note.waitFor();
  assert.match(await note.innerText(), /Delete a PDF you’re done with to make room\.\s*Manage PDFs$/);
  assert.equal(await f.frame.locator('#pdfPill').isVisible(), false);
  await note.getByRole('button', { name: 'Manage PDFs' }).click();
  await f.frame.locator('#pdfs').waitFor({ state: 'visible' });
  assert.equal(await rowsOf(f).count(), 2);
});

browserTest('deleting the PDF that is on the composer pill clears the pill', async t => {
  const f = await fixture(t, { pdfs: [] });
  await f.frame.locator('#pdfFile').setInputFiles({ name: 'slides.pdf', mimeType: 'application/pdf', buffer: PDF });
  await f.frame.locator('#pdfPill .pl:text("slides.pdf · 3 p.")').waitFor();
  await f.openFromMenu();
  assert.match(await rowsOf(f).first().innerText(), /slides\.pdf[\s\S]*Not sent in a chat yet/);
  await rowsOf(f).first().getByRole('button', { name: /Delete/ }).click();
  await rowsOf(f).first().getByRole('button', { name: 'Delete', exact: true }).click();
  await f.frame.locator('#pdfList .hstate').waitFor();
  assert.equal(await f.frame.locator('#pdfPill').isVisible(), false, 'it would only fail on send');
  await f.frame.locator('#pdfsDone').click();
  await f.frame.locator('#q').fill('Anything?');
  await f.frame.locator('#sendBtn').click();
  await f.frame.locator('.msg.bot .meta').waitFor();
  assert.equal(f.state.requests.find(r => r.path === '/api/chat').body.pdf, undefined, 'and isn’t sent with the question');
});

browserTest('deleting the PDF of the open chat greys its chip and lets ◆ answer that chat again', async t => {
  const f = await fixture(t, { pdfs: [] });
  await f.frame.locator('#pdfFile').setInputFiles({ name: 'slides.pdf', mimeType: 'application/pdf', buffer: PDF });
  await f.frame.locator('#pdfPill .pl:text("slides.pdf · 3 p.")').waitFor();
  await f.frame.locator('#q').fill('What happened to revenue?');
  await f.frame.locator('#sendBtn').click();
  await f.frame.locator('.msg.bot .meta').waitFor();
  f.state.pdfs[0].inChat = true; f.state.pdfs[0].chatId = 42; f.state.pdfs[0].chatTitle = 'What happened to revenue?'; // the server has put it in the chat
  const router = f.frame.locator('#modelMenu button', { hasText: 'Muse Spark' });
  assert.equal(await router.isDisabled(), true, 'with the PDF in the chat, ◆ is out');
  assert.equal(await f.frame.locator('.msg.user .fchip.gone').count(), 0);

  await f.openFromMenu();
  await rowsOf(f).first().getByRole('button', { name: /Delete/ }).click();
  await rowsOf(f).first().getByRole('button', { name: 'Delete', exact: true }).click();
  await f.frame.locator('#pdfList .hstate').waitFor();
  await f.frame.locator('#pdfsDone').click();
  const chip = f.frame.locator('.msg.user .fchip');
  assert.match(await chip.innerText(), /📄\s*slides\.pdf\s*· no longer available/);
  assert.equal(await chip.evaluate(c => c.classList.contains('gone')), true);
  assert.equal(await router.isDisabled(), false, 'nothing in the chat needs a PDF-reading model now');
});

browserTest('a reopened chat with two PDFs keeps ◆ out until both are deleted', async t => {
  const f = await fixture(t, { pdfs: [
    { id: 21, name: 'a.pdf', size: MB, pages: 1, createdAt: '2026-10-01T12:00:00Z', inChat: true, chatId: 42, chatTitle: 'Two files' },
    { id: 22, name: 'b.pdf', size: MB, pages: 1, createdAt: '2026-10-01T12:00:00Z', inChat: true, chatId: 42, chatTitle: 'Two files' }] });
  await f.frame.locator('#histBtn').click();
  await f.frame.locator('#histList .hopen').click();
  await f.frame.locator('.msg.user .fchip').first().waitFor();
  assert.equal(await f.frame.locator('.msg.user .fchip').count(), 2);
  const router = f.frame.locator('#modelMenu button', { hasText: 'Muse Spark' });
  assert.equal(await router.isDisabled(), true);
  await f.openFromMenu();
  const remove = async n => {
    await rowsOf(f).first().getByRole('button', { name: /Delete/ }).click();
    await rowsOf(f).first().getByRole('button', { name: 'Delete', exact: true }).click();
    await f.frame.waitForFunction(k => document.querySelectorAll('#pdfList .prow').length === k, n);
  };
  await remove(1);
  assert.equal(await router.isDisabled(), true, 'one file is still in the chat');
  assert.equal(await f.frame.locator('.msg.user .fchip.gone').count(), 1);
  await remove(0);
  assert.equal(await router.isDisabled(), false);
  assert.equal(await f.frame.locator('.msg.user .fchip.gone').count(), 2);
});

for (const theme of ['glass', 'clear', 'paper', 'midnight']) {
  browserTest(`the sheet reads well in the ${theme} theme, framed and narrow`, async t => {
    const f = await fixture(t, { theme, frameW: 300 });
    await f.openFromMenu();
    const sheet = f.frame.locator('#pdfs');
    const css = await sheet.evaluate(el => { const s = getComputedStyle(el); return { bg: s.backgroundColor, pos: s.position }; });
    assert.equal(css.pos, 'absolute');
    if (theme !== 'glass' && theme !== 'clear') assert.notEqual(css.bg, 'rgba(0, 0, 0, 0)', 'an opaque sheet over the chat');
    else assert.ok(await sheet.evaluate(el => getComputedStyle(el).backdropFilter !== 'none' || getComputedStyle(el).webkitBackdropFilter !== 'none'), 'glass blurs what is behind');
    if (theme === 'clear') assert.equal(await f.frame.locator('#composer').evaluate(el => getComputedStyle(el).visibility), 'hidden', 'nothing shows through the clear panel');
    const box = await sheet.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.left, width: r.width }; }), rows = await rowsOf(f).evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right]; }));
    for (const [l, r] of rows) assert.ok(l >= box.x - 1 && r <= box.x + box.width + 1, 'rows fit the panel');
    for (const row of await rowsOf(f).all()) assert.equal(await row.getByRole('button', { name: /Delete/ }).isVisible(), true);
  });
}

browserTest('works on /chat and in a popup-sized window', async t => {
  const f = await fixture(t, { standalone: true, size: { width: 360, height: 640 } });
  await f.openFromMenu();
  assert.equal(await rowsOf(f).count(), 2);
  const box = await f.frame.locator('#pdfList').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 360);
  await rowsOf(f).first().getByRole('button', { name: /Delete/ }).click();
  await rowsOf(f).first().getByRole('button', { name: 'Delete', exact: true }).click();
  await f.frame.waitForFunction(() => document.querySelectorAll('#pdfList .prow').length === 1);
});

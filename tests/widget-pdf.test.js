import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// PDF uploads in the panel, with Playwright and a local Chromium. Every HTTP response is a fixture.
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
const boot = (user = {}) => ({
  authed: true, who: 'user', theme: 'ember', lockMinutes: 0, version: 8,
  user: { id: 1, name: 'Reader', status: 'trusted', allowWeb: true, allowPdf: true, passcode: false, ...user },
  prefs: { theme: 'ember', model: 'haiku', web: false },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku 5.5' }, { key: 'sonnet', label: 'Sonnet 5.5' }, { key: 'openrouter', label: 'Muse Spark 1.3' }],
});
const done = { t: 'done', conversationId: 42, model: 'Haiku 5.5', usage: { in: 50, out: 20 }, stop: 'end_turn' };

async function fixture(t, { standalone = false, user, prefs, events, upload } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1000, height: 900 } });
  context.setDefaultTimeout(5000);
  const state = { requests: [], uploads: [], errors: [] };
  t.after(async () => {
    await context.close();
    assert.deepEqual(state.errors, [], 'the widget must not raise browser errors or make unexpected requests');
  });
  await context.addInitScript(() => localStorage.setItem('pb_token', 'test-session'));
  const hostPage = `<!doctype html><html><body><script>
      window.hostRequests = [];
      addEventListener('message', event => {
        if (event.source !== document.querySelector('iframe')?.contentWindow) return;
        const request = event.data; window.hostRequests.push(request);
        if (request.type === 'page') event.source.postMessage({ id: request.id, page: { url: 'https://news.example.test/a', title: 'Article', text: 'From the page' }, selection: '' }, event.origin);
      });
    </script><iframe title="Pagebot" src="https://pagebot.example.test/widget?v=8" style="width:440px;height:840px;border:0"></iframe></body></html>`;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: hostPage });
    if (url.pathname === '/widget' || url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    if (url.pathname === '/api/pdf') {
      const body = request.postDataBuffer();
      state.uploads.push({ name: url.searchParams.get('name'), type: request.headers()['content-type'], auth: request.headers().authorization, body });
      const [status, value] = upload ? upload(state.uploads.at(-1)) : [200, { id: 7, name: url.searchParams.get('name'), size: body.length, pages: 3, tokens: 7500 }];
      return json(value, status);
    }
    state.requests.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
    if (url.pathname === '/api/boot') return json({ ...boot(user), ...(prefs && { prefs: { ...boot().prefs, ...prefs } }) });
    if (url.pathname === '/api/prefs') return json({ prefs: { ...boot().prefs, ...request.postDataJSON() }, limits: boot().limits });
    if (url.pathname === '/api/chat') return route.fulfill({
      contentType: 'application/x-ndjson',
      body: (events || [{ t: 'id', conversationId: 42 }, { t: 'd', v: 'Revenue grew.' }, done]).map(e => JSON.stringify(e)).join('\n') + '\n',
    });
    state.errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  await page.goto(standalone ? 'https://pagebot.example.test/chat' : 'https://news.example.test/article');
  const frame = standalone ? page.mainFrame() : page.frames().find(f => f.url().startsWith('https://pagebot.example.test/'));
  await frame.locator('#q').waitFor({ state: 'visible' });
  await frame.locator('#boot').waitFor({ state: 'detached' });
  const file = (name, type, text) => frame.evaluateHandle(([name, type, text]) => {
    const d = new DataTransfer(); d.items.add(new File([text], name, { type })); return d;
  }, [name, type, text]);
  const drag = async (dt, drop = true) => {
    for (const type of ['dragenter', 'dragover']) await frame.locator('#log').dispatchEvent(type, { dataTransfer: dt });
    await frame.locator('#drop').waitFor({ state: 'visible' });
    if (drop) await frame.locator('#log').dispatchEvent('drop', { dataTransfer: dt });
  };
  return { page, frame, state, file, drag };
}

browserTest('pick a PDF from the + menu: it uploads, shows a pill, and its id goes with the message', async t => {
  const f = await fixture(t);
  await f.frame.locator('#addBtn').click();
  assert.match(await f.frame.locator('#pdfBtn').innerText(), /Upload a PDF\s*Up to 10 MB and 100 pages/);
  const chooser = f.page.waitForEvent('filechooser');
  await f.frame.locator('#pdfBtn').click();
  await (await chooser).setFiles({ name: 'Q3 report.pdf', mimeType: 'application/pdf', buffer: PDF });
  await f.frame.locator('#pdfPill:not([hidden]) .pi:text("📄")').waitFor();
  assert.equal(await f.frame.locator('#pdfPill .pl').innerText(), 'Q3 report.pdf · 3 p.');
  assert.equal(await f.frame.locator('#addMenu').isVisible(), false);
  const up = f.state.uploads[0];
  assert.deepEqual([up.name, up.type, up.auth], ['Q3 report.pdf', 'application/pdf', 'Bearer test-session']);
  assert.ok(up.body.equals(PDF), 'the file itself is the body');

  // while the chat has a PDF, ◆ can't be picked
  await f.frame.locator('#modelBtn').click();
  const router = f.frame.locator('#modelMenu button', { hasText: 'Muse Spark' });
  assert.equal(await router.isDisabled(), true);
  assert.match(await router.innerText(), /Can’t read PDFs/);
  await f.frame.locator('#modelBtn').click();

  await f.frame.locator('#q').fill('What happened to revenue?');
  await f.frame.locator('#sendBtn').click();
  await f.frame.locator('.msg.bot .meta').waitFor();
  const chat = f.state.requests.find(r => r.path === '/api/chat');
  assert.equal(chat.body.pdf, 7);
  assert.equal(chat.body.message, 'What happened to revenue?');
  assert.match(await f.frame.locator('.msg.user .fchip').innerText(), /📄\s*Q3 report\.pdf\s*· 3 p\./);
  assert.equal(await f.frame.locator('#pdfPill').isVisible(), false, 'once sent, it’s part of the chat');
  await f.frame.locator('#q').fill('And costs?');
  await f.frame.locator('#sendBtn').click();
  await f.frame.waitForFunction(() => document.querySelectorAll('.msg.bot .meta').length === 2);
  assert.equal(f.state.requests.filter(r => r.path === '/api/chat')[1].body.pdf, undefined, 'the server resends it on follow-ups');
  assert.equal(await f.frame.locator('#modelMenu button', { hasText: 'Muse Spark' }).isDisabled(), true);
  await f.frame.locator('#newBtn').click();
  assert.equal(await f.frame.locator('#modelMenu button', { hasText: 'Muse Spark' }).isDisabled(), false, 'a new chat can use ◆ again');
});

browserTest('dragging a file that isn’t a PDF onto the panel is turned away; a PDF is taken', async t => {
  const f = await fixture(t);
  await f.drag(await f.file('notes.txt', 'text/plain', 'hello'));
  await f.frame.locator('.note', { hasText: 'Only PDFs can be added here, and “notes.txt” isn’t one.' }).waitFor();
  assert.equal(await f.frame.locator('#drop').isVisible(), false);
  // a file named .pdf that isn't one is caught before it uploads
  await f.drag(await f.file('fake.pdf', 'application/pdf', 'PK\u0003\u0004 not a pdf'));
  await f.frame.locator('.note', { hasText: '“fake.pdf” isn’t really a PDF' }).waitFor();
  assert.equal(f.state.uploads.length, 0);

  await f.drag(await f.file('slides.pdf', 'application/pdf', PDF.toString('latin1')));
  await f.frame.locator('#pdfPill .pl:text("slides.pdf · 3 p.")').waitFor();
  assert.equal(f.state.uploads.length, 1);
  assert.equal(f.state.requests.some(r => r.path === '/api/chat'), false);
});

browserTest('a PDF quote’s marker shows the quote and its page, on /chat too', async t => {
  const f = await fixture(t, { standalone: true, events: [
    { t: 'id', conversationId: 42 }, { t: 'd', v: 'Revenue grew 12%.' },
    { ...done, quotes: ['Revenue grew 12% in the third quarter.'], cites: [{ at: 17, q: [0] }], pdfPages: [{ name: 'Q3 report.pdf', from: 2, to: 2 }] },
  ] });
  await f.frame.locator('#pdfFile').setInputFiles({ name: 'Q3 report.pdf', mimeType: 'application/pdf', buffer: PDF });
  await f.frame.locator('#pdfPill .pl:text("Q3 report.pdf · 3 p.")').waitFor();
  await f.frame.locator('#sendBtn').click();
  const marker = f.frame.locator('.msg.bot .cite');
  await marker.waitFor();
  assert.match(await marker.getAttribute('title'), /“Revenue grew 12% in the third quarter\.”\np\. 2 · Q3 report\.pdf/);
  await marker.click();
  assert.match(await f.frame.locator('.cpop').innerText(), /“Revenue grew 12% in the third quarter\.”\s*p\. 2 · Q3 report\.pdf/);
  await f.frame.locator('#q').press('Escape');
  assert.equal(await f.frame.locator('.cpop').count(), 0, 'Esc closes the quote');
  assert.equal(await f.frame.locator('#q').isVisible(), true, '…and not the panel');
});

browserTest('a pasted PDF uploads; with ◆ picked it switches to Haiku; upload errors are explained', async t => {
  let fail = false;
  const f = await fixture(t, { prefs: { model: 'openrouter' }, upload: u => fail
    ? [413, { error: 'That PDF has 140 pages. PDFs can have up to 100 pages, so split it or save just the part you need.' }]
    : [200, { id: 9, name: u.name, size: u.body.length, pages: 12, tokens: 30000 }] });
  assert.equal(await f.frame.locator('#modelName').innerText(), 'Muse Spark 1.3');
  await f.frame.locator('#q').focus();
  await f.frame.evaluate(pdf => {
    const d = new DataTransfer(); d.items.add(new File([pdf], 'pasted.pdf', { type: 'application/pdf' }));
    document.querySelector('#q').dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }));
  }, PDF.toString('latin1'));
  await f.frame.locator('#pdfPill .pl:text("pasted.pdf · 12 p.")').waitFor();
  assert.equal(await f.frame.locator('#modelName').innerText(), 'Haiku 5.5');
  await f.frame.locator('.note', { hasText: 'Muse Spark 1.3 can’t read PDFs, so this chat uses Haiku 5.5.' }).waitFor();
  assert.deepEqual(f.state.requests.find(r => r.path === '/api/prefs').body, { model: 'haiku' });
  assert.equal(await f.frame.locator('#att').isVisible(), false, 'a PDF isn’t taken as an image');

  fail = true;
  await f.frame.locator('#pdfFile').setInputFiles({ name: 'long.pdf', mimeType: 'application/pdf', buffer: PDF });
  await f.frame.locator('.note', { hasText: 'Couldn’t add “long.pdf”: That PDF has 140 pages.' }).waitFor();
  assert.equal(await f.frame.locator('#pdfPill').isVisible(), false, 'the new PDF replaced the old one, and it failed');
});

browserTest('without PDF uploads on the account, the menu says so and drops are refused', async t => {
  const f = await fixture(t, { user: { allowPdf: false } });
  await f.frame.locator('#addBtn').click();
  assert.equal(await f.frame.locator('#pdfBtn').isDisabled(), true);
  assert.match(await f.frame.locator('#pdfBtn').innerText(), /Not turned on for your account/);
  await f.frame.locator('#addBtn').click();
  await f.drag(await f.file('slides.pdf', 'application/pdf', PDF.toString('latin1')));
  await f.frame.locator('.note', { hasText: 'PDF uploads aren’t turned on for your account.' }).waitFor();
  assert.equal(f.state.uploads.length, 0);
});

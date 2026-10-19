import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// Browser tests for chat history. Like widget.test.js, every HTTP response is a fixture: no server, database or API key.
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

const boot = {
  authed: true, who: 'user', theme: 'ember', lockMinutes: 0,
  user: { id: 1, name: 'Test reader', status: 'trusted', allowWeb: true, passcode: false },
  prefs: { theme: 'ember', model: 'haiku', web: false },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku' }],
};
const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
const chat = (id, title, h, extra = {}) => ({ id, title, site: 'news.example.test', url: 'https://news.example.test/article', pageTitle: 'Article', createdAt: hoursAgo(h + 1), updatedAt: hoursAgo(h), ...extra });
const CHATS = [chat(11, 'What is the budget?', 0.2), chat(12, 'Explain the highlighted text', 30), chat(13, 'Older question', 24 * 20, { site: 'other.example.test' })];
const DETAIL = {
  chat: CHATS[0],
  messages: [
    { role: 'user', text: 'What is the budget?', highlight: 'the budget is 5 million', page: true, url: 'https://news.example.test/article', image: false, web: false, at: hoursAgo(1) },
    { role: 'assistant', text: 'It is **5 million** in total.', model: 'Haiku', usage: { in: 50, out: 20 }, searches: 0, stopped: false, sources: [{ url: 'https://src.example.test/a', title: 'Source A' }],
      quotes: ['the budget is 5 million'], cites: [{ at: 29, q: [0] }], at: hoursAgo(1) },
  ],
  earlier: false,
};

async function fixture(t, { who = 'user', theme = 'ember', chats = CHATS, size = { width: 1000, height: 900 }, standalone = true, pages } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: size });
  context.setDefaultTimeout(5000);
  const state = { requests: [], errors: [], chats: [...chats], removedAll: false };
  t.after(async () => { await context.close(); assert.deepEqual(state.errors, [], 'no browser errors or unexpected requests'); });
  await context.addInitScript(() => localStorage.setItem('pb_token', 'test-session'));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/widget' || url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    state.requests.push({ path: url.pathname, method: request.method(), search: url.search, body: request.method() === 'POST' ? request.postDataJSON() : null });
    if (url.pathname === '/api/boot') return json({ ...boot, who, theme, prefs: { ...boot.prefs, theme }, ...(who === 'owner' && { user: undefined }), version: 7 });
    if (url.pathname === '/api/ping' || url.pathname === '/api/logout') return json({ ok: true });
    if (url.pathname === '/api/chats' && request.method() === 'GET') {
      const q = url.searchParams.get('q'), before = url.searchParams.get('before');
      let rows = state.chats.filter(c => !q || c.title.toLowerCase().includes(q.toLowerCase()));
      if (pages) { const from = before ? Number(before) : 0; return json({ chats: rows.slice(from, from + pages), next: from + pages < rows.length ? String(from + pages) : null }); }
      return json({ chats: rows, next: null });
    }
    if (url.pathname === '/api/chats' && request.method() === 'DELETE') { state.chats = []; return json({ ok: true, removed: 3 }); }
    const m = /^\/api\/chats\/(\d+)$/.exec(url.pathname);
    if (m && request.method() === 'GET') {
      const c = state.chats.find(c => c.id === Number(m[1]));
      return c ? json({ ...DETAIL, chat: c }) : json({ error: 'That chat isn’t in your history anymore.' }, 404);
    }
    if (m && request.method() === 'DELETE') { state.chats = state.chats.filter(c => c.id !== Number(m[1])); return json({ ok: true }); }
    if (url.pathname === '/api/chat') return route.fulfill({ contentType: 'application/x-ndjson',
      body: [{ t: 'id', conversationId: request.postDataJSON().conversationId || 99 }, { t: 'd', v: 'Follow-up answer.' }, { t: 'done', conversationId: request.postDataJSON().conversationId || 99, model: 'haiku', usage: { in: 5, out: 5 }, stop: 'end_turn' }]
        .map(e => JSON.stringify(e)).join('\n') + '\n' });
    state.errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected' });
  });
  const page = await context.newPage();
  page.on('pageerror', e => state.errors.push(e.message));
  await page.goto('https://pagebot.example.test/chat');
  const frame = page.mainFrame();
  await frame.locator('#histBtn').waitFor({ state: 'visible' });
  const rows = () => frame.locator('#histList .hrow');
  const openHist = async () => { await frame.locator('#histBtn').click(); await frame.locator('#hist').waitFor({ state: 'visible' }); };
  return { page, frame, state, rows, openHist };
}

browserTest('history lists chats by day, searches, and pages', async t => {
  const f = await fixture(t, { pages: 2 });
  await f.openHist();
  await f.rows().first().waitFor();
  const days = await f.frame.locator('#histList .hday').allTextContents();
  assert.deepEqual(days, ['Today', 'Yesterday']);
  assert.equal(await f.rows().count(), 2);
  assert.match(await f.rows().first().innerText(), /What is the budget\?\s+news\.example\.test/);
  await f.frame.locator('.hmore').click();
  await f.frame.waitForFunction(() => document.querySelectorAll('#histList .hrow').length === 3);
  assert.deepEqual(await f.frame.locator('#histList .hday').allTextContents(), ['Today', 'Yesterday', 'Older']);
  assert.ok(f.state.requests.some(r => r.search.includes('before=2')), 'Load more sends the cursor');
  await f.frame.locator('#histQ').fill('older');
  await f.frame.waitForFunction(() => document.querySelectorAll('#histList .hrow').length === 1);
  assert.ok(f.state.requests.some(r => r.search.includes('q=older')));
  await f.frame.locator('#histQ').fill('zzzz');
  await f.frame.locator('#histList .hstate').waitFor();
  assert.match(await f.frame.locator('#histList .hstate').innerText(), /No chats match/);
});

browserTest('opening a chat shows it cleanly and a follow-up continues the same conversation', async t => {
  const f = await fixture(t);
  await f.openHist();
  await f.rows().first().locator('.hopen').click();
  await f.frame.locator('#hist').waitFor({ state: 'hidden' });
  const log = f.frame.locator('#log');
  assert.match(await log.locator('.msg.user .body').innerText(), /^What is the budget\?$/);
  assert.match(await log.locator('.hq').innerText(), /the budget is 5 million/);
  assert.doesNotMatch(await log.innerText(), /<page|highlighted_text/);
  assert.match(await log.locator('.msg.bot .body').innerHTML(), /<b>5 million<\/b>/);
  assert.equal(await log.locator('.cite').count(), 1, 'the quote marker survived');
  assert.ok(await log.locator('.cite.away').count() === 1, 'standalone /chat has no page: the marker only shows its quote on hover');
  assert.match(await log.locator('.cite').getAttribute('title'), /the budget is 5 million/);
  assert.match(await log.innerText(), /Source A/);
  await f.frame.locator('#q').fill('And next year?');
  await f.frame.locator('#q').press('Enter');
  await f.frame.locator('.msg.bot').nth(1).waitFor();
  const post = f.state.requests.find(r => r.path === '/api/chat');
  assert.equal(post.body.conversationId, 11);
  // the opened chat is marked in history
  await f.openHist();
  await f.frame.locator('#histList .hrow.on').waitFor();
});

browserTest('removing a chat asks first; accounts are told the owner can still see it', async t => {
  const f = await fixture(t);
  await f.openHist();
  const row = f.rows().first();
  await row.hover();
  await row.locator('.hdel').click();
  assert.match(await row.innerText(), /Remove this chat from your history\?/);
  assert.match(await row.innerText(), /owner of this pagebot can still see it/);
  // Esc cancels the question and leaves history open
  await f.page.keyboard.press('Escape');
  await f.frame.locator('#hist').waitFor({ state: 'visible' });
  assert.equal(await f.rows().count(), 3);
  assert.equal(f.state.requests.filter(r => r.method === 'DELETE').length, 0);
  await row.hover();
  await row.locator('.hdel').click();
  await row.locator('.ghost.bad').click();
  await f.frame.waitForFunction(() => document.querySelectorAll('#histList .hrow').length === 2);
  assert.ok(f.state.requests.some(r => r.method === 'DELETE' && r.path === '/api/chats/11'));
  await f.page.reload();
  await f.frame.locator('#histBtn').click();
  await f.frame.waitForFunction(() => document.querySelectorAll('#histList .hrow').length === 2);
});

browserTest('removing the chat you have open starts a new one, and remove-all empties history', async t => {
  const f = await fixture(t);
  await f.openHist();
  await f.rows().first().locator('.hopen').click();
  await f.frame.locator('#log .msg.user').waitFor();
  await f.openHist();
  const row = f.frame.locator('#histList .hrow.on');
  await row.hover(); await row.locator('.hdel').click(); await row.locator('.ghost.bad').click();
  await f.frame.waitForFunction(() => document.querySelectorAll('#histList .hrow').length === 2);
  assert.equal(await f.frame.locator('#log .msg').count(), 0, 'the open chat was cleared');
  await f.frame.locator('.hfoot .link').click();
  await f.frame.locator('.hfoot .ghost.bad').click();
  await f.frame.locator('#histList .hstate').waitFor();
  assert.match(await f.frame.locator('#histList .hstate').innerText(), /No chats yet/);
  assert.ok(f.state.requests.some(r => r.method === 'DELETE' && r.search === '?all=1'));
});

browserTest('the owner is not told someone else can see it; new chat closes history', async t => {
  const f = await fixture(t, { who: 'owner' });
  await f.openHist();
  const row = f.rows().first();
  await row.hover(); await row.locator('.hdel').click();
  const text = await row.innerText();
  assert.match(text, /Remove this chat from your history\?/);
  assert.doesNotMatch(text, /owner of this pagebot/);
  assert.match(text, /Activity/);
  await row.locator('.hno').click();
  await f.frame.locator('#newBtn').click();
  await f.frame.locator('#hist').waitFor({ state: 'hidden' });
  assert.equal(await f.frame.locator('#histBtn').getAttribute('aria-expanded'), 'false');
});

for (const theme of ['glass', 'clear', 'ember']) browserTest(`history is readable in the ${theme} theme and fits a narrow panel`, async t => {
  const f = await fixture(t, { theme, size: { width: 300, height: 700 } });
  await f.frame.locator('#q').fill('hello'); // something behind the sheet
  await f.openHist();
  await f.rows().first().waitFor();
  const header = await f.frame.locator('header').boundingBox(), close = await f.frame.locator('#closeBtn').boundingBox();
  if (close) assert.ok(close.x + close.width <= header.x + header.width + 1, 'the header buttons stay inside the header');
  const hist = await f.frame.locator('#hist').boundingBox();
  assert.ok(hist.width >= 290);
  const overflow = await f.frame.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'no sideways scroll');
  if (theme === 'clear') assert.equal(await f.frame.evaluate(() => getComputedStyle(document.querySelector('#composer')).visibility), 'hidden', 'the chat behind a clear sheet is hidden');
});

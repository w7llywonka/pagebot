import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// The friendlier flows: a hello for a new browser, Copy my username while you wait, Try again and plain words when an
// answer fails, a calm daily limit with a heads-up before it, "Thinking…" in words and for screen readers, folding
// banners, plain model names, "Just this once" for repeating screenshots, history times, example notes and the /chat
// rail's current section. All HTTP responses are fixtures: no application server, database, or API key is needed.
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

const ORIGIN = 'https://pagebot.example.test';
const account = {
  version: 8, authed: true, who: 'user', theme: 'paper', lockMinutes: 0, lock: 'password', passwordSet: true, accounts: { on: true, signup: true },
  user: { name: 'maya', status: 'trusted', allowWeb: true, allowSonnet: true, passcode: false },
  prefs: { theme: 'paper', model: 'haiku', web: false },
  limits: { maxTokens: 2048, maxTokensCap: 8000, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku 5.5' }, { key: 'sonnet', label: 'Sonnet 5.5' }],
  quota: { pct: 10 },
};
const signedOut = signup => ({ version: 8, theme: 'paper', lock: 'password', passwordSet: true, accounts: { on: true, signup }, authed: false });
const done = (extra = {}) => ({ t: 'done', conversationId: 42, model: 'Haiku 5.5', stop: 'end_turn', ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// /chat with the given boot. `chat(body, n)` answers the n-th question: { events }, { status, json }, 'abort', or a promise of one.
async function fixture(t, { boot = account, token = true, store = {}, chat, chats = [], viewport = { width: 900, height: 800 }, clipboard = false } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport, timezoneId: 'UTC' });
  context.setDefaultTimeout(5000);
  if (clipboard) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const state = { chats: [], prefs: [], errors: [] };
  t.after(async () => { await context.close(); assert.deepEqual(state.errors, [], 'no browser errors or unexpected requests'); });
  await context.addInitScript(([token, store]) => {
    if (token) localStorage.setItem('pb_token', 'test-session');
    for (const [k, v] of Object.entries(store)) localStorage.setItem(k, v);
    window.__shares = 0; // "Screenshot this tab": a grey picture of a shared tab
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.__shares++;
      const c = document.createElement('canvas'), g = c.getContext('2d'); c.width = 800; c.height = 500;
      const paint = () => { g.fillStyle = '#808080'; g.fillRect(0, 0, 800, 500); }; paint(); setInterval(paint, 100);
      return c.captureStream(10);
    };
  }, [token, store]);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    if (url.pathname === '/api/boot') return json(boot);
    if (url.pathname === '/api/ping' || url.pathname === '/api/logout') return json({ ok: true });
    if (url.pathname === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
    if (url.pathname === '/api/chats' && request.method() === 'GET') return json({ chats, next: null });
    if (url.pathname === '/api/prefs') { const p = request.postDataJSON(); state.prefs.push(p); return json({ prefs: { ...boot.prefs, ...p }, limits: boot.limits }); }
    if (url.pathname === '/api/chat') {
      const body = request.postDataJSON(); state.chats.push(body);
      const r = await (chat ? chat(body, state.chats.length) : { events: [{ t: 'd', v: 'A helpful answer.' }, done()] });
      if (r === 'abort') return route.abort('failed');
      if (r.status) return json(r.json, r.status);
      return route.fulfill({ contentType: 'application/x-ndjson', body: r.events.map(e => JSON.stringify(e)).join('\n') + '\n' });
    }
    state.errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', e => state.errors.push(e.message));
  await page.goto(ORIGIN + '/chat');
  await page.locator('#boot').waitFor({ state: 'detached' });
  const ask = async text => { await page.locator('#q').fill(text); await page.locator('#sendBtn').click(); };
  return { page, state, ask };
}

browserTest('a browser that has never signed in here opens on a hello with two equal ways in, and it fits a small panel', async t => {
  const { page } = await fixture(t, { boot: signedOut(true), token: false, viewport: { width: 300, height: 560 } });
  await page.locator('#welcome').waitFor({ state: 'visible' });
  assert.match(await page.locator('#welcome').innerText(), /Hi, I’m pagebot\.\s+I read the page you’re on and answer questions about it\./);
  for (const s of ['#uName', '#uPass', '#lockTitle', '#lockLinks']) assert.equal(await page.locator(s).isVisible(), false, `${s} waits behind the hello`);
  const [a, b] = await Promise.all(['#wNew', '#wHave'].map(s => page.locator(s).boundingBox()));
  assert.ok(Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1, 'the two ways in are the same size');
  assert.ok(a.height >= 36, 'big enough to tap');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'nothing sticks out sideways at 300px');
  await page.locator('#wNew').click();
  assert.equal(await page.locator('#lockTitle').innerText(), 'Ask to join');
  assert.equal(await page.locator('#uPass2').isVisible(), true);
  assert.equal(await page.locator('#welcome').isVisible(), false);
  await page.waitForFunction(() => document.activeElement.id === 'uName'); // ready to type a username
  await page.locator('#lockLinks button', { hasText: 'I already have an account' }).click();
  assert.equal(await page.locator('#lockTitle').innerText(), 'Sign in');
  assert.equal(await page.locator('#uName').isVisible(), true);
});

browserTest('"I already have an account" goes to the sign-in form; a returning browser goes straight there; with sign-ups off there is no hello', async t => {
  const fresh = await fixture(t, { boot: signedOut(true), token: false });
  await fresh.page.locator('#wHave').click();
  assert.equal(await fresh.page.locator('#lockTitle').innerText(), 'Sign in');
  assert.equal(await fresh.page.locator('#uGo').innerText(), 'Sign in');
  const back = await fixture(t, { boot: signedOut(true), token: false, store: { pb_who: 'user', pb_user: 'maya' } });
  await back.page.locator('#uName').waitFor({ state: 'visible' });
  assert.equal(await back.page.locator('#welcome').isVisible(), false);
  assert.equal(await back.page.locator('#uName').inputValue(), 'maya');
  const closed = await fixture(t, { boot: signedOut(false), token: false });
  await closed.page.locator('#uName').waitFor({ state: 'visible' });
  assert.equal(await closed.page.locator('#welcome').isVisible(), false, 'nobody new can join, so the form comes first');
});

browserTest('the waiting screen copies your username to send to the person who invited you', async t => {
  const { page } = await fixture(t, { boot: { ...account, user: { ...account.user, status: 'pending' } }, clipboard: true });
  await page.locator('#wait').waitFor({ state: 'visible' });
  assert.match(await page.locator('#waitText').innerText(), /let the person who invited you know/);
  await page.locator('#waitCopy').click();
  await page.waitForFunction(() => document.querySelector('#waitCopy').textContent === 'Copied');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'maya');
});

browserTest('a failed answer keeps what arrived in its normal colour, says what happened plainly, and Try again sends it again', async t => {
  const { page, state, ask } = await fixture(t, { chat: (body, n) => n === 1
    ? { events: [{ t: 'id', conversationId: 42 }, { t: 'd', v: 'The first half of an answer.' }, { t: 'err', v: 'The API is overloaded — try again in a moment.', conversationId: 42 }] }
    : { events: [{ t: 'd', v: 'The whole answer this time.' }, done()] } });
  await ask('Tell me about this');
  const bot = page.locator('.msg.bot.err');
  await bot.locator('.retry button').waitFor();
  const [partial, line] = await bot.locator('.body > p').evaluateAll(ps => ps.map(p => ({ text: p.textContent, color: getComputedStyle(p).color })));
  assert.equal(partial.text, 'The first half of an answer.');
  assert.equal(line.text, '⚠ pagebot is busy right now. Try again in a moment.', 'no "API" in the words');
  assert.notEqual(partial.color, line.color, 'only the last line is in the error colour');
  assert.equal(await page.locator('#live').innerText(), 'pagebot is busy right now. Try again in a moment.');
  assert.equal(await bot.locator('.retry button').innerText(), 'Try again');
  await bot.locator('.retry button').click();
  await page.locator('.msg.bot:not(.err) .meta').waitFor();
  assert.equal(state.chats.length, 2);
  assert.equal(state.chats[1].message, 'Tell me about this', 'the same question goes again');
  assert.equal(await page.locator('.retry').count(), 0, 'the button goes once it is used');
  assert.match(await page.locator('.msg.bot').last().innerText(), /The whole answer this time\./);
  assert.equal(await page.locator('#live').innerText(), 'Answer ready');
});

browserTest('a dropped connection says so in plain words, and Try again puts the question back and sends it once', async t => {
  const { page, state, ask } = await fixture(t, { chat: (body, n) => n === 1 ? 'abort' : { events: [{ t: 'd', v: 'Back again.' }, done()] } });
  await ask('Are you there?');
  await page.locator('.msg.bot.err .retry button').waitFor();
  const text = await page.locator('.msg.bot.err .body').innerText();
  assert.equal(text, '⚠ Can’t reach pagebot right now. Check your connection, then send it again.');
  assert.doesNotMatch(text, /fetch|HTTP/i);
  await page.locator('.msg.bot.err .retry button').click();
  await page.locator('.msg.bot .meta').waitFor();
  assert.equal(state.chats.length, 2);
  assert.equal(await page.locator('.msg.user').count(), 1, 'the server never had it, so the question shows once');
  assert.equal(await page.locator('.msg.bot.err').count(), 0);
});

browserTest('at the daily limit: a calm card, Send dimmed, the question back in the box, and trying again adds nothing new', async t => {
  const { page, state, ask } = await fixture(t, { boot: { ...account, quota: { pct: 97 } },
    chat: () => ({ status: 429, json: { error: 'You’ve used today’s limit. It resets at midnight.', quota: { pct: 100 } } }) });
  assert.equal(await page.locator('#limitCard').isVisible(), false, 'nothing before the limit');
  await ask('One more question');
  await page.locator('#limitCard').waitFor({ state: 'visible' });
  assert.match(await page.locator('#limitCard').innerText(), /That’s today’s limit\. It starts again at midnight\. Your chats stay here\./);
  assert.match(await page.locator('#log').innerText(), /You’ve used today’s limit\. It resets at midnight\./, 'the server’s sentence stays in the chat');
  assert.equal(await page.locator('.msg.bot.limit').count(), 1);
  const [ink, text] = await page.locator('.msg.bot.limit .body p').evaluate(p => [getComputedStyle(p).color, getComputedStyle(document.body).color]);
  assert.equal(ink, text, 'a limit is a state, not an error: no error colour');
  await page.waitForFunction(() => document.querySelector('#q').value === 'One more question');
  assert.equal(await page.locator('#composer').evaluate(e => e.classList.contains('limited')), true);
  assert.ok(+await page.locator('#sendBtn').evaluate(e => getComputedStyle(e).opacity) < 1, 'Send is dimmed');
  await page.locator('#sendBtn').click(); // the server still decides (it may be past midnight)
  for (let i = 0; i < 100 && state.chats.length < 2; i++) await page.waitForTimeout(50);
  assert.equal(state.chats.length, 2);
  await page.waitForFunction(() => document.querySelectorAll('.msg').length === 2 && document.querySelector('#q').value === 'One more question');
  assert.equal(await page.locator('.msg.bot').count(), 1, 'no second message for the same limit');
  await page.locator('#limitUsage').click();
  await page.locator('#cat-usage').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#quotaText').innerText(), 'Today’s limit used up');
});

browserTest('a heads-up under the answer that takes the day past 80%, once, and "Nearly at today’s limit" past 95%', async t => {
  const pcts = [82, 85, 96];
  const { page, ask } = await fixture(t, { boot: { ...account, quota: { pct: 70 } },
    chat: (body, n) => ({ events: [{ t: 'd', v: 'Answer ' + n }, done({ usage: { pct: 1 }, quota: { pct: pcts[n - 1] } })] }) });
  await ask('First');
  await page.locator('.msg.bot .heads').waitFor();
  assert.match(await page.locator('.msg.bot .heads').innerText(), /^Heads up: about a fifth of today’s limit is left\.\s*See usage$/);
  assert.match(await page.locator('.msg.bot .meta').innerText(), /used 1% of today’s limit/, 'the info line stays as it was');
  await ask('Second');
  await page.locator('.msg.bot .meta').nth(1).waitFor();
  assert.equal(await page.locator('.heads').count(), 1, 'said once');
  await ask('Third');
  await page.locator('.msg.bot .meta').nth(2).waitFor();
  assert.equal(await page.locator('.heads').count(), 2);
  assert.match(await page.locator('.heads').last().innerText(), /^Nearly at today’s limit\./);
  await page.locator('.heads').last().locator('button').click();
  await page.locator('#cat-usage').waitFor({ state: 'visible' });
});

browserTest('while it works it says so in words and to screen readers, and each message says who is speaking', async t => {
  const gate = deferred();
  const { page, ask } = await fixture(t, { chat: async () => { await gate.promise; return { events: [{ t: 'd', v: 'Here you go.' }, done()] }; } });
  await ask('Hello?');
  const bot = page.locator('.msg.bot');
  await bot.locator('.typing').waitFor();
  assert.equal(await bot.locator('.think').innerText(), 'Thinking…');
  assert.equal(await bot.locator('canvas').count(), 0);
  assert.equal(await page.locator('#live').getAttribute('role'), 'status');
  assert.equal(await page.locator('#live').innerText(), 'Thinking…');
  assert.deepEqual(await page.locator('.msg').evaluateAll(ms => ms.map(m => [m.getAttribute('role'), m.getAttribute('aria-label')])),
    [['article', 'You asked'], ['article', 'pagebot answered']]);
  gate.resolve();
  await bot.locator('.meta').waitFor();
  assert.equal(await page.locator('#live').innerText(), 'Answer ready', 'the result, not the answer itself');
  assert.equal(await bot.locator('.think').count(), 0);
});

const restriction = { id: 5, endsAt: '2030-01-04T12:00:00Z', reason: 'Heavy use this week.', limits: { noSonnet: true } };
const announcement = { id: 3, body: 'New: PDFs work on every site now. Have a look in the + menu.', createdAt: new Date().toISOString() };
browserTest('banners fold to one line: with two, the announcement stays open and the restriction folds; a chevron opens it', async t => {
  const { page } = await fixture(t, { boot: { ...account, restriction, announcement } });
  await page.locator('#rst').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#ann').evaluate(e => e.classList.contains('fold')), false, 'the newest stays open');
  assert.equal(await page.locator('#rst').evaluate(e => e.classList.contains('fold')), true);
  assert.equal(await page.locator('#rstMeta').isVisible(), false);
  const h = await page.locator('#rst').boundingBox();
  assert.ok(h.height <= 48, `one line (${h.height}px)`);
  assert.equal(await page.locator('#rstMore').getAttribute('aria-expanded'), 'false');
  await page.locator('#rstMore').click();
  assert.equal(await page.locator('#rstMore').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#rstMeta').isVisible(), true);
  await page.locator('#annMore').click();
  assert.equal(await page.locator('#annMeta').isVisible(), false);
  await page.locator('#annText').click(); // a click on a folded banner opens it
  assert.equal(await page.locator('#annMeta').isVisible(), true);
});

browserTest('a restriction shows open the first time, and folded once this browser has seen it', async t => {
  const first = await fixture(t, { boot: { ...account, restriction } });
  await first.page.locator('#rst').waitFor({ state: 'visible' });
  assert.equal(await first.page.locator('#rst').evaluate(e => e.classList.contains('fold')), false);
  await first.page.reload(); await first.page.locator('#boot').waitFor({ state: 'detached' });
  await first.page.locator('#rst').waitFor({ state: 'visible' });
  assert.equal(await first.page.locator('#rst').evaluate(e => e.classList.contains('fold')), true, 'seen before, so one line');
  const other = await fixture(t, { boot: { ...account, restriction: { ...restriction, id: 6 } }, store: { pb_rstseen: '5' } });
  await other.page.locator('#rst').waitFor({ state: 'visible' });
  assert.equal(await other.page.locator('#rst').evaluate(e => e.classList.contains('fold')), false, 'a new restriction shows open');
});

browserTest('the model button says what a model does, with its name in the menu and in Settings', async t => {
  const { page, state } = await fixture(t);
  assert.equal(await page.locator('#modelName').innerText(), 'Quick');
  assert.equal(await page.locator('#modelBtn').getAttribute('title'), 'Model: Haiku 5.5');
  await page.locator('#modelBtn').click();
  const rows = await page.locator('#modelMenu button .mt').allInnerTexts();
  assert.match(rows[0], /^Quick\s+Haiku 5\.5 · Good for most questions$/);
  assert.match(rows[1], /^Thorough\s+Sonnet 5\.5 · Thinks harder, a little slower$/);
  await page.locator('#modelMenu button', { hasText: 'Thorough' }).click();
  await page.waitForFunction(() => document.querySelector('#modelName').textContent === 'Thorough');
  assert.deepEqual(state.prefs.at(-1), { model: 'sonnet' });
  await page.locator('#setBtn').click();
  assert.equal(await page.locator('#modelSeg .on').innerText(), 'Thorough Sonnet 5.5');
});

browserTest('a repeating screenshot says "Every message", and "Just this once" stops the repeat but keeps the picture', async t => {
  const { page } = await fixture(t);
  await page.locator('#addBtn').click();
  await page.locator('#shotBtn').click();
  await page.locator('#att img[src^="data:image"]').waitFor();
  assert.equal(await page.locator('#areaPill .pl').innerText(), 'Every message');
  assert.match(await page.locator('#attOnce').innerText(), /^A fresh screenshot goes with each message\.\s+Just this once$/);
  await page.locator('#onceBtn').click();
  assert.equal(await page.locator('#areaPill').isVisible(), false, 'the repeat is off');
  assert.equal(await page.locator('#attOnce').isVisible(), false);
  assert.equal(await page.locator('#att img[src^="data:image"]').isVisible(), true, 'this picture still goes with the message');
});

browserTest('history says how long ago for today and the weekday for this week', async t => {
  const now = Date.now(), recent = new Date(now - 25 * 60e3).toISOString(), older = new Date(now - 3 * 86400e3).toISOString();
  const { page } = await fixture(t, { chats: [
    { id: 1, title: 'This morning’s chat', site: 'news.example.test', updatedAt: recent, createdAt: recent },
    { id: 2, title: 'A chat from earlier this week', site: 'docs.example.test', updatedAt: older, createdAt: older },
  ] });
  await page.locator('#histBtn').click();
  await page.locator('.hrow').nth(1).waitFor();
  const subs = await page.locator('.hsub').allInnerTexts();
  const day = await page.evaluate(t => new Date(t).toLocaleDateString(undefined, { weekday: 'long' }), older);
  assert.equal(subs[0], 'news.example.test · 25m ago');
  assert.equal(subs[1], `docs.example.test · ${day}`);
});

browserTest('example notes fill the website notes box with one click', async t => {
  const { page } = await fixture(t);
  await page.locator('#setBtn').click();
  if (await page.locator('#shBack').isVisible()) await page.locator('#shBack').click();
  await page.locator('#tab-memory').click();
  await page.locator('#memorySite').fill('example.test');
  await page.locator('#memoryLoad').click();
  await page.locator('#memoryInstructions:not([disabled])').waitFor();
  await page.locator('#memoryChips button', { hasText: 'Keep answers short' }).click();
  await page.locator('#memoryChips button', { hasText: 'Explain jargon' }).click();
  assert.equal(await page.locator('#memoryInstructions').inputValue(), 'Keep answers short. Explain jargon.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'memoryInstructions');
  assert.equal(await page.locator('#memorySave').isDisabled(), false, 'ready to save');
});

browserTest('the /chat rail marks the open section, and New chat only while the chat is fresh', async t => {
  const { page, ask } = await fixture(t, { viewport: { width: 1200, height: 800 } });
  const current = () => page.locator('#workspaceNav button[aria-current=page]').evaluateAll(bs => bs.map(b => b.id));
  await page.waitForFunction(() => document.querySelector('#workspaceNew').getAttribute('aria-current') === 'page');
  await page.locator('#workspaceHistory').click();
  await page.waitForFunction(() => document.querySelector('#workspaceHistory').getAttribute('aria-current') === 'page');
  assert.deepEqual(await current(), ['workspaceHistory']);
  await page.locator('#workspaceSettings').click();
  await page.waitForFunction(() => document.querySelector('#workspaceSettings').getAttribute('aria-current') === 'page');
  assert.deepEqual(await current(), ['workspaceSettings']);
  await page.locator('#shDone').click();
  await page.waitForFunction(() => document.querySelector('#workspaceNew').getAttribute('aria-current') === 'page');
  await ask('Hi');
  await page.locator('.msg.bot .meta').waitFor();
  assert.deepEqual(await current(), [], 'a chat with messages in it is not "New chat"');
});

browserTest('an answer that ran out of room says so plainly, and the button goes straight to answer length', async t => {
  const { page, ask } = await fixture(t, { chat: () => ({ events: [{ t: 'd', v: 'A long answer that stops' }, done({ stop: 'max_tokens' })] }) });
  await ask('Tell me everything');
  await page.locator('.msg.bot .meta').waitFor();
  assert.match(await page.locator('.msg.bot .meta').innerText(), /The answer was cut short\.\s+Allow longer answers/);
  await page.locator('.msg.bot .meta .mini').click();
  await page.locator('#tokSec').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.activeElement?.closest('#tokSeg'));
});

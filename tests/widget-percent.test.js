import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// What the panel shows of a daily limit: accounts a percentage and a bar, the owner the amounts. All HTTP responses are
// fixtures: no application server, database, or API key is needed.
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

const account = {
  authed: true, who: 'user', theme: 'ember', lockMinutes: 0, version: 7,
  user: { name: 'Test reader', status: 'trusted', allowWeb: true, allowSonnet: true, passcode: false },
  prefs: { theme: 'ember', model: 'haiku', web: false },
  limits: { maxTokens: 2048, maxTokensCap: 8000, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku' }],
  quota: { pct: 42 },
};
const owner = { ...account, who: 'owner', user: undefined, quota: undefined };
const done = { t: 'done', conversationId: 42, model: 'Haiku 5.5', stop: 'end_turn' };

async function fixture(t, { boot = account, events, chatStatus = 200, chatBody } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 440, height: 840 } });
  context.setDefaultTimeout(5000);
  const errors = [];
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'no browser errors or unexpected requests'); });
  await context.addInitScript(() => localStorage.setItem('pb_token', 'test-session'));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    if (url.pathname === '/api/boot') return json(boot);
    if (url.pathname === '/api/ping' || url.pathname === '/api/logout') return json({ ok: true });
    if (url.pathname === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
    if (url.pathname === '/api/chat') return chatStatus !== 200 ? json(chatBody, chatStatus) : route.fulfill({
      contentType: 'application/x-ndjson', body: (events || [{ t: 'd', v: 'A helpful answer.' }, done]).map(e => JSON.stringify(e)).join('\n') + '\n' });
    errors.push(`Unexpected request: ${route.request().method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://pagebot.example.test/chat');
  await page.locator('#setBtn').waitFor({ state: 'visible' });
  await page.locator('#boot').waitFor({ state: 'detached' });
  const openSettings = async () => { await page.locator('#setBtn').click(); await page.locator('#memoryForm').waitFor({ state: 'visible' }); };
  const usage = async () => ({
    shown: await page.locator('#quotaSec').isVisible(),
    text: (await page.locator('#quotaText').innerText()).trim(), sub: (await page.locator('#quotaSub').innerText()).trim(),
    width: await page.locator('#quotaFill').evaluate(el => el.style.width), cls: await page.locator('#quotaFill').evaluate(el => el.className),
    section: await page.locator('#quotaSec').innerText(),
  });
  const ask = async () => { await page.locator('#q').fill('Question'); await page.locator('#sendBtn').click(); };
  return { page, openSettings, usage, ask };
}
const AMOUNT = /\$\s?\d|\d+(\.\d+)?\s*[kK]?\s*tokens/;

browserTest('an account sees a percentage and a bar, never an amount', async t => {
  const f = await fixture(t);
  await f.openSettings();
  const u = await f.usage();
  assert.equal(u.shown, true);
  assert.equal(u.text, '42% of today’s limit used');
  assert.equal(u.sub, '· resets at midnight');
  assert.equal(u.width, '42%');
  assert.equal(u.cls, '');
  assert.doesNotMatch(u.section, AMOUNT);
});

browserTest('under 1% says <1%, and no limit hides the section', async t => {
  const f = await fixture(t, { boot: { ...account, quota: { pct: 0.4 } } });
  await f.openSettings();
  assert.equal((await f.usage()).text, '<1% of today’s limit used');
  const g = await fixture(t, { boot: { ...account, quota: null } });
  await g.openSettings();
  assert.equal((await g.usage()).shown, false);
});

browserTest('80% turns the bar amber and 100% turns it red and says it is used up', async t => {
  const colour = f => f.page.locator('#quotaFill').evaluate(el => getComputedStyle(el).backgroundColor);
  const base = await (async () => { const f = await fixture(t); await f.openSettings(); return colour(f); })();
  const warn = await fixture(t, { boot: { ...account, quota: { pct: 80 } } });
  await warn.openSettings();
  const w = await warn.usage();
  assert.deepEqual([w.text, w.cls, w.width], ['80% of today’s limit used', 'warn', '80%']);
  assert.equal(await colour(warn), 'rgb(224, 160, 48)');
  assert.notEqual(await colour(warn), base);
  const full = await fixture(t, { boot: { ...account, quota: { pct: 100 } } });
  await full.openSettings();
  const e = await full.usage();
  assert.deepEqual([e.text, e.cls, e.width], ['Today’s limit used up', 'full', '100%']);
  assert.match(e.sub, /resets at midnight/);
  assert.doesNotMatch(e.section, AMOUNT);
  const almost = await fixture(t, { boot: { ...account, quota: { pct: 99 } } });
  await almost.openSettings();
  assert.deepEqual([(await almost.usage()).text, (await almost.usage()).cls], ['99% of today’s limit used', 'warn']);
});

browserTest('the owner’s variant shows the amounts', async t => {
  for (const [quota, text] of [
    [{ kind: 'tokens', limit: 100000, used: 42000, left: 58000 }, '42k of 100k tokens used'],
    [{ kind: 'usd', limit: 1, used: 0.42, left: 0.58 }, '$0.42 of $1.00 used'],
  ]) {
    const f = await fixture(t, { boot: { ...owner, quota } });
    await f.openSettings();
    const u = await f.usage();
    assert.equal(u.text, text);
    assert.equal(u.width, '42%');
  }
});

browserTest('an answer’s details line shows its share of the limit for an account, tokens for the owner', async t => {
  const f = await fixture(t, { events: [{ t: 'd', v: 'Answer.' }, { ...done, usage: { pct: 1.2 }, quota: { pct: 43 } }] });
  await f.ask();
  const meta = f.page.locator('.msg.bot .meta');
  await meta.waitFor();
  assert.equal((await meta.innerText()).replace(/\s+/g, ' ').trim().replace(/ copy$/i, ''), 'Haiku 5.5 · used 1.2% of today’s limit');
  assert.doesNotMatch(await meta.innerText(), /\d\s*(in|out)\b|tokens|left today|\$/);
  await f.openSettings();
  assert.equal((await f.usage()).text, '43% of today’s limit used', 'the bar moves with the answer');

  const tiny = await fixture(t, { events: [{ t: 'd', v: 'Answer.' }, { ...done, usage: { pct: 0.03 }, quota: { pct: 1 } }] });
  await tiny.ask();
  await tiny.page.locator('.msg.bot .meta').waitFor();
  assert.match(await tiny.page.locator('.msg.bot .meta').innerText(), /used <0\.1% of today’s limit/);

  const o = await fixture(t, { boot: owner, events: [{ t: 'd', v: 'Answer.' }, { ...done, usage: { in: 50, out: 20, usd: 0.0001 } }] });
  await o.ask();
  await o.page.locator('.msg.bot .meta').waitFor();
  assert.match(await o.page.locator('.msg.bot .meta').innerText(), /Haiku 5\.5 · 50 in · 20 out/);
});

browserTest('a refused question because the limit is used up moves the bar to used up, with friendly words', async t => {
  const f = await fixture(t, { boot: { ...account, quota: { pct: 97 } }, chatStatus: 429,
    chatBody: { error: 'You’ve used today’s limit. It resets at midnight.', quota: { pct: 100 } } });
  await f.ask();
  await f.page.locator('.msg.bot.err, .msg.err').first().waitFor();
  assert.match(await f.page.locator('#log').innerText(), /You’ve used today’s limit\. It resets at midnight\./);
  await f.openSettings();
  assert.equal((await f.usage()).text, 'Today’s limit used up');
});

browserTest('a restriction that lowers the limit says so without a number', async t => {
  const f = await fixture(t, { boot: { ...account, restriction: { id: 5, kind: 'restrict', state: 'restricted', reason: 'Too much', note: '', endsAt: new Date(Date.now() + 3600e3).toISOString(),
    limits: { noWeb: true, lowerLimit: true } } } });
  await f.page.locator('#rst').waitFor({ state: 'visible' });
  const text = await f.page.locator('#rstText').innerText();
  assert.match(text, /no web search, a lower daily limit\./);
  assert.doesNotMatch(text, AMOUNT);
});

browserTest('answer lengths are named for accounts and numbered for the owner', async t => {
  const names = f => f.page.locator('#tokSeg button').allInnerTexts();
  const f = await fixture(t);
  await f.openSettings();
  assert.deepEqual(await names(f), ['Brief', 'Short', 'Standard', 'Long', 'Very long']);
  assert.equal(await f.page.locator('#tokSeg button.on').innerText(), 'Standard');
  assert.doesNotMatch(await f.page.locator('#tokSec').innerText(), /\d+\s*(k|tokens)\b/i);
  const custom = await fixture(t, { boot: { ...account, limits: { ...account.limits, maxTokens: 3000 } } });
  await custom.openSettings();
  const note = await custom.page.locator('#tokNote').innerText();
  assert.match(note, /custom length/);
  assert.doesNotMatch(note, /\d/);
  const o = await fixture(t, { boot: owner });
  await o.openSettings();
  assert.deepEqual(await names(o), ['512', '1k', '2k', '4k', '8k']);
  assert.match(await o.page.locator('#tokSec').innerText(), /Maximum tokens per reply/);
});

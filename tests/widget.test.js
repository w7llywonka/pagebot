import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// Browser integration tests use Playwright and a local Chromium installation.
// All HTTP responses are fixtures: no application server, database, or API key is needed.
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
const browserTest = chromium ? test : test.skip;
const widget = await readFile(new URL('../public/widget.html', import.meta.url), 'utf8');
let browser;
before(async () => {
  if (chromium) browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
});
after(async () => { await browser?.close(); });

const goCat = async (frame, name) => { if (await frame.locator('#shBack').isVisible()) await frame.locator('#shBack').click(); await frame.locator('#tab-' + name).click(); }; // Settings remembers the category you were in
const boot = {
  authed: true, who: 'user', theme: 'ember', lockMinutes: 0,
  user: { id: 1, name: 'Test reader', status: 'trusted', allowWeb: true, passcode: false },
  prefs: { theme: 'ember', model: 'haiku', web: false },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku' }],
};
const saved = (site, instructions) => ({ site, instructions, updatedAt: '2026-01-01T00:00:00.000Z' });
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const finalEvent = {
  t: 'done', conversationId: 42, model: 'haiku', usage: { in: 50, out: 20 }, stop: 'end_turn',
};

async function fixture(t, { standalone = false, memories = [], events, version = 7 } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1000, height: 900 } });
  context.setDefaultTimeout(5000);
  const state = {
    memories: new Map(memories.map(memory => [memory.site, memory])),
    requests: [], errors: [], blockNextList: null,
  };
  t.after(async () => {
    state.blockNextList?.resolve();
    await context.close();
    assert.deepEqual(state.errors, [], 'the widget must not raise browser errors or make unexpected requests');
  });
  await context.addInitScript(() => localStorage.setItem('pb_token', 'test-session'));
  const hostPage = `<!doctype html><html><body>
    <script>
      window.hostUrl = 'https://news.example.test/article';
      window.hostRequests = [];
      addEventListener('message', event => {
        if (event.source !== document.querySelector('iframe')?.contentWindow) return;
        const request = event.data;
        window.hostRequests.push(request);
        if (request.type === 'page') event.source.postMessage({
          id: request.id,
          page: { url: window.hostUrl, title: 'Article', text: request.max <= 1 ? '' : 'From the page' },
          selection: '',
        }, event.origin);
        if (request.type === 'find') event.source.postMessage({ id: request.id, found: true }, event.origin);
      });
    </script>
    <iframe title="Pagebot" src="https://pagebot.example.test/widget?v=7" style="width:440px;height:840px;border:0"></iframe>
    </body></html>`;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: hostPage });
    if (url.pathname === '/widget' || url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    state.requests.push({ path: url.pathname, method: request.method(), body: request.postDataJSON(), url: request.url() });
    if (url.pathname === '/api/boot') return json({ ...boot, version });
    if (url.pathname === '/api/logout' || url.pathname === '/api/ping') return json({ ok: true });
    if (url.pathname === '/api/site-memory') {
      if (request.method() === 'GET') {
        const snapshot = [...state.memories.values()];
        const gate = state.blockNextList;
        state.blockNextList = null;
        if (gate) {
          gate.started.resolve();
          await gate.promise;
        }
        return json({ memories: snapshot, maxSites: 100, maxInstructions: 4000 });
      }
      if (request.method() === 'PUT') {
        const { site, instructions } = request.postDataJSON();
        const memory = saved(site, instructions);
        state.memories.set(site, memory);
        return json({ memory });
      }
      if (request.method() === 'DELETE') {
        state.memories.delete(url.searchParams.get('site'));
        return json({ ok: true });
      }
    }
    if (url.pathname === '/api/chat') return route.fulfill({
      contentType: 'application/x-ndjson',
      body: (events || [{ t: 'd', v: 'A helpful answer.' }, finalEvent]).map(event => JSON.stringify(event)).join('\n') + '\n',
    });
    state.errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  await page.goto(standalone ? 'https://pagebot.example.test/chat' : 'https://news.example.test/article');
  const frame = standalone ? page.mainFrame() : page.frames().find(frame => frame.url().startsWith('https://pagebot.example.test/'));
  assert.ok(frame, 'the widget frame loaded');
  try { await frame.locator('#setBtn').waitFor({ state: 'visible' }); }
  catch (error) {
    t.diagnostic(JSON.stringify({ requests: state.requests, view: await frame.locator('body').innerText() }));
    throw error;
  }
  await frame.locator('#boot').waitFor({ state: 'detached' });
  const openSettings = async () => {
    await frame.locator('#setBtn').click();
    await goCat(frame, 'memory'); // the memory form is in the Memory & commands category
    await frame.locator('#memoryForm').waitFor({ state: 'visible' });
  };
  const waitValue = async (selector, value) => {
    await frame.waitForFunction(({ selector, value }) => document.querySelector(selector)?.value === value, { selector, value });
  };
  const settleRendering = () => frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return { context, page, frame, state, openSettings, waitValue, settleRendering };
}

browserTest('website instructions persist after editing, reloading, and deletion', async t => {
  const f = await fixture(t, { memories: [saved('news.example.test', 'Explain unfamiliar terms.')] });
  await f.openSettings();
  await f.waitValue('#memoryInstructions', 'Explain unfamiliar terms.');
  assert.equal(await f.frame.locator('#memorySite').inputValue(), 'news.example.test');

  await f.frame.locator('#memoryInstructions').fill('Use short summaries.\nPreserve <literal> examples.');
  await f.frame.locator('#memorySave').click();
  await f.frame.waitForFunction(() => /saved/i.test(document.querySelector('#memoryStatus').textContent));
  assert.equal(f.state.memories.get('news.example.test').instructions, 'Use short summaries.\nPreserve <literal> examples.');

  await f.frame.goto('https://pagebot.example.test/widget?v=7');
  await f.frame.locator('#boot').waitFor({ state: 'detached' });
  await f.openSettings();
  await f.waitValue('#memoryInstructions', 'Use short summaries.\nPreserve <literal> examples.');
  await f.frame.locator('#memoryDelete').click();
  await f.waitValue('#memoryInstructions', '');
  assert.equal(f.state.memories.has('news.example.test'), false);
  assert.equal(await f.frame.locator('#memorySites option[value="news.example.test"]').count(), 0);
});

browserTest('current website and saved-site selection keep subdomain instructions separate', async t => {
  const f = await fixture(t, { memories: [
    saved('example.test', 'Root site only.'),
    saved('news.example.test', 'News site only.'),
  ] });
  await f.openSettings();
  await f.waitValue('#memoryInstructions', 'News site only.');
  await f.frame.locator('#memorySites').selectOption('example.test');
  await f.waitValue('#memoryInstructions', 'Root site only.');
  await f.frame.locator('#memoryCurrent').click();
  await f.waitValue('#memoryInstructions', 'News site only.');
  assert.equal(await f.frame.locator('#memorySite').inputValue(), 'news.example.test');
  const requests = await f.page.evaluate(() => window.hostRequests.filter(request => request.type === 'page'));
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.max === 1), 'settings should request the URL without extracting page text');
});

browserTest('standalone chat can manage instructions for an explicitly entered website', async t => {
  const f = await fixture(t, { standalone: true });
  await f.openSettings();
  assert.equal(await f.frame.locator('#memoryCurrent').isVisible(), false);
  await f.frame.locator('#memorySite').fill('https://Example.test/some/page');
  await f.frame.locator('#memoryLoad').click();
  await f.frame.locator('#memoryInstructions:not([disabled])').waitFor();
  assert.equal(await f.frame.locator('#memorySite').inputValue(), 'example.test');
  await f.frame.locator('#memoryInstructions').fill('Explain the examples in plain language.');
  await f.frame.locator('#memorySave').click();
  await f.frame.waitForFunction(() => /saved/i.test(document.querySelector('#memoryStatus').textContent));
  assert.equal(f.state.memories.get('example.test').instructions, 'Explain the examples in plain language.');
});

browserTest('chat carries the current website when Page text is turned off', async t => {
  const f = await fixture(t);
  await f.frame.locator('#pagePill').click();
  await f.frame.locator('#q').fill('What should I read next?');
  await f.frame.locator('#sendBtn').click();
  await f.frame.locator('.msg.bot .meta').waitFor();
  const request = f.state.requests.find(request => request.path === '/api/chat');
  assert.equal(request.body.site, 'news.example.test');
  assert.equal(request.body.page, null);
  const pageRequests = await f.page.evaluate(() => window.hostRequests.filter(request => request.type === 'page'));
  assert.equal(pageRequests.at(-1).max, 1, 'turning off page text should avoid extracting the document');
});

browserTest('a delayed website list cannot restore private instructions after logout', async t => {
  const f = await fixture(t, { memories: [saved('news.example.test', 'Private instructions.')] });
  const gate = { ...deferred(), started: deferred() };
  t.after(() => gate.resolve());
  f.state.blockNextList = gate;
  await f.openSettings();
  await gate.started.promise;
  await goCat(f.frame, 'account');
  await f.frame.locator('#outBtn').click();
  await f.frame.locator('#login').waitFor({ state: 'visible' });
  const response = f.page.waitForResponse(response => response.url().endsWith('/api/site-memory'));
  gate.resolve();
  await response;
  await f.settleRendering();
  assert.equal(await f.frame.locator('#memoryInstructions').inputValue(), '');
  assert.equal(await f.frame.locator('#memorySites option[value="news.example.test"]').count(), 0);
  assert.equal(await f.frame.locator('#sheet').isVisible(), false);
});

browserTest('an old settings request cannot replace the current website after navigation', async t => {
  const f = await fixture(t, { memories: [
    saved('news.example.test', 'First website.'),
    saved('other.example.test', 'Second website.'),
  ] });
  const gate = { ...deferred(), started: deferred() };
  t.after(() => gate.resolve());
  f.state.blockNextList = gate;
  await f.openSettings();
  await gate.started.promise;
  await f.frame.locator('#setBtn').click();
  await f.page.evaluate(() => { window.hostUrl = 'https://other.example.test/new-page'; });
  await f.openSettings();
  await f.waitValue('#memoryInstructions', 'Second website.');
  const response = f.page.waitForResponse(response => response.url().endsWith('/api/site-memory'));
  gate.resolve();
  await response;
  await f.settleRendering();
  assert.equal(await f.frame.locator('#memorySite').inputValue(), 'other.example.test');
  assert.equal(await f.frame.locator('#memoryInstructions').inputValue(), 'Second website.');
});

browserTest('streaming batches rendering and preserves completed citations', async t => {
  const deltas = Array.from({ length: 240 }, (_, i) => ({ t: 'd', v: `word${i} ` }));
  const answer = deltas.map(event => event.v).join('');
  const f = await fixture(t, { events: [
    ...deltas,
    { ...finalEvent, cites: [{ at: answer.length, q: [0] }], quotes: ['From the page'] },
  ] });
  await f.frame.evaluate(() => {
    window.answerUpdates = 0;
    new MutationObserver(records => {
      window.answerUpdates += records.filter(record => record.target.matches?.('.msg.bot .body')).length;
    }).observe(document.querySelector('#log'), { childList: true, subtree: true });
  });
  await f.frame.locator('#q').fill('Summarize this page.');
  await f.frame.locator('#sendBtn').click();
  await f.frame.locator('.msg.bot .meta').waitFor();
  await f.settleRendering();
  assert.match(await f.frame.locator('.msg.bot .body').innerText(), /word239/);
  assert.equal(await f.frame.locator('.cite').count(), 1, 'a pending render must not erase completion citations');
  assert.ok(await f.frame.evaluate(() => window.answerUpdates < 30), 'one network burst should not rerender Markdown for every delta');
  await f.frame.locator('.cite').click();
  await f.frame.locator('.cite.on').waitFor();
  assert.equal(await f.page.evaluate(() => window.hostRequests.find(request => request.type === 'find').text), 'From the page');
});

browserTest('older bookmarks keep the update prompt and reopen without an intro overlay', async t => {
  const f = await fixture(t, { version: 8 });
  assert.equal(await f.frame.locator('#upd').isVisible(), true);
  assert.equal(await f.frame.locator('#updGo').getAttribute('href'), '/?update');
  await f.openSettings();
  await goCat(f.frame, 'about');
  assert.match(await f.frame.locator('#verLine').innerText(), /pagebot v8.*your bookmark is v7/);
  await f.frame.locator('#setBtn').click();
  await f.frame.locator('#updX').click();
  assert.equal(await f.frame.locator('#upd').isVisible(), false);
  await f.page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ type: 'hidden' }, 'https://pagebot.example.test'));
  await f.settleRendering();
  assert.equal(await f.frame.locator('#boot').count(), 0);
  const refreshed = f.page.waitForResponse(response => response.url().endsWith('/api/boot'));
  await f.page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ type: 'open' }, 'https://pagebot.example.test'));
  await refreshed;
  await f.settleRendering();
  assert.equal(await f.frame.locator('#boot').count(), 0);
  assert.equal(await f.frame.locator('#q').isVisible(), true);
  assert.equal(await f.frame.locator('#upd').isVisible(), false, 'dismissal lasts until the widget loads again');
});

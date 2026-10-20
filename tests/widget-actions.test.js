import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// Page actions in the panel: step lines, skip mode, and when the toggle is unavailable (v12: the browser toolset; the
// real bookmarklet, screenshots and the Share this tab card are in widget-browser.test.js). Clicks and typing are part B's:
// until then the panel refuses them at once, and the approval-card tests below wait for part B (TODO(part B)).
// Playwright with a local Chromium; every HTTP response is a fixture and the "bookmarklet" is a small fake in the host page.
// /api/chat is a stream the test feeds by hand (window.__push), so an answer can stay open while a card waits.
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
  user: { id: 1, name: 'Test reader', status: 'trusted', allowWeb: true, allowActions: true, passcode: false },
  prefs: { theme: 'ember', model: 'haiku', web: false, actions: true, actionsAuto: false },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku' }],
};
const done = { t: 'done', conversationId: 7, model: 'haiku', usage: { in: 50, out: 20 }, stop: 'end_turn' };

async function fixture(t, { standalone = false, hostV = 12, prefs = {}, user = {} } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1000, height: 900 } });
  context.setDefaultTimeout(5000);
  const state = { requests: [], errors: [], prefs: { ...boot.prefs, ...prefs } };
  t.after(async () => {
    await context.close();
    assert.deepEqual(state.errors, [], 'the widget must not raise browser errors or make unexpected requests');
  });
  await context.addInitScript(() => {
    localStorage.setItem('pb_token', 'test-session');
    // /api/chat stays open until the test ends it
    const real = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url) !== '/api/chat') return real(url, opts);
      const enc = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({ start(c) {
        window.__push = ev => c.enqueue(enc.encode(JSON.stringify(ev) + '\n'));
        window.__end = () => c.close();
        opts?.signal?.addEventListener('abort', () => { try { c.close(); } catch {} });
      } }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
    };
  });
  // the page's side: an Email box (1), a Next link that leaves the page (2), a Save button that doesn't (3)
  const hostPage = `<!doctype html><html><body><script>
    window.hostUrl = 'https://news.example.test/article'; window.hostRequests = [];
    const info = { 1: { role: 'textbox', label: 'Email', nav: '' }, 2: { role: 'link', label: 'Next', nav: 'https://other.example.test/next' }, 3: { role: 'button', label: 'Save', nav: '' } };
    addEventListener('message', event => {
      if (event.source !== document.querySelector('iframe')?.contentWindow) return;
      const r = event.data, send = x => event.source.postMessage({ id: r.id, ...x }, event.origin);
      window.hostRequests.push(r);
      if (r.type === 'page') return send({ page: { url: window.hostUrl, title: 'Article', text: 'From the page' }, selection: '' });
      // v12's browser tools
      if (r.type === 'tool') return send(r.name === 'read_page' ? { text: 'textbox "Email" [ref_1] value=""\\nlink "Next" [ref_2] leaves the page\\nbutton "Save" [ref_3]', cut: false }
        : r.name === 'find' ? { text: 'button "Save" [ref_3]', n: 1 } : r.name === 'scroll' ? { moved: true } : { error: 'not in this fake' });
      if (r.type !== 'act') return;
      const i = info[r.input && r.input.ref];
      if (r.name === 'els') return send({ els: [{ ref: 1, role: 'textbox', label: 'Email', value: '' }, { ref: 3, role: 'button', label: 'Save' }], more: 0 });
      if (!i) return send({ no: 'gone' });
      send(r.name === 'fill' && !r.dry ? { ...i, value: r.input.text } : i);
    });
  </script><iframe title="Pagebot" src="https://pagebot.example.test/widget?v=${hostV}" style="width:440px;height:840px;border:0"></iframe></body></html>`;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: hostPage });
    if (url.pathname === '/widget' || url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    state.requests.push({ path: url.pathname, body: request.postDataJSON() });
    if (url.pathname === '/api/boot') return json({ ...boot, user: { ...boot.user, ...user }, prefs: state.prefs, version: 9 });
    if (url.pathname === '/api/ping' || url.pathname === '/api/logout') return json({ ok: true });
    if (url.pathname === '/api/prefs') { Object.assign(state.prefs, request.postDataJSON()); return json({ prefs: state.prefs, limits: boot.limits }); }
    if (url.pathname === '/api/chat/act') return json({ ok: true });
    if (url.pathname === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
    state.errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  await page.goto(standalone ? 'https://pagebot.example.test/chat' : 'https://news.example.test/article');
  const frame = standalone ? page.mainFrame() : page.frames().find(f => f.url().startsWith('https://pagebot.example.test/'));
  await frame.locator('#setBtn').waitFor({ state: 'visible' });
  await frame.locator('#boot').waitFor({ state: 'detached' });
  const acts = () => state.requests.filter(r => r.path === '/api/chat/act').map(r => r.body);
  const hostActs = () => page.evaluate(() => window.hostRequests.filter(r => (r.type === 'act' || r.type === 'tool') && !r.dry));
  const push = ev => frame.evaluate(e => window.__push(e), ev);
  const ask = async () => {
    await frame.locator('#q').fill('Fill this in');
    await frame.locator('#sendBtn').click();
    await frame.waitForFunction(() => !!window.__push);
  };
  const waitActs = async n => {
    for (const end = Date.now() + 4000; acts().length < n; await new Promise(r => setTimeout(r, 30))) if (Date.now() > end) assert.fail(`expected ${n} results, got ${acts().length}`);
  };
  return { page, frame, state, acts, hostActs, push, ask, waitActs };
}
const fill = (id, text = 'a@b.test') => ({ t: 'act', id, name: 'fill', input: { ref: 1, text }, wait: 300000 });

browserTest('reading runs by itself as a step, notes show as progress lines, and clicks and typing are refused for now without reaching the page', async t => {
  const f = await fixture(t);
  assert.equal(await f.frame.locator('#actPill').isVisible(), true);
  await f.ask();
  await f.push({ t: 'note', v: 'Looking at the form first.' });
  await f.push({ t: 'mystery', v: 'an event this panel has never heard of' });
  await f.push({ t: 'act', id: 'r1', name: 'read_page', input: { depth: 15 }, wait: 20000, ask: false });
  await f.waitActs(1);
  assert.deepEqual(f.acts()[0], { id: 'r1', note: 'Read the page', result: { text: 'textbox "Email" [ref_1] value=""\nlink "Next" [ref_2] leaves the page\nbutton "Save" [ref_3]', cut: false } });
  assert.equal(await f.frame.locator('.acard').count(), 0, 'reading does not ask');
  await f.push({ t: 'act', id: 'r2', name: 'find', input: { query: 'save button' }, wait: 20000, ask: false });
  await f.waitActs(2);
  assert.deepEqual(f.acts()[1].result, { text: 'button "Save" [ref_3]', n: 1 });
  assert.deepEqual(await f.frame.locator('.steps > *').evaluateAll(els => els.map(e => [e.className, e.innerText.replace(/\s+/g, ' ').trim()])), [
    ['anote', 'Looking at the form first.'], ['astep done', '📄 Read the page'], ['astep done', '🔎 Looked for “save button” (1 found)']]);
  // TODO(part B): these run, behind the approval card; until then the model hears at once that they aren't available
  for (const [id, name, input] of [['c1', 'left_click', { target: { type: 'ref', ref: 'ref_3' } }], ['c2', 'type', { text: 'a@b.test' }], ['c3', 'key', { text: 'Enter', repeat: 1 }]]) {
    await f.push({ t: 'act', id, name, input, wait: 300000, ask: true });
  }
  await f.waitActs(5);
  for (const r of f.acts().slice(2)) assert.match(r.result.error, /^Not available yet: pagebot can’t click, type or press keys/);
  assert.deepEqual(f.acts().slice(2).map(r => r.note), ['Click on the page', 'Type on the page', 'Press keys']);
  assert.equal(await f.frame.locator('.acard').count(), 0, 'no approval card for something that can’t happen');
  assert.match(await f.frame.locator('.astep.fail .at').first().innerText(), /^Click on the page — Not available yet/);
  assert.deepEqual((await f.hostActs()).map(r => r.type + ':' + r.name), ['tool:read_page', 'tool:find'], 'nothing but the reading reached the page');
  await f.push({ t: 'd', v: 'Tell me when you have saved.' }); await f.push(done);
  await f.frame.locator('.msg.bot .meta').waitFor();
});

browserTest('reading runs by itself as a step; edits wait for Allow or Skip, and Allow all covers the rest of the answer', { skip: 'TODO(part B): approval cards for clicks and typing' }, async t => {
  const f = await fixture(t);
  assert.equal(await f.frame.locator('#actPill').isVisible(), true);
  await f.ask();
  await f.push({ t: 'act', id: 'r1', name: 'find_elements', input: {}, wait: 20000 });
  await f.waitActs(1);
  assert.equal(f.acts()[0].id, 'r1');
  assert.equal(f.acts()[0].result.els[0].label, 'Email');
  assert.equal(await f.frame.locator('.acard').count(), 0, 'reading does not ask');
  assert.match(await f.frame.locator('.astep .at').first().innerText(), /Looked at the page’s buttons and fields/);

  // Allow: the page does it, and the result goes back
  await f.push(fill('f1'));
  await f.frame.locator('.acard').waitFor();
  assert.match(await f.frame.locator('.acard .aq').innerText(), /Type “a@b.test” into the “Email” box/);
  assert.deepEqual(await f.frame.locator('.acard button').allInnerTexts(), ['Allow', 'Skip', 'Allow all for this answer']);
  assert.equal((await f.hostActs()).filter(r => r.name === 'fill').length, 0, 'nothing runs before you choose');
  await f.frame.getByRole('button', { name: 'Allow', exact: true }).click();
  await f.waitActs(2);
  assert.equal(f.acts()[1].result.value, 'a@b.test');
  assert.equal((await f.hostActs()).filter(r => r.name === 'fill').length, 1);
  assert.match(await f.frame.locator('.astep .at').nth(1).innerText(), /^Typed “a@b.test” into the “Email” box/);

  // Skip: the model hears "denied" and the page is left alone
  await f.push(fill('f2', 'other'));
  await f.frame.locator('.acard').waitFor();
  await f.frame.getByRole('button', { name: 'Skip', exact: true }).click();
  await f.waitActs(3);
  assert.equal(f.acts()[2].denied, true);
  assert.equal((await f.hostActs()).filter(r => r.name === 'fill').length, 1);
  assert.match(await f.frame.locator('.astep .at').nth(2).innerText(), /skipped/);

  // Allow all: this one and the next run without a card
  await f.push(fill('f3', 'third'));
  await f.frame.locator('.acard').waitFor();
  await f.frame.getByRole('button', { name: 'Allow all for this answer' }).click();
  await f.waitActs(4);
  await f.push(fill('f4', 'fourth'));
  await f.waitActs(5);
  assert.equal(await f.frame.locator('.acard').count(), 0);
  assert.equal(f.acts()[4].result.value, 'fourth');

  await f.push({ t: 'd', v: 'All filled in.' }); await f.push(done);
  await f.frame.locator('.msg.bot .meta').waitFor();
  assert.match(await f.frame.locator('.msg.bot .body').innerText(), /All filled in/);
});

browserTest('a click that leaves the page always asks, even with permissions skipped, and has no Allow all', { skip: 'TODO(part B): approval cards for clicks and typing' }, async t => {
  const f = await fixture(t, { prefs: { actionsAuto: true } });
  assert.equal(await f.frame.locator('#actTag').isVisible(), true, 'the pill says auto');
  await f.ask();
  await f.push({ t: 'act', id: 'c1', name: 'click', input: { ref: 3 }, wait: 300000 }); // Save: stays on the page
  await f.waitActs(1);
  assert.equal(await f.frame.locator('.acard').count(), 0, 'skip mode runs a click that stays on the page');
  await f.push({ t: 'act', id: 'c2', name: 'click', input: { ref: 2 }, wait: 300000 }); // Next: another page
  await f.frame.locator('.acard.nav').waitFor();
  assert.match(await f.frame.locator('.acard .aw').innerText(), /leaves the page.*other\.example\.test.*closes with it/s);
  assert.deepEqual(await f.frame.locator('.acard button').allInnerTexts(), ['Allow', 'Skip']);
  await f.frame.getByRole('button', { name: 'Skip', exact: true }).click();
  await f.waitActs(2);
  assert.equal(f.acts()[1].denied, true);
  assert.equal((await f.hostActs()).filter(r => r.input?.ref === 2).length, 0, 'the link was never clicked');
});

browserTest('Skip all permissions asks for a confirmation about hidden page instructions before it turns on', async t => {
  const f = await fixture(t);
  assert.equal(await f.frame.locator('#actTag').isVisible(), false);
  await f.frame.locator('#setBtn').click();
  await f.frame.locator('#tab-actions').click(); // Settings is a list of categories at this width
  assert.equal(await f.frame.locator('#actAsk').getAttribute('aria-checked'), 'true', 'asking is the default');
  await f.frame.locator('#actSkip').click();
  assert.match(await f.frame.locator('#actWarn').innerText(), /hide instructions/);
  assert.equal(f.state.requests.filter(r => r.path === '/api/prefs').length, 0, 'nothing is saved before the confirmation');
  await f.frame.locator('#actNo').click();
  assert.equal(await f.frame.locator('#actWarn').isVisible(), false);
  assert.equal(f.state.prefs.actionsAuto, false);

  await f.frame.locator('#actSkip').click();
  await f.frame.locator('#actYes').click();
  await f.frame.waitForFunction(() => document.querySelector('#actSkip').getAttribute('aria-checked') === 'true');
  assert.equal(f.state.prefs.actionsAuto, true);
  assert.equal(await f.frame.locator('#actTag').isVisible(), true);
  assert.equal(await f.frame.locator('#actPill').evaluate(e => e.classList.contains('auto')), true);

  await f.frame.locator('#actAsk').click();
  await f.frame.waitForFunction(() => document.querySelector('#actAsk').getAttribute('aria-checked') === 'true');
  assert.equal(f.state.prefs.actionsAuto, false, 'switching back needs no confirmation');
  assert.equal(await f.frame.locator('#actTag').isVisible(), false);
});

browserTest('the Actions toggle is unavailable, with a reason, on /chat, on bookmarks older than 12, and without access', async t => {
  const chat = await fixture(t, { standalone: true });
  assert.equal(await chat.frame.locator('#actPill').isVisible(), false);
  assert.equal(await chat.frame.locator('#actBtn').isVisible(), false, 'there is no page on /chat to act on');

  const old = await fixture(t, { hostV: 11 }); // v11 can't see into shadow DOM or frames, scroll or hover
  assert.equal(await old.frame.locator('#actPill').isVisible(), false);
  await old.frame.locator('#addBtn').click();
  assert.equal(await old.frame.locator('#actBtn').isDisabled(), true);
  assert.match(await old.frame.locator('#actNote').innerText(), /new bookmark/);

  const denied = await fixture(t, { user: { allowActions: false } });
  assert.equal(await denied.frame.locator('#actPill').isVisible(), false);
  await denied.frame.locator('#addBtn').click();
  assert.match(await denied.frame.locator('#actNote').innerText(), /Not turned on for your account/);
  await denied.frame.locator('#setBtn').click();
  await denied.frame.locator('#tab-actions').click();
  assert.equal(await denied.frame.locator('#actSec').isVisible(), false);
  assert.match(await denied.frame.locator('#actAvail').innerText(), /Not turned on for your account/, 'and Settings says why');

  const on = await fixture(t);
  await on.frame.locator('#addBtn').click();
  assert.equal(await on.frame.locator('#actBtn').isEnabled(), true);
  assert.equal(await on.frame.locator('#actBtn').getAttribute('aria-checked'), 'true');
  await on.frame.locator('#actBtn').click();
  await on.frame.waitForFunction(() => document.querySelector('#actPill').hidden);
  assert.equal(on.state.prefs.actions, false);
});

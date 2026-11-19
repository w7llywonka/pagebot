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
// WCAG contrast of two computed colours ("rgb(…)" / "rgba(…)"), the top one laid over the bottom one
const rgb = c => c.match(/[\d.]+/g).map(Number);
const contrast = (fg, bg) => {
  const [r1, g1, b1, a = 1] = rgb(fg), [r2, g2, b2] = rgb(bg), f = [r1 * a + r2 * (1 - a), g1 * a + g2 * (1 - a), b1 * a + b2 * (1 - a)];
  const lum = c => c.map(x => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((s, x, i) => s + x * [.2126, .7152, .0722][i], 0);
  const [x, y] = [lum(f), lum([r2, g2, b2])]; return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// /chat with the given boot. `chat(body, n)` answers the n-th question: { events }, { status, json }, 'abort', or a promise of one.
async function fixture(t, { boot = account, token = true, store = {}, chat, chats = [], viewport = { width: 900, height: 800 }, clipboard = false, touch = false } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport, timezoneId: 'UTC', ...(touch && { hasTouch: true, isMobile: true }) });
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
  // /chat has no page of its own, so it doesn't claim to read one (the panel says "I read the page you’re on…")
  assert.match(await page.locator('#welcome').innerText(), /Hi, I’m pagebot\.\s+I answer your questions, and with the bookmark I can read the page you’re on\./);
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

browserTest('"Ask to join" is taller than a 380x560 panel: it starts at its top and scrolls down to its last button', async t => {
  const { page } = await fixture(t, { boot: signedOut(true), token: false, viewport: { width: 380, height: 560 } });
  await page.locator('#wNew').click();
  await page.locator('#uPass2').waitFor({ state: 'visible' });
  const at = () => page.evaluate(() => {
    const box = document.querySelector('#login').getBoundingClientRect(), top = s => document.querySelector(s).getBoundingClientRect().top;
    const last = [...document.querySelectorAll('#lockLinks button')].at(-1).getBoundingClientRect();
    return { overflow: document.querySelector('#login').scrollHeight > box.height + 1, box: box.top, icon: top('#login .lk'), title: top('#lockTitle'), last: last.bottom, bottom: box.bottom };
  });
  const a = await at();
  assert.ok(a.overflow, 'the form is taller than the panel here (else this checks nothing)');
  assert.ok(a.icon >= a.box && a.title > a.icon, `nothing sits above the top, where it couldn't be scrolled to: ${JSON.stringify(a)}`);
  await page.locator('#login').evaluate(e => { e.scrollTop = e.scrollHeight; });
  const b = await at();
  assert.ok(b.last <= b.bottom + 1, `"I already have an account" scrolls into view: ${JSON.stringify(b)}`);
});

browserTest('"I already have an account" goes to the sign-in form; a returning browser goes straight there; with sign-ups off there is no hello', async t => {
  const fresh = await fixture(t, { boot: signedOut(true), token: false });
  await fresh.page.locator('#wHave').click();
  assert.equal(await fresh.page.locator('#lockTitle').innerText(), 'Sign in');
  assert.equal(await fresh.page.locator('#uGo').innerText(), 'Sign in');
  assert.equal(await fresh.page.locator('#lockSub').innerText(), 'Sign in to chat with pagebot.', '/chat has no page of its own to ask about');
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
  const { page, state, ask } = await fixture(t, { store: { pb_theme: 'paper' }, chat: (body, n) => n === 1 // (the first frame's theme is the boot's: no colours in transition)
    ? { events: [{ t: 'id', conversationId: 42 }, { t: 'd', v: 'The first half of an answer.' }, { t: 'err', v: 'The API is overloaded — try again in a moment.', conversationId: 42 }] }
    : { events: [{ t: 'd', v: 'The whole answer this time.' }, done()] } });
  await ask('Tell me about this');
  const bot = page.locator('.msg.bot.err');
  await bot.locator('.retry button').waitFor();
  const [partial, line] = await bot.locator('.body > p').evaluateAll(ps => ps.map(p => ({ text: p.textContent, color: getComputedStyle(p).color })));
  assert.equal(partial.text, 'The first half of an answer.');
  assert.equal(line.text, '⚠ pagebot is busy right now. Try again in a moment.', 'no "API" in the words');
  const [text, err] = await page.evaluate(() => ['--text', '--err'].map(v => { const i = document.body.appendChild(document.createElement('i')); i.style.color = `var(${v})`; const c = getComputedStyle(i).color; i.remove(); return c; }));
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0, 'nothing is mid-transition');
  assert.equal(partial.color, text, 'what arrived is in the normal text colour');
  assert.equal(line.color, err, 'only the last line is in the error colour');
  assert.equal(await bot.getAttribute('aria-label'), 'pagebot couldn’t finish', 'not named as an answer');
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
  assert.equal(await page.locator('.msg.bot.err').getAttribute('aria-label'), 'pagebot couldn’t answer');
  assert.doesNotMatch(text, /fetch|HTTP/i);
  await page.locator('.msg.bot.err .retry button').click();
  await page.locator('.msg.bot .meta').waitFor();
  assert.equal(state.chats.length, 2);
  assert.equal(await page.locator('.msg.user').count(), 1, 'the server never had it, so the question shows once');
  assert.equal(await page.locator('.msg.bot.err').count(), 0);
});

browserTest('at the daily limit: a calm card, a quieter Send that still works, the question back in the box, and trying again adds nothing new', async t => {
  const { page, state, ask } = await fixture(t, { boot: { ...account, quota: { pct: 97 } }, store: { pb_theme: 'paper' },
    chat: () => ({ status: 429, json: { error: 'You’ve used today’s limit. It resets at midnight.', quota: { pct: 100 } } }) });
  assert.equal(await page.locator('#limitCard').isVisible(), false, 'nothing before the limit');
  await ask('One more question');
  await page.locator('#limitCard').waitFor({ state: 'visible' });
  assert.match(await page.locator('#limitCard').innerText(), /That’s today’s limit\. It resets at midnight\. Your chats stay here\./, 'the same words as the chat');
  assert.equal(await page.locator('.msg.bot.limit').getAttribute('aria-label'), 'pagebot couldn’t answer');
  assert.match(await page.locator('#log').innerText(), /You’ve used today’s limit\. It resets at midnight\./, 'the server’s sentence stays in the chat');
  assert.equal(await page.locator('.msg.bot.limit').count(), 1);
  const [ink, text] = await page.locator('.msg.bot.limit .body p').evaluate(p => [getComputedStyle(p).color, getComputedStyle(document.body).color]);
  assert.equal(ink, text, 'a limit is a state, not an error: no error colour');
  await page.waitForFunction(() => document.querySelector('#q').value === 'One more question');
  assert.equal(await page.locator('#composer').evaluate(e => e.classList.contains('limited')), true);
  const nudge = await page.evaluate(() => [...document.styleSheets].flatMap(s => [...s.cssRules]).filter(r => r.selectorText === '#limitCard.nudge')
    .map(r => parseFloat(r.style.animationDuration) / (r.style.animationDuration.endsWith('ms') ? 1000 : 1)));
  assert.ok(nudge.length && nudge.every(s => s >= .12 && s <= .2), `the card's nudge is a short one, 120 to 200ms (${nudge}s)`);
  await sendKeepsContrast(page, 'paper');
  await page.locator('#sendBtn').click(); // the server still decides (it may be past midnight)
  for (let i = 0; i < 100 && state.chats.length < 2; i++) await page.waitForTimeout(50);
  assert.equal(state.chats.length, 2);
  await page.waitForFunction(() => document.querySelectorAll('.msg').length === 2 && document.querySelector('#q').value === 'One more question');
  assert.equal(await page.locator('.msg.bot').count(), 1, 'no second message for the same limit');
  await page.locator('#limitUsage').click();
  await page.locator('#cat-usage').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#quotaText').innerText(), 'Today’s limit used up');
});

// at the limit Send is quieter (a soft fill, an outline) but it still sends, so it keeps 3:1 for its edge and 4.5:1 for its arrow
async function sendKeepsContrast(page, theme) {
  const m = await page.evaluate(() => {
    const go = getComputedStyle(document.querySelector('#sendBtn')), box = getComputedStyle(document.querySelector('#composer .box'));
    const accent = (i => { i.style.color = 'var(--accent)'; const c = getComputedStyle(i).color; i.remove(); return c; })(document.body.appendChild(document.createElement('i')));
    return { opacity: go.opacity, fill: go.backgroundColor, arrow: go.color, edge: go.boxShadow.match(/rgba?\([^)]*\)/)?.[0], box: box.backgroundColor, accent };
  });
  assert.equal(m.opacity, '1', `${theme}: not faded`);
  assert.notEqual(m.fill, m.accent, `${theme}: quieter than the accent`);
  assert.ok(contrast(m.edge, m.box) >= 3, `${theme}: its edge on the message box is ${contrast(m.edge, m.box).toFixed(2)}`);
  assert.ok(contrast(m.arrow, m.fill) >= 4.5, `${theme}: its arrow is ${contrast(m.arrow, m.fill).toFixed(2)}`);
}

browserTest('at the limit the quieter Send keeps its contrast in Blossom and in every other solid theme', async t => {
  const sakura = { ...account, theme: 'sakura', prefs: { ...account.prefs, theme: 'sakura' }, quota: { pct: 100 } };
  const { page } = await fixture(t, { boot: sakura, store: { pb_theme: 'sakura' } });
  await page.locator('#limitCard').waitFor({ state: 'visible' });
  await sendKeepsContrast(page, 'sakura');
  const solid = [...widget.slice(widget.indexOf('const THEMES = ['), widget.indexOf('const light = matchMedia')).matchAll(/^\s*\['([a-z]+)', '[^']+', '#/gm)].map(m => m[1]);
  assert.equal(solid.length, 11);
  for (const name of solid) { // (Glass and Clear: the same tokens, measured over a page in widget-palette.test.js)
    await page.evaluate(name => { document.documentElement.dataset.theme = name; document.getAnimations().forEach(a => a.finish()); }, name);
    await sendKeepsContrast(page, name);
  }
});

// the first screen with banners and the limit card: nothing is cut off by the message box. What makes way, in order: the help
// line (and the card keeps to one line), then the announcement folds, and at the limit the starters go last
const longNews = { id: 4, body: 'Heads up: I’m moving pagebot to a new server on Saturday morning, so it may be offline for about an hour. Details: https://status.example.org/pagebot', createdAt: new Date().toISOString() };
const firstScreen = page => page.evaluate(() => {
  const box = s => document.querySelector(s).getBoundingClientRect(), shown = s => !!document.querySelector(s)?.offsetParent;
  return { bottom: Math.max(...[...document.querySelectorAll('.empty .hello, .starters button')].map(b => b.getBoundingClientRect().bottom)),
    room: Math.min(box('#composer').top, box('#log').bottom), help: shown('.empty p'), starters: shown('.starters'),
    annFolded: document.querySelector('#ann').classList.contains('fold'), card: box('#limitCard').height, theme: document.documentElement.dataset.theme };
});
browserTest('on a short panel, banners and the limit card never leave a starter cut off by the message box', async t => {
  const commands = [{ name: 'tldr', prompt: 'Give me a two-sentence summary of this page.', starter: true }];
  const cases = [
    ['at the limit, 380x560', { quota: { pct: 100 } }, { width: 380, height: 560 }, {}, { starters: true }],
    ['two banners, 380x560', { restriction, announcement: longNews }, { width: 380, height: 560 }, {}, { starters: true }],
    ['two banners in Terminal, 720x720 (the panel’s usual size)', { restriction, announcement: longNews, theme: 'terminal', prefs: { ...account.prefs, theme: 'terminal' } }, { width: 720, height: 720 }, { pb_theme: 'terminal' }, { theme: 'terminal', starters: true, annFolded: false }],
    ['two banners and the limit, 720x640', { restriction, announcement: longNews, quota: { pct: 100 } }, { width: 720, height: 640 }, {}, { help: false, annFolded: true, starters: false }],
    ['two banners and the limit, 380x560', { restriction, announcement: longNews, quota: { pct: 100 } }, { width: 380, height: 560 }, {}, { help: false, annFolded: true, starters: false }],
    ['two banners with room to spare, 900x800', { restriction, announcement: longNews }, { width: 900, height: 800 }, {}, { help: true, starters: true, annFolded: false }],
  ];
  for (const [what, extra, viewport, store, expect] of cases) {
    const { page } = await fixture(t, { boot: { ...account, commands, ...extra }, viewport, store });
    await page.locator('.starters button.mine').waitFor({ state: 'attached' });
    let m;
    for (let i = 0; i < 20; i++) { m = await firstScreen(page); if (m.bottom <= m.room + 1) break; await page.waitForTimeout(50); } // (it settles in the next frame)
    assert.ok(m.bottom <= m.room + 1, `${what}: the first screen ends above the message box ${JSON.stringify(m)}`);
    for (const [k, v] of Object.entries(expect)) assert.equal(m[k], v, `${what}: ${k} ${JSON.stringify(m)}`);
    if (extra.quota) assert.ok(m.card <= 56, `${what}: the card is one line (${m.card}px)`);
  }
  // and the help line comes back when the panel is made taller
  const { page } = await fixture(t, { boot: { ...account, commands, restriction, announcement: longNews }, viewport: { width: 380, height: 560 } });
  await page.waitForFunction(() => document.querySelector('.empty')?.classList.contains('snug'));
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForFunction(() => !!document.querySelector('.empty p').offsetParent);
});

browserTest('a heads-up under the answer that takes the day past 80%, once, and "Nearly at today’s limit" past 95%', async t => {
  const pcts = [82, 85, 96, 84];
  const { page, ask } = await fixture(t, { boot: { ...account, quota: { pct: 70 } },
    chat: (body, n) => ({ events: [{ t: 'd', v: 'Answer ' + n }, done({ usage: { pct: 1 }, quota: { pct: pcts[n - 1] } })] }) });
  await ask('First');
  await page.locator('.msg.bot .heads').waitFor();
  assert.match(await page.locator('.msg.bot .heads').innerText(), /^Heads up: about a fifth of today’s limit is left\.\s*See today’s usage$/, 'the same words as the limit card');
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
  // once a day means once a day, not once a page load: the boot says 70% again, and the next answer takes it past 80%
  await page.reload(); await page.locator('#boot').waitFor({ state: 'detached' });
  await ask('Fourth');
  await page.locator('.msg.bot .meta').waitFor();
  assert.equal(await page.locator('.heads').count(), 0, 'already said today');
});

browserTest('the sign-in, waiting and ban screens have a backing in Clear, so the page never runs through their words', async t => {
  const { page } = await fixture(t, { boot: { ...signedOut(true), theme: 'clear' }, token: false, store: { pb_theme: 'clear' } });
  await page.locator('#welcome').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'clear');
  for (const s of ['#login', '#wait', '#ban']) {
    const a = rgb(await page.locator(s).evaluate(e => getComputedStyle(e).backgroundColor))[3] ?? 1;
    assert.ok(a >= .9, `${s} has a backing (alpha ${a})`);
  }
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

browserTest('the new small controls are 40px on touch and have a 36px hit area with a mouse', async t => {
  const boot = { ...account, restriction, announcement, quota: { pct: 70 } };
  const chat = () => ({ events: [{ t: 'd', v: 'An answer.' }, done({ usage: { pct: 1 }, quota: { pct: 82 } })] });
  const sizes = async page => {
    await page.locator('#q').fill('Hi'); await page.locator('#sendBtn').click();
    await page.locator('.heads button').waitFor();
    const sel = ['#rstMore', '#annMore', '#rstX', '#annX', '.heads button'];
    const measure = list => page.evaluate(sel => Object.fromEntries(sel.map(s => {
      const e = document.querySelector(s), r = e.getBoundingClientRect(), hit = getComputedStyle(e, '::after');
      const grow = hit.content === 'none' ? 0 : -2 * parseFloat(hit.top); // the invisible hit area around it
      return [s, { w: r.width, h: r.height, hitW: r.width + grow, hitH: r.height + grow }];
    })), list);
    const out = await measure(sel);
    await page.locator('#setBtn').click();
    if (await page.locator('#shBack').isVisible()) await page.locator('#shBack').click();
    await page.locator('#tab-memory').click();
    await page.locator('#memorySite').fill('example.test'); await page.locator('#memoryLoad').click();
    await page.locator('#memoryInstructions:not([disabled])').waitFor();
    return { ...out, ...await measure(['#memoryChips .chip']) };
  };
  const touch = await fixture(t, { boot, chat, touch: true, viewport: { width: 390, height: 844 } });
  for (const [s, m] of Object.entries(await sizes(touch.page))) assert.ok(m.h >= 40, `${s} is 40px tall on touch (${m.h})`);
  const mouse = await fixture(t, { boot, chat });
  for (const [s, m] of Object.entries(await sizes(mouse.page))) assert.ok(m.hitW >= 36 && m.hitH >= 36, `${s} can be hit over 36px with a mouse (${JSON.stringify(m)})`);
});

browserTest('Settings: the model names push the control under the words instead of squeezing them, and the list says Quick', async t => {
  const narrow = await fixture(t, { viewport: { width: 420, height: 720 } }); // the list of categories, with a summary under each
  await narrow.page.locator('#setBtn').click();
  assert.match(await narrow.page.locator('#tab-general small').innerText(), /^Quick · web search off$/, 'the composer’s word for it');
  const { page } = await fixture(t, { viewport: { width: 720, height: 720 } }); // the panel's usual width, where the two sat side by side
  await page.locator('#setBtn').click();
  if (await page.locator('#tab-general').isVisible()) await page.locator('#tab-general').click();
  const [words, seg] = await Promise.all(['#modelRow .rh', '#modelSeg'].map(s => page.locator(s).boundingBox()));
  assert.ok(words.width >= 220, `the description keeps its room (${words.width}px)`);
  assert.ok(seg.y >= words.y + words.height - 1, 'the control sits under it');
});

browserTest('in Glass the × on an attached picture can be seen', async t => {
  const glass = { ...account, theme: 'glass', prefs: { ...account.prefs, theme: 'glass' } };
  const { page } = await fixture(t, { boot: glass, store: { pb_theme: 'glass' } });
  await page.locator('#addBtn').click();
  await page.locator('#shotBtn').click();
  await page.locator('#att img[src^="data:image"]').waitFor();
  assert.match(await page.locator('#log').innerText(), /To stop, click 📷 Every message in the message box\./, 'where the pill really is');
  const [fg, bg] = await page.locator('#rmAtt').evaluate(e => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]);
  assert.ok(contrast(fg, bg) >= 4.5, `the × is ${contrast(fg, bg).toFixed(2)}:1 on its disc (${fg} on ${bg})`);
});

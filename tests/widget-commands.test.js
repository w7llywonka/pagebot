import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

// Slash commands in the panel, with Playwright and a local Chromium. Every HTTP response is a fixture: no application
// server, database or API key is needed.
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

const RESERVED = ['summarize', 'keypoints', 'simple', 'new', 'web', 'page', 'screenshot', 'region', 'settings', 'help', 'history', 'pdf', 'actions'];
const cmd = (name, prompt, starter = false) => ({ name, prompt, starter, updatedAt: '2026-01-01T00:00:00.000Z' });
const TLDR = cmd('tldr', 'Give me a TL;DR in three bullets.');
const TRANSLATE = cmd('translate', 'Translate the highlighted text into {input}.');
const finalEvent = { t: 'done', conversationId: 42, model: 'haiku', usage: { in: 50, out: 20 }, stop: 'end_turn' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, { standalone = false, commands = [], allowWeb = true, width = 440, height = 840, theme = 'ember' } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1000, height: 900 } });
  context.setDefaultTimeout(5000);
  const state = {
    accounts: { 'test-session': { name: 'alice', commands: [...commands] }, 'bob-session': { name: 'bob', commands: [cmd('bobs', 'Bob’s own prompt.')] } },
    requests: [], errors: [], chatGate: null,
  };
  t.after(async () => {
    state.chatGate?.resolve();
    await context.close();
    assert.deepEqual(state.errors, [], 'the widget must not raise browser errors or make unexpected requests');
  });
  await context.addInitScript(() => localStorage.setItem('pb_token', 'test-session'));
  const hostPage = `<!doctype html><html><body>
    <script>
      window.hostRequests = []; window.pageDelay = 0;
      addEventListener('message', event => {
        if (event.source !== document.querySelector('iframe')?.contentWindow) return;
        const request = event.data;
        window.hostRequests.push(request);
        if (request.type === 'page') setTimeout(() => event.source.postMessage({ id: request.id,
          page: { url: 'https://news.example.test/article', title: 'Article', text: request.max <= 1 ? '' : 'From the page' }, selection: '' }, event.origin), window.pageDelay);
      });
    </script>
    <iframe title="Pagebot" src="https://pagebot.example.test/widget?v=7" style="width:${width}px;height:${height}px;border:0"></iframe>
    </body></html>`;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname === 'news.example.test') return route.fulfill({ contentType: 'text/html', body: hostPage });
    if (url.pathname === '/widget' || url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: widget });
    const token = (request.headers().authorization || '').replace(/^Bearer /, ''), account = state.accounts[token];
    state.requests.push({ path: url.pathname, method: request.method(), body: request.postDataJSON(), url: request.url(), token });
    if (url.pathname === '/api/boot') {
      if (!account) return json({ version: 8, theme, lock: 'password', passwordSet: true, accounts: { on: true, signup: false }, authed: false });
      return json({ version: 8, authed: true, who: 'user', theme, lockMinutes: 0, lock: 'password', passwordSet: true, accounts: { on: true, signup: false },
        user: { name: account.name, status: 'trusted', allowWeb, allowSonnet: true, passcode: false },
        prefs: { theme, model: 'haiku', web: false }, limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 }, models: [{ key: 'haiku', label: 'Haiku' }],
        commands: account.commands, commandLimits: { maxCommands: 50, maxPrompt: 2000, maxStarters: 3, reserved: RESERVED } });
    }
    if (url.pathname === '/api/logout') return json({ ok: true });
    if (url.pathname === '/api/site-memory') return json({ memories: [], maxSites: 100, maxInstructions: 4000 });
    if (url.pathname === '/api/login') return json({ token: request.postDataJSON().username === 'bob' ? 'bob-session' : 'test-session' });
    if (url.pathname === '/api/prefs') return json({ prefs: { theme, model: 'haiku', web: false, ...request.postDataJSON() }, limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 } });
    if (url.pathname === '/api/commands' && account) {
      const list = account.commands, sorted = () => [...list].sort((a, b) => a.name.localeCompare(b.name));
      if (request.method() === 'PUT') {
        const { name, prompt, starter, from } = request.postDataJSON();
        if (from && from !== name && list.some(c => c.name === name)) return json({ error: `You already have /${name}.` }, 409);
        account.commands = list.filter(c => c.name !== name && c.name !== from);
        const saved = cmd(name, prompt.trim(), starter);
        account.commands.push(saved);
        return json({ command: saved, commands: [...account.commands].sort((a, b) => a.name.localeCompare(b.name)) });
      }
      if (request.method() === 'DELETE') {
        account.commands = list.filter(c => c.name !== url.searchParams.get('name'));
        return json({ ok: true, commands: [...account.commands] });
      }
      return json({ commands: sorted() });
    }
    if (url.pathname === '/api/chat') {
      const gate = state.chatGate;
      if (gate) { state.chatGate = null; gate.started?.resolve(); await gate.promise; }
      return route.fulfill({ contentType: 'application/x-ndjson', body: [{ t: 'd', v: 'A helpful answer.' }, finalEvent].map(e => JSON.stringify(e)).join('\n') + '\n' }).catch(() => {});
    }
    state.errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, body: 'Unexpected test request' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  await page.goto(standalone ? 'https://pagebot.example.test/chat' : 'https://news.example.test/article');
  const frame = standalone ? page.mainFrame() : page.frames().find(f => f.url().startsWith('https://pagebot.example.test/'));
  await frame.locator('#setBtn').waitFor({ state: 'visible' });
  await frame.locator('#boot').waitFor({ state: 'detached' });
  const q = frame.locator('#q'), menu = frame.locator('#slashMenu');
  const chats = () => state.requests.filter(r => r.path === '/api/chat');
  const options = () => frame.locator('#slashMenu [role=option]').evaluateAll(els => els.map(e => e.querySelector('b').textContent));
  const selected = () => frame.locator('#slashMenu [role=option][aria-selected=true] b').textContent();
  const answered = async n => { await frame.waitForFunction(n => document.querySelectorAll('.msg.bot .meta').length >= n, n); };
  const settle = () => frame.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const openSettings = async () => { await frame.locator('#setBtn').click(); await frame.locator('#cmdForm').waitFor({ state: 'visible' }); };
  return { page, frame, state, q, menu, chats, options, selected, answered, settle, openSettings };
}

browserTest('typing / lists your commands and the built-ins, and the keys drive the list', async t => {
  const f = await fixture(t, { commands: [TLDR, TRANSLATE] });
  await f.q.click();
  await f.page.keyboard.type('/');
  await f.menu.waitFor();
  const all = await f.options();
  assert.deepEqual(all.slice(0, 4), ['/tldr', '/translate', '/summarize', '/keypoints']);
  for (const name of ['/simple', '/new', '/web', '/page', '/screenshot', '/region', '/settings', '/help']) assert.ok(all.includes(name), name);
  assert.deepEqual(await f.frame.locator('#slashMenu .mh').allTextContents(), ['Your commands', 'Built in']);
  assert.equal(await f.frame.locator('#slashMenu [role=option]:has(b:text-is("/translate")) .ar').isVisible(), true, 'a command with {input} says it takes text');
  assert.equal(await f.frame.locator('#slashMenu [role=option]:has(b:text-is("/tldr")) .ar').isVisible(), false);

  await f.page.keyboard.type('t');
  assert.deepEqual(await f.options(), ['/tldr', '/translate']);
  assert.equal(await f.selected(), '/tldr');
  assert.equal(await f.q.getAttribute('aria-activedescendant'), await f.frame.locator('#slashMenu [aria-selected=true]').getAttribute('id'));
  await f.page.keyboard.press('ArrowDown');
  assert.equal(await f.selected(), '/translate');
  await f.page.keyboard.press('ArrowDown');
  assert.equal(await f.selected(), '/tldr', 'the highlight wraps around');
  await f.page.keyboard.press('ArrowUp');
  assert.equal(await f.selected(), '/translate');
  assert.equal(await f.q.inputValue(), '/t', 'arrows move the highlight, not the caret or the text');

  await f.page.keyboard.press('Tab');
  assert.equal(await f.q.inputValue(), '/translate ');
  assert.equal(await f.menu.isVisible(), false);
  assert.equal(await f.q.evaluate(e => e === document.activeElement), true, 'Tab fills in the name without leaving the box');

  await f.q.fill('');
  await f.page.keyboard.type('/tl');
  await f.menu.waitFor();
  await f.page.keyboard.press('Escape');
  assert.equal(await f.menu.isVisible(), false);
  assert.equal(await f.frame.locator('#q').isVisible(), true, 'Esc closes the list, not the panel');
  assert.ok(!(await f.page.evaluate(() => window.hostRequests.some(r => r.type === 'close'))));
  await f.q.click(); // the same word: the list stays closed
  assert.equal(await f.menu.isVisible(), false);
  await f.page.keyboard.type('d');
  await f.menu.waitFor();
  assert.equal(await f.selected(), '/tldr');

  // Shift+Enter is still a line break, and nothing is picked or sent
  await f.page.keyboard.press('Shift+Enter');
  assert.equal(await f.q.inputValue(), '/tld\n');
  assert.equal(await f.menu.isVisible(), false);

  // an input method keeps Enter while it composes
  await f.q.fill('');
  await f.page.keyboard.type('/tr');
  await f.menu.waitFor();
  await f.q.evaluate(e => {
    e.dispatchEvent(new CompositionEvent('compositionstart'));
    e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  });
  assert.equal(await f.q.inputValue(), '/tr');
  assert.equal(await f.menu.isVisible(), true);

  // a click picks a row (and the box keeps the focus); one waiting for {input} fills it in and says so
  await f.frame.locator('#slashMenu [role=option]:has(b:text-is("/translate"))').click();
  assert.equal(await f.q.inputValue(), '/translate ');
  assert.match(await f.frame.locator('#slashMenu .none.err').textContent(), /Type what goes in \{input\} after \/translate/);
  assert.equal(f.chats().length, 0);

  // pasting text that starts with "/" doesn't open the list
  await f.q.fill('');
  await f.q.evaluate(e => { e.focus(); e.setRangeText('/tl', 0, 0, 'end'); e.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', bubbles: true })); });
  assert.equal(await f.menu.isVisible(), false);
});

browserTest('a command sends its prompt, fills in {input}, and the bubble shows the prompt with a /name tag', async t => {
  const f = await fixture(t, { commands: [TLDR, TRANSLATE, cmd('evil', 'Say <img src=x onerror="window.pwned=1"> {input}')] });
  await f.q.fill('/translate Spanish');
  await f.q.press('Enter');
  await f.answered(1);
  assert.equal(f.chats()[0].body.message, 'Translate the highlighted text into Spanish.');
  assert.equal(await f.frame.locator('.msg.user .body').first().textContent(), 'Translate the highlighted text into Spanish.');
  assert.equal(await f.frame.locator('.msg.user .ctag').first().textContent(), '/translate');
  assert.match(await f.frame.locator('.msg.user .tags').first().textContent(), /^\/translate · 📄 page/);

  // with nothing after it, a command that has {input} waits and says what's missing
  await f.q.fill('/translate   ');
  await f.q.press('Enter');
  assert.match(await f.frame.locator('#slashMenu .none.err').textContent(), /Type what goes in \{input\}/);
  assert.equal(await f.q.inputValue(), '/translate ');
  assert.equal(f.chats().length, 1);

  // "$&" in what you type stays as typed; without {input} the text goes at the end
  await f.q.fill('/translate $& costs');
  await f.q.press('Enter');
  await f.answered(2);
  assert.equal(f.chats()[1].body.message, 'Translate the highlighted text into $& costs.');
  await f.q.fill('/TLDR in French');
  await f.q.press('Enter');
  await f.answered(3);
  assert.equal(f.chats()[2].body.message, 'Give me a TL;DR in three bullets.\n\nin French');
  assert.equal(f.chats()[2].body.page, null, 'your own commands follow the Page setting');

  // prompts and typed text are text, never markup
  await f.q.fill('/evil <b>x</b>');
  await f.q.press('Enter');
  await f.answered(4);
  assert.equal(await f.frame.locator('.msg.user .body').nth(3).textContent(), 'Say <img src=x onerror="window.pwned=1"> <b>x</b>');
  assert.equal(await f.frame.locator('.msg.user .body img, .msg.user .body b').count(), 0);
  assert.equal(await f.frame.evaluate(() => window.pwned), undefined);
  await f.q.fill('/ev');
  await f.frame.locator('#slashMenu').waitFor();
  assert.match(await f.frame.locator('#slashMenu [role=option] .md').first().textContent(), /<img src=x/);
});

browserTest('names nobody saved, paths and // go as typed, and /help with words after it is a question', async t => {
  const f = await fixture(t, { commands: [TLDR] });
  for (const [typed, sent] of [['/usr/bin/env node', '/usr/bin/env node'], ['/nope hi', '/nope hi'], ['//new', '/new'], ['/help me read this', '/help me read this']]) {
    const n = f.chats().length + 1; // counted before Enter: the request can be recorded before the next line runs
    await f.q.fill(typed);
    await f.q.press('Enter');
    await f.answered(n);
    assert.equal(f.chats().at(-1).body.message, sent, typed);
    assert.equal(await f.frame.locator('.msg.user').last().locator('.ctag').count(), 0);
  }
  // /help alone shows the whole list
  await f.q.fill('/help');
  await f.q.press('Enter');
  await f.menu.waitFor();
  assert.equal(await f.q.inputValue(), '/');
  assert.ok((await f.options()).length >= 11);
});

browserTest('/new starts a new chat, even mid-answer, and keeps the rest of the line', async t => {
  const f = await fixture(t);
  await f.q.fill('First question');
  await f.q.press('Enter');
  await f.answered(1);
  const gate = { ...deferred(), started: deferred() };
  f.state.chatGate = gate;
  await f.q.fill('Second question');
  await f.q.press('Enter');
  await gate.started.promise;
  await f.q.fill('/new follow up');
  await f.q.press('Enter');
  gate.resolve();
  await f.frame.locator('#log .empty').waitFor();
  await f.settle();
  assert.equal(await f.frame.locator('#log .msg').count(), 0, 'the stopped answer must not land in the new chat');
  assert.equal(await f.q.inputValue(), 'follow up');
  await f.q.press('Enter');
  await f.frame.locator('.msg.bot .meta').waitFor();
  assert.equal(f.chats().at(-1).body.conversationId, null);
  assert.equal(f.chats().at(-1).body.message, 'follow up');
});

browserTest('/web and /page work for one message, switch on their own, and built-ins send the page on a new chat', async t => {
  const f = await fixture(t);
  await f.frame.locator('#pagePill').click(); // Page text off
  await f.q.fill('/summarize');
  await f.q.press('Enter');
  await f.answered(1);
  assert.equal(f.chats()[0].body.message, 'Summarize this page.');
  assert.equal(f.chats()[0].body.page?.text, 'From the page', 'a built-in on a new chat sends the page, like the starters');
  assert.equal(await f.frame.locator('.msg.user .ctag').textContent(), '/summarize');

  await f.q.fill("/web what's new?");
  await f.q.press('Enter');
  await f.answered(2);
  assert.equal(f.chats()[1].body.message, "what's new?");
  assert.equal(f.chats()[1].body.web, true);
  assert.equal(f.chats()[1].body.page, null);
  assert.match(await f.frame.locator('.msg.user .tags').last().textContent(), /🌐 web/);
  assert.equal(f.state.requests.filter(r => r.path === '/api/prefs').length, 0, 'one message only: the setting is untouched');
  assert.equal(await f.frame.locator('#webPill').isVisible(), false);

  await f.q.fill('/page /keypoints');
  await f.q.press('Enter');
  await f.answered(3);
  assert.equal(f.chats()[2].body.message, 'What are the key points of this page?');
  assert.equal(f.chats()[2].body.page?.text, 'From the page');
  await f.q.fill('/summarize');
  await f.q.press('Enter');
  await f.answered(4);
  assert.equal(f.chats()[3].body.page, null, 'later in the chat the page is already in the history');

  await f.q.fill('/web');
  await f.q.press('Enter');
  await f.frame.locator('#webPill').waitFor();
  assert.deepEqual(f.state.requests.filter(r => r.path === '/api/prefs').map(r => r.body), [{ web: true }]);
  await f.q.fill('/page');
  await f.q.press('Enter');
  await f.frame.locator('#pagePill').waitFor();
  assert.equal(f.chats().length, 4);

  // /settings opens settings and moves focus off the hidden message box
  await f.q.fill('/settings');
  await f.q.press('Enter');
  await f.frame.locator('#sheet').waitFor();
  assert.equal(await f.frame.evaluate(() => document.activeElement.id), 'setBtn');
});

browserTest('an account without web search sees why, and nothing is sent', async t => {
  const f = await fixture(t, { allowWeb: false });
  await f.q.click();
  await f.page.keyboard.type('/we');
  await f.menu.waitFor();
  const row = f.frame.locator('#slashMenu [role=option]:has(b:text-is("/web"))');
  assert.equal(await row.getAttribute('aria-disabled'), 'true');
  assert.match(await row.locator('.md').textContent(), /isn’t turned on for your account/);
  await f.q.fill('/web is it raining?');
  await f.q.press('Enter');
  assert.match(await f.frame.locator('#slashMenu .none.err').textContent(), /Web search isn’t turned on/);
  assert.equal(f.chats().length, 0);
});

browserTest('/chat explains that /page needs the bookmark, and built-ins ask for something to work on', async t => {
  const f = await fixture(t, { standalone: true, commands: [cmd('mine', 'My own starter.', true)] });
  assert.equal(await f.frame.locator('#log .empty .starters .mine').textContent(), '/mine', 'your starters show in /chat too');
  await f.q.click();
  await f.page.keyboard.type('/page');
  await f.menu.waitFor();
  const row = f.frame.locator('#slashMenu [role=option]:has(b:text-is("/page"))');
  assert.equal(await row.getAttribute('aria-disabled'), 'true');
  assert.match(await row.locator('.md').textContent(), /Needs the bookmark/);
  await f.page.keyboard.press('Enter'); // the only match can't run, so Enter reads the box and explains
  assert.match(await f.frame.locator('#slashMenu .none.err').textContent(), /Needs the bookmark/);
  await f.q.fill('/summarize');
  await f.q.press('Enter');
  assert.match(await f.frame.locator('#slashMenu .none.err').textContent(), /Add a screenshot, or type or paste some text after \/summarize/);
  assert.equal(f.chats().length, 0);
  await f.q.fill('/summarize Some pasted text');
  await f.q.press('Enter');
  await f.answered(1);
  assert.equal(f.chats()[0].body.message, 'Summarize this.\n\nSome pasted text');
});

browserTest('Settings adds, edits, renames and deletes commands, and starters follow', async t => {
  const f = await fixture(t);
  await f.openSettings();
  assert.equal(await f.frame.locator('#cmdSave').isDisabled(), true);
  await f.frame.locator('#cmdName').fill('new');
  assert.match(await f.frame.locator('#cmdStatus').textContent(), /\/new is a built-in command/);
  assert.equal(await f.frame.locator('#cmdSave').isDisabled(), true);
  await f.frame.locator('#cmdName').fill('history'); // held for chat history, from the server's list
  assert.match(await f.frame.locator('#cmdStatus').textContent(), /\/history is a built-in command/);
  await f.frame.locator('#cmdName').fill('9lives');
  assert.match(await f.frame.locator('#cmdStatus').textContent(), /Start the name with a letter/);

  await f.frame.locator('#cmdName').fill('/TLDR');
  await f.frame.locator('#cmdPrompt').fill('Give me a TL;DR.');
  await f.frame.locator('#cmdStarter').check();
  await f.frame.locator('#cmdSave').click();
  await f.frame.waitForFunction(() => /Saved/.test(document.querySelector('#cmdStatus').textContent));
  assert.deepEqual(f.state.accounts['test-session'].commands.map(c => [c.name, c.prompt, c.starter]), [['tldr', 'Give me a TL;DR.', true]]);
  assert.equal(await f.frame.locator('#cmdList').inputValue(), 'tldr');

  // edit it: a rename sends where it came from
  await f.frame.locator('#cmdName').fill('short');
  assert.match(await f.frame.locator('#cmdStatus').textContent(), /Saving renames \/tldr to \/short/);
  await f.frame.locator('#cmdPrompt').fill('Short version, please.');
  await f.frame.locator('#cmdSave').click();
  await f.frame.waitForFunction(() => /Saved/.test(document.querySelector('#cmdStatus').textContent));
  const put = f.state.requests.filter(r => r.path === '/api/commands' && r.method === 'PUT').at(-1);
  assert.deepEqual(put.body, { name: 'short', prompt: 'Short version, please.', starter: true, from: 'tldr' });
  assert.deepEqual(await f.frame.locator('#cmdList option').allTextContents(), ['New command…', '/short · on new chats']);

  // it's in the list and on new chats; the chip sends it
  await f.frame.locator('#setBtn').click();
  assert.equal(await f.frame.locator('#log .starters .mine').textContent(), '/short');
  await f.q.click();
  await f.page.keyboard.type('/sh');
  assert.equal(await f.selected(), '/short');
  await f.q.fill('');
  await f.frame.locator('#log .starters .mine').click();
  await f.answered(1);
  assert.equal(f.chats()[0].body.message, 'Short version, please.');

  // delete it
  await f.openSettings();
  await f.frame.locator('#cmdList').selectOption('short');
  await f.frame.locator('#cmdDelete').click();
  await f.frame.waitForFunction(() => /Deleted \/short/.test(document.querySelector('#cmdStatus').textContent));
  assert.deepEqual(f.state.accounts['test-session'].commands, []);
  assert.deepEqual(await f.frame.locator('#cmdList option').allTextContents(), ['New command… (none saved yet)']);
  await f.frame.locator('#setBtn').click();
  await f.frame.locator('#newBtn').click();
  assert.equal(await f.frame.locator('#log .starters .mine').count(), 0);
});

browserTest('the list fits a narrow panel and has a backing in glass and clear', async t => {
  for (const theme of ['glass', 'clear', 'paper']) {
    const f = await fixture(t, { width: 300, height: 600, theme, commands: [TLDR, cmd('a-very-long-command-name', 'x '.repeat(400))] });
    await f.q.click();
    await f.page.keyboard.type('/');
    await f.menu.waitFor();
    const box = await f.menu.evaluate(e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, height: r.height, bg: getComputedStyle(e).backgroundColor }; });
    assert.ok(box.left >= 0 && box.right <= 300, `${theme}: inside the panel (${box.left}-${box.right})`);
    assert.ok(box.top >= 0, `${theme}: not cut off at the top`);
    assert.ok(await f.frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}: no sideways scroll`);
    assert.notEqual(box.bg, 'rgba(0, 0, 0, 0)', `${theme}: the list isn't see-through`);
    assert.ok(await f.frame.locator('#slashList').evaluate(e => e.scrollHeight > e.clientHeight), 'the rows scroll inside the list');
    await f.page.keyboard.press('ArrowUp'); // wraps to the last row, which scrolls into view
    assert.ok(await f.frame.locator('#slashMenu [aria-selected=true]').evaluate(e => {
      const l = document.querySelector('#slashList').getBoundingClientRect(), r = e.getBoundingClientRect();
      return r.top >= l.top - 1 && r.bottom <= l.bottom + 1;
    }), 'the highlighted row is visible');
  }
});

browserTest('signing in as someone else swaps in their commands', async t => {
  const f = await fixture(t, { commands: [TLDR] });
  await f.q.click();
  await f.page.keyboard.type('/');
  assert.ok((await f.options()).includes('/tldr'));
  await f.q.fill('');
  await f.openSettings();
  await f.frame.locator('#cmdName').fill('draft');
  await f.frame.locator('#outBtn').click();
  await f.frame.locator('#uName').fill('bob');
  await f.frame.locator('#uPass').fill('bob-password');
  await f.frame.locator('#uGo').click();
  await f.q.waitFor();
  await f.q.click();
  await f.page.keyboard.type('/');
  await f.menu.waitFor();
  const names = await f.options();
  assert.ok(names.includes('/bobs') && !names.includes('/tldr'), names.join(' '));
  await f.q.fill('');
  await f.openSettings();
  assert.deepEqual(await f.frame.locator('#cmdList option').allTextContents(), ['New command…', '/bobs']);
  assert.equal(await f.frame.locator('#cmdName').inputValue(), '', 'the last account’s draft is gone');
});

browserTest('text typed while the page is still coming in is sent with the message', async t => {
  const f = await fixture(t, { commands: [TLDR] });
  await f.page.evaluate(() => { window.pageDelay = 500; });
  await f.q.fill('hello');
  await f.q.press('Enter');
  await f.page.keyboard.type(' world');
  await f.answered(1);
  assert.equal(f.chats()[0].body.message, 'hello world');
});

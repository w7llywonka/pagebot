import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { pt, sleep, startExtension, until, why } from './helpers/ext-harness.mjs';

// The real extension (tests/helpers/ext-harness.mjs) against the ways a step could reach further than the person allowed,
// found in review: a pressed mouse button let go after Stop, a click or key that opens another site in a new tab without
// asking, typing into a field pagebot can't see, a script that never finishes keeping the debugger on, typing after the
// keyboard moved, a same-site address that bounces to another site, secrets in console lines, pagebot's own panel framed
// in a page, a reload that approved a new site, Chrome's debugging bar moving points, and a new tab pulling the person away.
let H;
const pages = {
  '/hold': ({ OTHER }) => `<!doctype html><html><head><title>Hold</title><style>body{margin:0;font:16px sans-serif}button,a,input{display:block;margin:10px;width:260px;height:34px}</style></head><body>
<button id="del">Delete everything</button>
<a id="far" href="${OTHER}/page?leak=afterstop">Elsewhere</a>
<a id="blank" target="_blank" href="${OTHER}/page?leak=newtab">Opens another site</a>
<a id="near" href="/b">Page B</a>
<a id="bounce" href="/redirect?to=${encodeURIComponent(`${OTHER}/page?secret=ref-click`)}">Bounce</a>
<a id="keylink" href="${OTHER}/page?leak=ctrlenter">Keyboard link</a>
<input id="search" aria-label="Search"><input id="comment" aria-label="Public comment">
<script>
window.deleted = 0; window.log = [];
document.getElementById('del').onclick = () => { deleted++; };
for (const t of ['mousedown', 'mouseup', 'click']) addEventListener(t, e => log.push(t + ':' + (e.target.id || e.target.tagName) + ':' + e.isTrusted), true);
console.log('sid=Zx81Qp0LmN4vB7cR2tY9 next');
console.log('Bearer sk_live_51HxQ2pLz8Y api key is AKIA4XAMPLEK3YQ7MNOP');
console.error('token=abc123 Authorization: Bearer xyz');
console.log('session_id: 7f3k9q2m1x');
</script></body></html>`,
  '/b': () => `<!doctype html><title>Page B</title><p>Page B</p>`,
  '/page': () => `<!doctype html><title>Other page</title><p>Another site.</p>`,
  '/shadow': ({ OTHER }) => `<!doctype html><html><head><title>Shadow</title><style>body{margin:0}object{display:block;margin:10px}</style></head><body>
<x-login id="xl"></x-login>
<object id="ob" type="text/html" data="${OTHER}/login" width="420" height="80"></object>
<script>
customElements.define('x-login', class extends HTMLElement {
  constructor() { super(); const r = this.attachShadow({ mode: 'closed' }); r.innerHTML = '<input id="pw" type="password" aria-label="Password"><input id="t" aria-label="Your name">'; this.pw = () => r.getElementById('pw'); this.t = () => r.getElementById('t'); }
});
</script></body></html>`,
  '/login': () => `<!doctype html><title>Sign in</title><body style="margin:0"><input id="pw" type="password" aria-label="Password" style="margin:10px;width:300px;height:30px"></body>`,
  '/self': ({ ORIGIN }) => `<!doctype html><title>Self</title><body style="margin:0"><iframe id="pb" src="${ORIGIN}/own" width="420" height="160" style="border:0;display:block"></iframe><p>Below the frame.</p></body>`,
  '/bottom': () => `<!doctype html><html><head><title>Bottom</title><style>body{margin:0;font:16px sans-serif;height:3000px}#top{margin:10px;width:200px;height:34px}#cookies{position:fixed;left:0;right:0;bottom:0;height:48px;background:#eee}#accept{margin:7px;width:200px;height:34px}</style></head><body>
<button id="top">Top</button><div id="cookies"><button id="accept">Accept cookies</button></div>
<script>window.accepted = 0; document.getElementById('accept').onclick = () => { accepted++; }; window.hits = []; addEventListener('click', e => hits.push((e.target.id || e.target.tagName) + '@' + e.clientY + '/' + innerHeight), true);</script></body></html>`,
};
const own = {
  '/own': () => `<!doctype html><title>pagebot</title><body style="margin:0"><input id="q" aria-label="Message" style="margin:10px;width:300px;height:30px"><button id="off" style="margin:10px;width:200px;height:34px" onclick="window.turnedOff = 1">Turn off asking</button></body>`,
};

before(async () => { if (!why) H = await startExtension({ pages, own }); });
after(async () => { await H?.close(); });

const hit = s => H.state.hits.some(h => h.includes(s));
const stop = async frame => { await sleep(500); await frame.evaluate(() => document.getElementById('sendBtn').click()); H.state.chat?.end(); H.state.chat = null; };
const noCard = async frame => assert.equal(await frame.locator('.acard').count(), 0, 'no card');

test('what a step can reach, with the real extension', { skip: why || false }, async t => {
  let page, panel, frame, tabId;
  const reopen = async () => {
    await panel?.close().catch(() => {});
    H.state.chat?.end(); H.state.chat = null;
    ({ panel, frame } = await H.openPanel(page));
    await frame.locator('#q').waitFor({ state: 'visible' });
  };
  const ask = async auto => { H.state.boot.prefs = { actionsAuto: auto }; await reopen(); }; // a fresh panel with clicking set to ask (or not)
  // each check stands on its own: one that fails leaves a fresh panel (and no answer in progress) for the next
  const part = (name, fn) => t.test(name, async () => {
    if (H.state.boot.prefs?.actionsAuto === false) { H.state.boot.prefs = {}; await reopen(); }
    await H.sw.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
    if (page.url() !== `${H.NEWS}/hold`) await page.goto(`${H.NEWS}/hold`);
    try { await fn(); } catch (e) { await reopen().catch(() => {}); throw e; }
  });

  await t.test('set up: a page, the panel beside it, signed in', async () => {
    page = await H.ctx.newPage();
    await page.goto(`${H.NEWS}/hold`);
    for (const p of H.ctx.pages()) if (p !== page && p.url() === 'about:blank') await p.close();
    ({ panel, frame } = await H.openPanel(page));
    await H.signIn(frame);
    tabId = await H.tabIdOf(page);
  });

  await part('a pressed mouse button is never let go of after Stop, the end of the answer or closing the panel', async () => {
    // Stop: the press stays a press (no mouseup, no click), and the person's own click afterwards works as usual
    await H.question(frame, 'Press the delete button');
    const down = await H.run('left_mouse_down', { target: pt(await H.centre(page, '#del')) });
    assert.equal(down.result.error, undefined, JSON.stringify(down.result));
    await stop(frame);
    await sleep(800);
    assert.equal(await page.evaluate(() => deleted), 0, 'Stop didn’t finish the click');
    assert.deepEqual(await page.evaluate(() => log.filter(l => !l.startsWith('mousedown'))), [], 'no mouseup or click');
    assert.equal(await H.attachedTo(tabId), false);
    H.finish();
    // the end of the answer, on a link to another site: the tab stays, and the other site hears nothing
    await H.question(frame, 'Press the link');
    await H.run('left_mouse_down', { target: pt(await H.centre(page, '#far')) });
    H.finish();
    await sleep(1000);
    assert.equal(hit('leak=afterstop'), false, 'the other site was never asked for anything');
    assert.equal(page.url(), `${H.NEWS}/hold`);
    // closing the panel in the middle: the same
    await H.question(frame, 'Press it again');
    await H.run('left_mouse_down', { target: pt(await H.centre(page, '#del')) });
    await panel.close(); panel = null;
    H.state.chat?.end(); H.state.chat = null;
    await sleep(1000);
    assert.equal(await page.evaluate(() => deleted), 0, 'closing the panel didn’t finish the click');
    await until('the debugger to be let go', async () => !(await H.attachedTo(tabId)));
    await page.click('#del');
    assert.equal(await page.evaluate(() => deleted), 1, 'the person’s own click still works');
    ({ panel, frame } = await H.openPanel(page));
    await frame.locator('#q').waitFor({ state: 'visible' });
  });

  await part('letting go on a link that opens another site in a new tab always asks, and a skip opens nothing', async () => {
    await H.question(frame, 'Open the link');
    const tabs = (await H.run('list_tabs', {}, { ask: false })).result.tabs.length;
    await H.run('left_mouse_down', { target: pt(await H.centre(page, '#blank')) });
    const up = await H.step('left_mouse_up', { target: pt(await H.centre(page, '#blank')) });
    const card = await H.card(frame);
    assert.match(card.text, /opens other\.test.* in a new tab/);
    assert.deepEqual(card.buttons, ['Allow', 'Skip'], 'another site always asks, with no Allow all');
    await H.choose(frame, 'Skip');
    assert.equal((await up.result()).denied, true);
    H.finish();
    await sleep(800);
    assert.equal(hit('leak=newtab'), false);
    await H.question(frame, 'Count the tabs');
    assert.equal((await H.run('list_tabs', {}, { ask: false })).result.tabs.length, tabs, 'no tab opened');
    H.finish();
  });

  await part('ctrl+Enter on a link to another site asks first, and nothing reaches that site on a skip', async () => {
    await H.question(frame, 'Open it in a new tab with the keyboard');
    await page.focus('#keylink');
    const k = await H.step('key', { text: 'ctrl+Enter' });
    const card = await H.card(frame);
    assert.match(card.text, /opens other\.test.* in a new tab/);
    assert.deepEqual(card.buttons, ['Allow', 'Skip']);
    await H.choose(frame, 'Skip');
    assert.equal((await k.result()).denied, true);
    await sleep(500);
    assert.equal(hit('leak=ctrlenter'), false);
    H.finish();
  });

  await part('a same-site address or link that bounces to another site stops at the bounce', async () => {
    await H.question(frame, 'Follow the links');
    const nav = await H.run('navigate', { url: `${H.NEWS}/redirect?to=${encodeURIComponent(`${H.OTHER}/page?secret=the-users-data`)}` });
    await noCard(frame);
    assert.match(nav.result.error, /went to other\.test.*hasn’t approved, so pagebot stopped it/);
    assert.equal(hit('secret=the-users-data'), false, 'the other site never got the address');
    assert.equal(page.url(), `${H.NEWS}/hold`);
    const tree = await H.run('find', { query: 'Bounce' }, { ask: false });
    const ref = /(ref_\d+)/.exec(tree.result.text)?.[1];
    assert.ok(ref, tree.result.text);
    const click = await H.run('left_click', { target: { type: 'ref', ref } });
    assert.match(click.result.error, /went to other\.test.*hasn’t approved/);
    assert.equal(hit('secret=ref-click'), false);
    assert.equal(page.url(), `${H.NEWS}/hold`);
    H.finish();
  });

  await part('console lines lose session ids, bearer tokens and key ids', async () => {
    await H.question(frame, 'Read the console');
    const con = await H.run('read_console', {});
    assert.equal(con.result.error, undefined, JSON.stringify(con.result));
    assert.match(con.result.text, /next/);
    for (const secret of ['Zx81Qp0LmN4vB7cR2tY9', 'sk_live_51HxQ2pLz8Y', 'AKIA4XAMPLEK3YQ7MNOP', 'abc123', 'xyz', '7f3k9q2m1x']) assert.ok(!con.result.text.includes(secret), `${secret} in ${con.result.text}`);
    H.finish();
  });

  await part('a script’s promise is waited for, and a rejected one is an error', async () => {
    await H.question(frame, 'Run some scripts');
    const runJs = async text => { const s = await H.step('javascript_exec', { text }); await H.card(frame); await H.choose(frame, 'Allow'); return (await s.result(30000)).result; };
    assert.equal((await runJs('Promise.resolve(42)')).value, '42');
    assert.equal((await runJs('new Promise(r => setTimeout(() => r("later"), 200))')).value, 'later');
    assert.match((await runJs('Promise.reject(new Error("nope"))')).threw, /nope/);
    assert.equal((await runJs('({ a: 1, b: [2] })')).value, '{"a":1,"b":[2]}');
    H.finish();
  });

  await part('a script that never finishes is cut off, and the debugger let go (also on Stop)', async () => {
    await H.question(frame, 'Run a script that waits');
    const runJs = async text => { const s = await H.step('javascript_exec', { text }); await H.card(frame); await H.choose(frame, 'Allow'); return (await s.result(30000)).result; };
    const forever = await runJs('await new Promise(() => {})');
    assert.match(forever.error, /didn’t finish within 10 seconds/);
    await until('the debugger to be let go', async () => !(await H.attachedTo(tabId)), 3000);
    const busy = await runJs('while (true) {}');
    assert.match(busy.error, /didn’t finish within 10 seconds/);
    assert.equal(await page.evaluate(() => 'still here'), 'still here', 'the page works again');
    await until('the debugger to be let go after a busy script', async () => !(await H.attachedTo(tabId)), 3000);
    // Stop while one waits: let go at once
    const s = await H.step('javascript_exec', { text: 'await new Promise(() => {})' });
    await H.card(frame); await H.choose(frame, 'Allow');
    await sleep(1500);
    assert.equal(await H.attachedTo(tabId), true, 'the script is running');
    await stop(frame);
    await until('the debugger to be let go after Stop', async () => !(await H.attachedTo(tabId)), 3000);
    void s;
    // the person's own trip to another site isn't held afterwards
    await page.goto(`${H.OTHER}/page`);
    assert.equal(page.url(), `${H.OTHER}/page`);
    await page.goto(`${H.NEWS}/hold`);
  });

  await part('reloading a page that went to a new site asks about that site first', async () => {
    await H.question(frame, 'Reload it');
    assert.equal((await H.run('get_page_text', {}, { ask: false })).result.error, undefined);
    await page.goto(`${H.OTHER}/page`); // between steps the tab goes elsewhere (a redirect, or the person)
    await sleep(300);
    const r = await H.step('navigate', { url: 'reload' });
    const card = await H.card(frame);
    assert.match(card.text, /pagebot is on a new site now \(other\.test/);
    await H.choose(frame, 'Skip');
    assert.equal((await r.result()).denied, true);
    const after = await H.step('get_page_text', {}, { ask: false });
    await H.card(frame); // still not approved: reading there asks too
    await H.choose(frame, 'Skip');
    assert.equal((await after.result()).denied, true);
    H.finish();
    await page.goto(`${H.NEWS}/hold`);
  });

  await part('a new tab while the person is on another tab asks first', async () => {
    await H.question(frame, 'Open a tab');
    const win = await H.sw.evaluate(async id => (await chrome.tabs.get(id)).windowId, tabId);
    const mine = await H.sw.evaluate(async ({ w, u }) => (await chrome.tabs.create({ windowId: w, url: u, active: true })).id, { w: win, u: `${H.NEWS}/b` });
    await sleep(300);
    const nt = await H.step('new_tab', {}, { ask: false });
    const card = await H.card(frame);
    assert.match(card.text, /You’re on another tab now/);
    await H.choose(frame, 'Skip');
    assert.equal((await nt.result()).denied, true);
    const active = await H.sw.evaluate(async w => (await chrome.tabs.query({ windowId: w, active: true }))[0].id, win);
    assert.equal(active, mine, 'the person stays on their tab');
    await H.sw.evaluate(id => chrome.tabs.remove(id), mine);
    await H.sw.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
    H.finish();
  });

  await part('a ctrl-click on a same-site link says it opened a tab, not another site', async () => {
    await H.question(frame, 'Open page B in a new tab');
    const r = await H.run('left_click', { target: pt(await H.centre(page, '#near')), modifiers: 'ctrl' });
    assert.equal(r.result.error, undefined, JSON.stringify(r.result));
    assert.equal(r.result.sameSite, true);
    assert.equal(r.result.tab, `${H.NEWS}/b`);
    for (const id of r.result.opened || []) await H.sw.evaluate(n => chrome.tabs.remove(n), Number(id.slice(4)));
    H.finish();
  });

  await part('typing goes only where the person approved it', async () => {
    await ask(false);
    await H.question(frame, 'Type a note');
    await page.focus('#search');
    const s = await H.step('type', { text: 'my private note' });
    const card = await H.card(frame);
    assert.match(card.text, /Type “my private note” into the “Search” box/);
    await page.focus('#comment'); // the keyboard moves while the card waits
    await H.choose(frame, 'Allow');
    const r = (await s.result()).result;
    assert.match(r.error, /changed after the user approved it/);
    assert.equal(await page.inputValue('#search'), '');
    assert.equal(await page.inputValue('#comment'), '');
    await page.focus('#search');
    const k = await H.step('key', { text: 'a b c' });
    await H.card(frame);
    await page.focus('#comment');
    await H.choose(frame, 'Allow');
    assert.match((await k.result()).result.error, /changed after the user approved it/);
    assert.equal(await page.inputValue('#comment'), '');
    H.finish();
    await ask(true);
  });

  await part('keys never reach a password field pagebot can’t see: in a closed shadow root, or a page inside an <object>', async () => {
    await page.goto(`${H.NEWS}/shadow`);
    await H.question(frame, 'Type here');
    await page.evaluate(() => document.getElementById('xl').pw().focus());
    const k = await H.run('key', { text: 'h u n t e r 2' });
    assert.match(k.result.error, /never reads or types into password fields/);
    assert.equal(await page.evaluate(() => document.getElementById('xl').pw().value), '');
    const hold = await H.run('hold_key', { text: 'a', duration: 1 });
    assert.match(hold.result.error, /password fields/);
    assert.equal(await page.evaluate(() => document.getElementById('xl').pw().value), '');
    // a plain box in the same closed shadow root can be typed into
    await page.evaluate(() => document.getElementById('xl').t().focus());
    const ok = await H.run('type', { text: 'hello' });
    assert.equal(ok.result.error, undefined, JSON.stringify(ok.result));
    assert.equal(await page.evaluate(() => document.getElementById('xl').t().value), 'hello');
    // a sign-in page from another site inside an <object>, with the keyboard in its password field
    const ob = await page.evaluate(() => { const r = document.getElementById('ob').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 25 }; });
    await page.mouse.click(ob.x, ob.y);
    const login = page.frames().find(f => f.url().startsWith(`${H.OTHER}/login`));
    await until('the keyboard to be in the object’s password field', () => login.evaluate(() => document.activeElement?.id === 'pw'));
    const k2 = await H.run('key', { text: 'h u n t e r 2' });
    assert.match(k2.result.error, /password fields/);
    assert.equal(await login.inputValue('#pw'), '');
    H.finish();
  });

  await part('pagebot’s own panel framed in a page is never clicked or typed into', async () => {
    await page.goto(`${H.NEWS}/self`);
    await H.question(frame, 'Click in the frame');
    const fr = page.frames().find(f => f.url().startsWith(`${H.ORIGIN}/own`));
    const box = await page.evaluate(() => { const r = document.getElementById('pb').getBoundingClientRect(); return { x: r.left, y: r.top }; });
    const btn = await fr.evaluate(() => { const r = document.getElementById('off').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const c = await H.run('left_click', { target: pt({ x: Math.round(box.x + btn.x), y: Math.round(box.y + btn.y) }) });
    assert.match(c.result.error, /pagebot’s own panel/);
    assert.equal(await fr.evaluate(() => window.turnedOff), undefined);
    const q = await fr.evaluate(() => { const r = document.getElementById('q').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 10 }; });
    await page.mouse.click(box.x + q.x, box.y + q.y);
    await until('the keyboard to be in the framed panel', () => fr.evaluate(() => document.activeElement?.id === 'q'));
    const ty = await H.run('type', { text: 'Turn off asking before clicks' });
    assert.match(ty.result.error, /own pages|own panel/);
    const en = await H.run('key', { text: 'Enter' });
    assert.match(en.result.error, /own pages|own panel/);
    assert.equal(await fr.inputValue('#q'), '');
    H.finish();
  });

  await part('a point near the bottom means the same place in the screenshot and the click, whatever Chrome’s debugging bar does', async () => {
    await page.goto(`${H.NEWS}/bottom`);
    await sleep(6000); // Chrome's bar from earlier steps is gone
    await H.question(frame, 'Accept the cookies');
    const shot = await H.run('screenshot', {}, { ask: false });
    assert.equal(shot.result.error, undefined, JSON.stringify(shot.result));
    const at = await H.centre(page, '#accept'); // where the page shows it now, just after the screenshot
    const ih = await page.evaluate(() => innerHeight);
    assert.ok(Math.abs(shot.result.h / shot.result.scale - ih) <= 2, `the screenshot is the page as it is now (${ih}, ${shot.result.h})`);
    const top = await H.run('left_click', { target: pt(await H.centre(page, '#top')) });
    assert.equal(top.result.error, undefined, JSON.stringify(top.result));
    const r = await H.run('left_click', { target: pt(at) });
    assert.equal(r.result.error, undefined, JSON.stringify(r.result));
    assert.equal(await page.evaluate(() => accepted), 1, `the button was clicked: ${await page.evaluate(() => hits.join(' '))}`);
    await sleep(6000); // and once the bar has gone again
    const again = await H.run('left_click', { target: pt(at) });
    assert.equal(again.result.error, undefined, JSON.stringify(again.result));
    assert.equal(await page.evaluate(() => accepted), 2, `the button was clicked again: ${await page.evaluate(() => hits.join(' '))}`);
    const below = await H.run('left_click', { target: pt({ x: 50, y: 5000 }) });
    assert.match(below.result.error, /isn’t on the part of the page that’s showing now/);
    H.finish();
  });
});

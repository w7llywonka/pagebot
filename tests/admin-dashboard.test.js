import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { makeAdminApi, NOW, TOKEN, TIMEZONE } from './fixtures/admin-fixtures.mjs';

// /admin, the owner's dashboard, with Playwright and a local Chromium. Every /api/admin response comes from the fixture
// (shaped like server.js's handlers); writes are recorded, and the ones these tests need change the fixture's people.
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
const browserTest = chromium ? test : test.skip;
const html = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
const ORIGIN = 'https://pagebot.example.test';
let browser;
before(async () => {
  if (chromium) browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); });

// phone: 390x844 with touch; waiting: how many people are left waiting to be let in (the fixture has 5)
// size: another viewport ({ width, height, touch }); dark: the dark colour scheme; clock: a clock the test can run forward;
// hold: a path whose answer waits until the test calls state.release()
async function dashboard(t, { hash = '#overview', phone = false, empty = false, waiting, failOnce, size, dark = false, clock = false, hold, openai = false } = {}) {
  const touch = phone || !!size?.touch;
  const context = await browser.newContext({
    viewport: size ? { width: size.width, height: size.height } : phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: touch, hasTouch: touch,
    reducedMotion: 'reduce', locale: 'en-US', timezoneId: TIMEZONE, colorScheme: dark ? 'dark' : 'light',
  });
  context.setDefaultTimeout(8000);
  if (clock) await context.clock.install({ time: new Date(NOW) });
  else await context.clock.setFixedTime(new Date(NOW));
  await context.addInitScript(tok => { try { sessionStorage.setItem('pb_admin', tok); } catch {} }, TOKEN);
  const api = makeAdminApi({ empty });
  if (waiting != null) for (const u of api.users.filter(x => x.status === 'pending').slice(waiting)) api.users.splice(api.users.indexOf(u), 1);
  let release; const held = new Promise(r => { release = r; });
  const state = { errors: [], writes: [], dialogs: [], fail: failOnce ? new Set([failOnce]) : new Set(), release };
  t.after(async () => { await context.close(); assert.deepEqual(state.errors, [], 'no page errors, native dialogs or unexpected requests'); });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    if (url.origin !== ORIGIN) { state.errors.push('request left the fixture: ' + url.href); return route.abort(); }
    if (url.pathname === '/admin') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (state.fail.has(url.pathname)) { state.fail.delete(url.pathname); return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }); }
    if (hold && url.pathname === hold) await held;
    let body = null; try { body = req.postDataJSON(); } catch {}
    if (method !== 'GET') {
      state.writes.push({ method, path: url.pathname, body });
      const m = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/), u = m && api.users.find(x => x.id === +m[1]);
      if (u && method === 'DELETE') api.users.splice(api.users.indexOf(u), 1); // a request turned down, or an account deleted
      else if (u && body?.status) u.status = body.status;
    }
    const r = api.handle(method, url.pathname, url.searchParams, body, req.headers());
    if (r && openai) {
      if (url.pathname === '/api/admin/stats') r.body.models = [...r.body.models, { id: 'gpt-6-luna', label: 'GPT-6 Luna', openai: true }];
      if (url.pathname === '/api/admin/usage') r.body.days = r.body.days.map(d => ({ ...d, openai: 320, openaiUsd: 0.0032 }));
      if (url.pathname === '/api/admin/overview') r.body.models.push({ model: 'gpt-6-luna', label: 'GPT-6 Luna', family: 'openai', questions: 1, input: 300, output: 20, usd: 0.0032, searches: 0 });
    }
    if (r) return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
    state.errors.push(`unexpected request: ${method} ${url.pathname}`);
    return route.fulfill({ status: 404, body: '{}' });
  });
  const page = await context.newPage();
  page.on('pageerror', e => state.errors.push('page error: ' + e.message));
  page.on('dialog', d => { state.errors.push(`native ${d.type()}: ${d.message()}`); d.dismiss().catch(() => {}); });
  await page.goto(ORIGIN + '/admin' + hash);
  if (hold) return { page, api, state };
  const tab = hash.slice(1);
  await page.locator(`#t-${tab}`).waitFor();
  await page.locator(`#t-${tab}.loading`).waitFor({ state: 'detached' });
  return { page, api, state };
}
const toast = page => page.locator('#toast .tcard');

browserTest('Luna has its own usage series and model filter in the admin dashboard', async t => {
  const { page } = await dashboard(t, { openai: true });
  assert.match(await page.locator('#legend').innerText(), /GPT-6 Luna/);
  const model = page.locator('#modelTbl tr', { hasText: 'GPT-6 Luna' });
  assert.equal(await model.count(), 1);
  await model.click();
  await page.locator('#t-activity').waitFor();
  assert.equal(await page.locator('#aModel').inputValue(), 'openai');
  assert.equal(await page.locator('#aModel option[value=openai]').textContent(), 'GPT-6 Luna');
  assert.equal(await page.locator('#aModel option[value=openai]').getAttribute('hidden'), null);
});

browserTest('Overview opens on what needs doing: the people waiting, appeals and anyone at their limit, before the numbers', async t => {
  const { page } = await dashboard(t);
  await page.locator('#kpis .kpi').first().waitFor();
  const order = await page.evaluate(() => [...document.querySelectorAll('#t-overview > *')].map(e => e.id || e.className).slice(0, 3));
  assert.equal(order[0], 'needs', 'the "Needs you" card comes first');
  const needs = page.locator('#needs');
  assert.match(await needs.textContent(), /5 people are waiting to be let in/);
  assert.equal(await needs.getByRole('button', { name: 'Let in nora.k' }).count(), 1);
  assert.equal(await needs.getByRole('button', { name: 'Turn down nora.k' }).count(), 1);
  assert.match(await needs.textContent(), /2 appeals are waiting for your answer/);
  assert.match(await needs.textContent(), /has used all of today’s limit/);
  assert.equal(await page.locator('#ovUnit button.on').textContent(), 'Dollars', 'dollars come first; tokens are the detail');
  assert.match(await page.locator('.tokhint').textContent(), /Tokens are how the models count text/);
});

browserTest('a new server: the password is the one thing left, its box is at the top, three plain steps follow, and the empty numbers stay folded away', async t => {
  const { page, state } = await dashboard(t, { empty: true });
  assert.doesNotMatch(await page.locator('#needs').textContent(), /Nothing needs you/, 'not while there is no password');
  assert.match(await page.locator('#needs').textContent(), /Just one thing: set your password in the box above\./);
  assert.match(await page.locator('#needs').textContent(), /Your numbers and charts show up here after the first question\./);
  for (const sel of ['#kpis', '#chart', '#modelTbl', '#heat', '#ovUnit']) assert.equal(await page.locator(sel).isVisible(), false, `${sel} is folded away before the first question`);
  assert.match(await page.locator('#needs .steps').textContent(), /Set your password.*Send people your address.*Let them in here/);
  assert.equal(await page.locator('#pwNote').isVisible(), true);
  await page.locator('#q1').fill('a-new-password'); await page.locator('#q2').fill('a-new-password');
  await page.locator('#pwQuick button[type=submit]').click();
  await toast(page).waitFor();
  assert.deepEqual(state.writes.at(-1), { method: 'POST', path: '/api/admin/password', body: { password: 'a-new-password' } }, 'the same request as Settings');
});

browserTest('letting in the last person waiting says so where you can see it, after the waiting card has gone', async t => {
  const { page, state } = await dashboard(t, { hash: '#people', waiting: 1 });
  await page.locator('#pendingCard').waitFor();
  await page.locator('#pendTbl').getByRole('button', { name: 'Let in nora.k' }).click();
  await page.locator('#pendingCard').waitFor({ state: 'hidden' });
  assert.equal(await toast(page).isVisible(), true);
  assert.match(await toast(page).textContent(), /nora\.k is in\./);
  assert.deepEqual(state.writes.map(w => [w.method, w.body]), [['POST', { status: 'trusted' }]]);
});

browserTest('turning someone down asks in the page first; Cancel sends nothing, and the answer is shown after', async t => {
  const { page, state } = await dashboard(t, { waiting: 1 });
  await page.locator('#needs').getByRole('button', { name: 'Turn down nora.k' }).click();
  const ask = page.locator('#ask');
  await ask.waitFor();
  assert.match(await ask.textContent(), /Turn down nora\.k\?.*they can ask again/);
  await page.locator('#askNo').click();
  await ask.waitFor({ state: 'hidden' });
  assert.equal(state.writes.length, 0, 'Cancel sends nothing');
  await page.locator('#needs').getByRole('button', { name: 'Turn down nora.k' }).click();
  await page.locator('#askYes').click();
  await toast(page).waitFor();
  assert.match(await toast(page).textContent(), /nora\.k was turned down\./);
  assert.deepEqual(state.writes.map(w => w.method), ['DELETE']);
  assert.doesNotMatch(await page.locator('#needs').textContent(), /waiting to be let in/);
});

browserTest('“Let everyone in” asks first when a request shares a browser with a terminated account', async t => {
  const { page, state } = await dashboard(t, { hash: '#people' });
  await page.locator('#acceptAll').click();
  await page.locator('#ask').waitFor();
  assert.match(await page.locator('#askBody').textContent(), /jk_backup used the same browser as a terminated account/);
  await page.locator('#askNo').click();
  assert.equal(state.writes.length, 0);
});

browserTest('someone banned shows the ban and its appeal right under their usage', async t => {
  const { page } = await dashboard(t, { hash: '#people' });
  await page.locator('#peopleTbl tbody tr', { hasText: 'dylan_m' }).locator('td').nth(1).click();
  await page.locator('#drawer.on').waitFor();
  assert.deepEqual((await page.locator('#dwBody > section > h4').allTextContents()).slice(0, 3), ['Usage', 'Bans and limits', 'Account']);
  assert.equal(await page.locator('#dwBody .banbox .areply').count(), 1, 'the appeal can be answered there');
});

browserTest('the person panel puts Account first, explains the five ways to stop someone, and keeps the ban form closed', async t => {
  const { page, state } = await dashboard(t, { hash: '#people' });
  await page.locator('#peopleTbl tbody tr', { hasText: 'dev.patel' }).locator('td').nth(1).click();
  await page.locator('#drawer.on').waitFor();
  const heads = await page.locator('#dwBody > section > h4').allTextContents();
  assert.deepEqual(heads.slice(0, 2), ['Usage', 'Account']);
  assert.equal(heads.at(-1), 'Bans and limits');
  assert.deepEqual(await page.locator('#dwBody .kinds dt').allTextContents(), ['Restrict', 'Turn off', 'Ban', 'Terminate', 'Delete']);
  assert.match(await page.locator('#dwBody .kinds').textContent(), /it can’t be undone/);
  assert.equal(await page.locator('#dwBody details.banfold').evaluate(d => d.open), false, 'the ban form is closed until you open it');
  // Delete says plainly that there is no undo, and Cancel sends nothing
  await page.getByRole('button', { name: 'Delete account…' }).click();
  assert.equal(await page.locator('#askWarn').textContent(), 'This can’t be undone.');
  await page.keyboard.press('Escape');
  await page.locator('#ask').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#drawer.on').count(), 1, 'Escape closes the question, not the panel behind it');
  assert.equal(state.writes.length, 0);
  // turning someone off can be undone from the result
  await page.getByRole('button', { name: 'Turn off account' }).click();
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await page.waitForFunction(() => /back on/.test(document.querySelector('#toast').textContent));
  assert.deepEqual(state.writes.map(w => w.body), [{ status: 'blocked' }, { status: 'trusted' }]);
});

browserTest('unsaved changes in Settings and “New people start with” survive the refresh', async t => {
  const { page } = await dashboard(t, { hash: '#settings' });
  await page.locator('#lMax').fill('8000');
  await page.locator('#lPage').click(); // somewhere else, so the field no longer has focus
  await page.locator('#refresh').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#lMax').inputValue(), '8000');
  await page.locator('.tab[data-tab="people"]').click();
  await page.locator('#dValue').waitFor();
  await page.locator('#dValue').fill('250000');
  await page.locator('#dSonnet').uncheck();
  await page.locator('#pSearch').click();
  await page.locator('#refresh').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#dValue').inputValue(), '250000');
  assert.equal(await page.locator('#dSonnet').isChecked(), false);
});

browserTest('a tab that fails to load says so, and Try again loads it', async t => {
  const { page } = await dashboard(t, { hash: '#devices', failOnce: '/api/admin/sessions' });
  const err = page.locator('#t-devices > .loaderr');
  await err.waitFor();
  assert.match(await err.textContent(), /Couldn’t load this just now/);
  await err.getByRole('button', { name: 'Try again' }).click();
  await err.waitFor({ state: 'detached' });
  await page.locator('#devTbl tbody tr').first().waitFor();
});

browserTest('on a laptop the people and devices tables fit their cards, Sign out included', async t => {
  const { page } = await dashboard(t, { hash: '#people' });
  await page.locator('#peopleTbl tbody tr').nth(3).waitFor();
  const fits = sel => page.locator(sel).evaluate(e => e.closest('.tablewrap').scrollWidth <= e.closest('.tablewrap').clientWidth + 1);
  assert.equal(await fits('#peopleTbl'), true, 'people table');
  await page.locator('.tab[data-tab="devices"]').click();
  await page.locator('#devTbl tbody tr').first().waitFor();
  assert.equal(await fits('#devTbl'), true, 'devices table');
});

browserTest('on a phone every tab is on screen, nothing scrolls sideways, and the bulk limit editor fits', async t => {
  const { page } = await dashboard(t, { hash: '#people', phone: true });
  await page.locator('#peopleTbl tbody tr').nth(3).waitFor();
  for (const b of await page.locator('.tab').all()) {
    const box = await b.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.height >= 44, `${await b.textContent()} is on screen and 44 px tall`);
  }
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('.tablewrap')].some(w => w.offsetParent && w.scrollWidth > w.clientWidth + 1));
  assert.equal(await sideways(), false, 'people');
  for (const n of ['sam.w', 'kofi', 'yusuf']) await page.locator('#peopleTbl tbody tr', { hasText: n }).locator('input[type=checkbox]').check();
  await page.locator('#bulk button[data-b="limit"]').click();
  const apply = await page.locator('#bApply').boundingBox();
  assert.ok(apply.x + apply.width <= 390, 'Apply is on screen');
  assert.equal(await sideways(), false, 'with the bulk editor open');
  for (const tab of ['overview', 'activity', 'devices', 'settings']) {
    await page.locator(`.tab[data-tab="${tab}"]`).click();
    await page.locator(`#t-${tab}`).waitFor();
    await page.locator(`#t-${tab}.loading`).waitFor({ state: 'detached' });
    await page.waitForTimeout(100);
    assert.equal(await sideways(), false, tab);
  }
});

// ---- found in review: keyboard, screen reader, every width, and what Undo puts back ----
const openPanel = async (page, name, table = '#peopleTbl') => {
  await page.locator(`${table} tbody tr`, { hasText: name }).locator('td').nth(table === '#devTbl' ? 0 : 1).click();
  await page.locator('#drawer.on').waitFor();
};
const focused = page => page.evaluate(() => document.activeElement?.textContent);
// colours as the browser computed them, and the WCAG ratio between two of them (in the page)
const COLOR_JS = `const rgb = s => (s.match(/rgba?\\(([^)]+)\\)/)?.[1] || '').split(/[ ,\\/]+/).filter(Boolean).map(Number);
  const lumOf = c => { const [r, g, b] = c.slice(0, 3).map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratioOf = (a, b) => { const [x, y] = [lumOf(a), lumOf(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const behind = el => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length && (c[3] ?? 1) > 0) return c; } return rgb(getComputedStyle(document.body).backgroundColor); };`;

browserTest('the Delete question tells a screen reader that it can’t be undone, not only the eye', async t => {
  const { page } = await dashboard(t, { hash: '#people' });
  await openPanel(page, 'dev.patel');
  await page.getByRole('button', { name: 'Delete account…' }).click();
  await page.locator('#ask').waitFor();
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#ask' });
  const [node] = (await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })).nodes;
  assert.equal(node.role.value, 'dialog');
  assert.equal(node.name.value, 'Delete dev.patel for good?');
  assert.match(node.description?.value || '', /signed out.*This can’t be undone\./s);
});

browserTest('Undo after Turn off works from the keyboard: focus goes to it, it waits while you are on it, and Escape puts you back', async t => {
  const { page, state } = await dashboard(t, { hash: '#people', clock: true });
  await openPanel(page, 'dev.patel');
  await page.getByRole('button', { name: 'Turn off account' }).focus();
  await page.keyboard.press('Enter');
  const undo = toast(page).getByRole('button', { name: 'Undo' });
  await undo.waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Undo');
  await page.clock.runFor(20_000);
  assert.equal(await undo.isVisible(), true, 'still there while it has the focus');
  await page.keyboard.press('Escape');
  await toast(page).waitFor({ state: 'detached' });
  assert.equal(await page.locator('#drawer.on').count(), 1, 'Escape closed the message, not the panel');
  assert.equal(await focused(page), 'Turn back on', 'focus is on the redrawn button, not lost');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.textContent === 'Turn off account');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.textContent === 'Undo');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /back on/.test(document.querySelector('#toast').textContent));
  await page.waitForFunction(() => document.activeElement?.textContent === 'Turn off account');
  assert.deepEqual(state.writes.map(w => w.body), [{ status: 'blocked' }, { status: 'trusted' }, { status: 'blocked' }, { status: 'trusted' }]);
  await page.clock.runFor(8_000);
  assert.equal(await toast(page).count(), 0, 'a message nobody is on still goes away by itself');
});

browserTest('Undo on someone still waiting puts them back on the waiting list instead of letting them in', async t => {
  const { page, state, api } = await dashboard(t, { hash: '#devices' });
  await openPanel(page, 'nora.k', '#devTbl');
  await page.getByRole('button', { name: 'Turn off account' }).click();
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await page.waitForFunction(() => /nora\.k is waiting to be let in again\./.test(document.querySelector('#toast').textContent));
  assert.deepEqual(state.writes.map(w => w.body), [{ status: 'blocked' }, { status: 'pending' }], 'not "trusted", which would let them in without your defaults');
  assert.equal(api.users.find(u => u.name === 'nora.k').status, 'pending');
  // the badge comes from the refresh that follows Undo, a moment after the toast: wait for it rather than read it once
  await page.waitForFunction(() => document.querySelector('#pendBadge')?.textContent === '7', null, { timeout: 5000 }).catch(() => {});
  assert.equal(await page.locator('#pendBadge').textContent(), '7', '5 waiting and 2 appeals, as before');
});

browserTest('placeholder text passes 4.5:1 on its field, light and dark', async t => {
  for (const dark of [false, true]) for (const [hash, empty] of [['#settings', true], ['#people', false], ['#activity', false]]) {
    const { page } = await dashboard(t, { hash, empty, dark });
    const fails = await page.evaluate(`(() => { ${COLOR_JS}
      const fields = [...document.querySelectorAll('input[placeholder],textarea[placeholder]')].filter(e => e.offsetParent);
      if (!fields.length) return ['no fields with a placeholder on ${hash}'];
      return fields.map(e => { const p = getComputedStyle(e, '::placeholder'), r = ratioOf(rgb(p.color), behind(e));
        return +p.opacity < 1 || r < 4.5 ? e.placeholder + ': ' + r.toFixed(2) + ':1, opacity ' + p.opacity : null; }).filter(Boolean); })()`);
    assert.deepEqual(fails, [], `${dark ? 'dark' : 'light'} ${hash}`);
  }
});

browserTest('segmented controls tell a screen reader which one is chosen, and what each group is for', async t => {
  const { page } = await dashboard(t);
  const pressed = sel => page.locator(sel + ' button').evaluateAll(bs => bs.map(b => [b.textContent, b.getAttribute('aria-pressed')]));
  assert.deepEqual(await pressed('#ovUnit'), [['Dollars', 'true'], ['Tokens', 'false']]);
  await page.locator('#ovUnit button', { hasText: 'Tokens' }).click();
  assert.deepEqual(await pressed('#ovUnit'), [['Dollars', 'false'], ['Tokens', 'true']]);
  await page.locator('.tab[data-tab="people"]').click();
  await page.locator('#dKind button.on').waitFor({ state: 'attached' });
  await openPanel(page, 'dev.patel');
  const segs = await page.locator('.seg').evaluateAll(ss => ss.map(s => ({ id: s.id || s.parentElement.className, role: s.getAttribute('role'), name: s.getAttribute('aria-label'),
    pressed: [...s.querySelectorAll('button')].map(b => b.getAttribute('aria-pressed')) })));
  for (const s of segs) {
    assert.equal(s.role, 'group', `${s.id} is a group`);
    assert.ok(s.name, `${s.id} has a name`);
    assert.ok(s.pressed.every(p => p === 'true' || p === 'false') && s.pressed.filter(p => p === 'true').length <= 1, `${s.id} marks the chosen one: ${s.pressed}`);
  }
  assert.ok(segs.some(s => s.id === 'bKind') && segs.some(s => s.id === 'dKind'));
});

browserTest('with no password yet, Settings offers to set one and doesn’t talk about signing devices out', async t => {
  const fresh = await dashboard(t, { hash: '#settings', empty: true });
  assert.equal(await fresh.page.locator('#pwSave').textContent(), 'Set password');
  assert.equal(await fresh.page.locator('#pwHint').isVisible(), false);
  const set = await dashboard(t, { hash: '#settings' });
  assert.equal(await set.page.locator('#pwSave').textContent(), 'Change password');
  assert.match(await set.page.locator('#pwHint').textContent(), /signs you out on every device/);
  assert.equal(await set.page.locator('#pwHint').isVisible(), true);
});

browserTest('chart axes in dollars are even steps that print exactly ($0.10, $0.20, not $0.13, $0.25)', async t => {
  const even = (labels, what) => {
    const v = labels.map(s => +s.replace(/[$,K M]/g, ''));
    assert.ok(v.length >= 4, `${what}: ${labels}`);
    assert.equal(v[0], 0, `${what} starts at 0`);
    const step = v[1] - v[0];
    assert.ok(v.every((x, i) => Math.abs(x - step * i) < 1e-9), `${what}: ${labels.join(' ')} are even steps`);
  };
  const { page } = await dashboard(t, { hash: '#people' });
  await openPanel(page, 'dev.patel');
  const person = page.locator('#dwBody svg text[x="38"]');
  await person.first().waitFor();
  even(await person.allTextContents(), 'dev.patel’s chart');
  await page.keyboard.press('Escape');
  await page.locator('.tab[data-tab="overview"]').click();
  await page.locator('#svg text[x="38"]').first().waitFor();
  even(await page.locator('#svg text[x="38"]').allTextContents(), 'the usage chart');
  const empty = await dashboard(t, { empty: true });
  even(await empty.page.locator('#svg text[x="38"]').allTextContents(), 'an empty chart');
});

browserTest('on a phone an opened question is one block, and its tags keep their own fill', async t => {
  for (const dark of [false, true]) {
    const { page } = await dashboard(t, { hash: '#activity', phone: true, dark });
    await page.locator('#actTbl tbody tr.click').first().click();
    await page.locator('#actTbl tr.open').waitFor();
    const r = await page.locator('#actTbl tr.open').evaluate(tr => ({
      row: getComputedStyle(tr).backgroundColor, detail: getComputedStyle(tr.nextElementSibling).backgroundColor,
      cells: [...tr.cells].filter(c => c.offsetParent).map(c => getComputedStyle(c).backgroundColor),
      tag: getComputedStyle(tr.querySelector('.tag')).backgroundColor,
    }));
    assert.notEqual(r.row, 'rgba(0, 0, 0, 0)', 'the row has the fill');
    assert.equal(r.detail, r.row, 'and the opened part under it the same one');
    assert.deepEqual([...new Set(r.cells)], ['rgba(0, 0, 0, 0)'], 'no cell paints its own tile');
    assert.notEqual(r.tag, r.row, 'a tag stands out from the row');
  }
});

browserTest('every tab is in view at every width: a phone on its side, a tablet, a small laptop', async t => {
  for (const size of [{ width: 844, height: 390, touch: true }, { width: 820, height: 1180, touch: true }, { width: 720, height: 900 }, { width: 1000, height: 800 }, { width: 1024, height: 768 }]) {
    const { page } = await dashboard(t, { hash: '#settings', size });
    const strip = await page.locator('.tabs').boundingBox(), right = Math.min(strip.x + strip.width, size.width);
    for (const b of await page.locator('.tab').all()) {
      const box = await b.boundingBox();
      assert.ok(box.x >= strip.x - 1 && box.x + box.width <= right + 1, `${size.width}x${size.height}: ${await b.textContent()} is in view`);
    }
    assert.equal(await page.locator('.tabs').evaluate(s => s.scrollWidth <= s.clientWidth + 1), true, `${size.width}: the tab strip has nothing hidden`);
  }
});

browserTest('on smaller laptops every table fits its card, and People can still be sorted by a column that isn’t shown', async t => {
  const clipped = page => page.evaluate(() => [...document.querySelectorAll('.tablewrap')].filter(w => w.offsetParent && w.scrollWidth > w.clientWidth + 1).map(w => w.querySelector('table').id));
  for (const width of [1024, 1180, 1280, 1366]) {
    const { page } = await dashboard(t, { hash: '#people', size: { width, height: 800 } });
    await page.locator('#peopleTbl tbody tr').nth(3).waitFor();
    assert.deepEqual(await clipped(page), [], `people at ${width}`);
    for (const [tab, row] of [['overview', '#modelTbl tbody tr'], ['activity', '#actTbl tbody tr'], ['devices', '#devTbl tbody tr']]) {
      await page.locator(`.tab[data-tab="${tab}"]`).click();
      await page.locator(row).first().waitFor();
      await page.locator(`#t-${tab}.loading`).waitFor({ state: 'detached' });
      assert.deepEqual(await clipped(page), [], `${tab} at ${width}`);
    }
  }
  const { page } = await dashboard(t, { hash: '#people', size: { width: 1024, height: 800 } });
  await page.locator('#peopleTbl tbody tr').nth(3).waitFor();
  assert.equal(await page.locator('#peopleTbl thead th', { hasText: 'Joined' }).isVisible(), false, 'Joined has no column here');
  await page.locator('#pSort').selectOption('joined');
  const first = () => page.locator('#peopleTbl tbody tr:not(.owner)').first().locator('td').nth(1).textContent();
  assert.equal(await first(), 'theo', 'newest first');
  await page.locator('#pSortDir').click();
  assert.match(await first(), /^old_roommate/, 'and the other way round');
});

browserTest('on a phone the overview tables keep every number, and People can be sorted by every column', async t => {
  const { page, api } = await dashboard(t, { phone: true });
  await page.locator('#modelTbl tbody tr').first().waitFor();
  const rows = sel => page.locator(sel + ' tbody tr').evaluateAll(trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ')));
  for (const r of await rows('#modelTbl')) assert.match(r, /tokens · .+ an answer/, r);
  for (const r of await rows('#topTbl')) assert.match(r, /tokens · .+ of the cost/, r);
  for (const r of await rows('#siteTbl')) assert.match(r, /\d+ (person|people) · .+ tokens/, r);
  await page.locator('.tab[data-tab="people"]').click();
  await page.locator('#peopleTbl tbody tr').nth(3).waitFor();
  assert.equal(await page.locator('#pSort option').count(), 11);
  await page.locator('#pSort').selectOption('ct');
  const top = api.users.filter(u => u.status !== 'pending').sort((a, b) => b.total.usd - a.total.usd)[0];
  assert.match(await page.locator('#peopleTbl tbody tr:not(.owner)').first().textContent(), new RegExp('^' + top.name.replace('.', '\\.')));
});

browserTest('every outlined control has an edge at 3:1 against what it sits on, light and dark', async t => {
  for (const dark of [false, true]) for (const hash of ['#overview', '#people', '#devices']) {
    const { page } = await dashboard(t, { hash, dark });
    const fails = await page.evaluate(`(() => { ${COLOR_JS}
      const els = [...document.querySelectorAll('.btn.ghost, .seg')].filter(e => e.offsetParent);
      if (els.length < 3) return ['too few controls found'];
      return els.map(e => { const cs = getComputedStyle(e), edge = rgb(cs.boxShadow), r = edge.length ? ratioOf(edge, behind(e.parentElement)) : 0;
        return r < 3 ? (e.id || e.textContent.trim().slice(0, 30)) + ': ' + r.toFixed(2) + ':1' : null; }).filter(Boolean); })()`);
    assert.deepEqual(fails, [], `${dark ? 'dark' : 'light'} ${hash}`);
  }
});

browserTest('with a saved token the header and tabs show at once, with a loading line, before the numbers arrive', async t => {
  const { page, state } = await dashboard(t, { hold: '/api/admin/users' });
  await page.locator('#app').waitFor();
  assert.equal(await page.locator('#booting').isVisible(), true);
  assert.equal(await page.locator('#unlock').isVisible(), false, 'no sign-in box');
  assert.equal(await page.locator('.tab[data-tab="overview"]').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#t-overview').isVisible(), false, 'no half-drawn tab');
  state.release();
  await page.locator('#kpis .kpi').first().waitFor();
  assert.equal(await page.locator('#booting').isVisible(), false);
});

// ---- contrast: the real tokens, light and dark, against the 4.5:1 and 3:1 bars ----
function tokens(block) { return Object.fromEntries([...block.matchAll(/--([\w-]+):(#[0-9a-f]{3,6})\b/gi)].map(m => [m[1], m[2]])); }
const lum = hex => {
  const h = hex.length === 4 ? hex.slice(1).split('').map(c => c + c).join('') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
test('every text colour on every surface it sits on, and every control edge, passes in light and dark', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const light = tokens(css.match(/:root\{([\s\S]*?)\}/)[1]);
  const dark = { ...light, ...tokens(css.match(/@media \(prefers-color-scheme:dark\)\{:root\{([\s\S]*?)\}\}/)[1]) };
  const surfaces = ['page', 'panel', 'panel2', 'hover'];
  const text = [
    ...['text', 'text2', 'muted', 'accent'].flatMap(f => surfaces.map(b => [f, b, 4.5])),
    ['ok', 'panel', 4.5], ['err', 'panel', 4.5], ['warn', 'panel', 4.5], ['err', 'panel2', 4.5],
    ['accent', 'wash', 4.5], ['text', 'wash', 4.5], ['text2', 'wash', 4.5], // the selected tab, owner chip
    ['ok', 'ok-tint', 4.5], ['warn', 'warn-tint', 4.5], ['err', 'err-tint', 4.5], // status chips and tags
    ['text', 'err-tint', 4.5], ['text2', 'err-tint', 4.5], ['text2', 'warn-tint', 4.5], ['text', 'warn-tint', 4.5], // ban boxes, the password note
    ['on-accent', 'accent', 4.5], ['on-bad', 'bad', 4.5], ['on-warnb', 'warnb', 4.5], ['on-worst', 'worst', 4.5], // filled buttons, chips, toasts
    ['worst', 'on-worst', 4.5], // the Undo button in the toast
  ];
  const edges = [['line2', 'page', 3], ['line2', 'panel', 3], ['line2', 'panel2', 3], ['focus', 'page', 3], ['focus', 'panel', 3], ['focus', 'panel2', 3], ['accent', 'panel', 3]];
  const fails = [];
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg, bar] of [...text, ...edges]) {
      assert.ok(t[fg] && t[bg], `${name}: --${fg} and --${bg} are defined`);
      const r = ratio(t[fg], t[bg]);
      if (r < bar) fails.push(`${name}: --${fg} ${t[fg]} on --${bg} ${t[bg]} is ${r.toFixed(2)}:1, under ${bar}:1`);
    }
  }
  assert.deepEqual(fails, []);
});

test('no native confirm() or alert() is left: every question is asked in the page', () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(script, /\b(confirm|alert)\(/);
});

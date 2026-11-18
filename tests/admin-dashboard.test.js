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
async function dashboard(t, { hash = '#overview', phone = false, empty = false, waiting, failOnce } = {}) {
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone,
    reducedMotion: 'reduce', locale: 'en-US', timezoneId: TIMEZONE,
  });
  context.setDefaultTimeout(8000);
  await context.clock.setFixedTime(new Date(NOW));
  await context.addInitScript(tok => { try { sessionStorage.setItem('pb_admin', tok); } catch {} }, TOKEN);
  const api = makeAdminApi({ empty });
  if (waiting != null) for (const u of api.users.filter(x => x.status === 'pending').slice(waiting)) api.users.splice(api.users.indexOf(u), 1);
  const state = { errors: [], writes: [], dialogs: [], fail: failOnce ? new Set([failOnce]) : new Set() };
  t.after(async () => { await context.close(); assert.deepEqual(state.errors, [], 'no page errors, native dialogs or unexpected requests'); });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    if (url.origin !== ORIGIN) { state.errors.push('request left the fixture: ' + url.href); return route.abort(); }
    if (url.pathname === '/admin') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (state.fail.has(url.pathname)) { state.fail.delete(url.pathname); return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }); }
    let body = null; try { body = req.postDataJSON(); } catch {}
    if (method !== 'GET') {
      state.writes.push({ method, path: url.pathname, body });
      const m = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/), u = m && api.users.find(x => x.id === +m[1]);
      if (u && method === 'DELETE') api.users.splice(api.users.indexOf(u), 1); // a request turned down, or an account deleted
      else if (u && body?.status) u.status = body.status;
    }
    const r = api.handle(method, url.pathname, url.searchParams, body, req.headers());
    if (r) return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
    state.errors.push(`unexpected request: ${method} ${url.pathname}`);
    return route.fulfill({ status: 404, body: '{}' });
  });
  const page = await context.newPage();
  page.on('pageerror', e => state.errors.push('page error: ' + e.message));
  page.on('dialog', d => { state.errors.push(`native ${d.type()}: ${d.message()}`); d.dismiss().catch(() => {}); });
  await page.goto(ORIGIN + '/admin' + hash);
  const tab = hash.slice(1);
  await page.locator(`#t-${tab}`).waitFor();
  await page.locator(`#t-${tab}.loading`).waitFor({ state: 'detached' });
  return { page, api, state };
}
const toast = page => page.locator('#toast .tcard');

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

browserTest('a new server: nothing needs you, the password box is at the top, and three plain steps follow', async t => {
  const { page, state } = await dashboard(t, { empty: true });
  assert.match(await page.locator('#needs').textContent(), /Nothing needs you right now\./);
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

#!/usr/bin/env node
// Measures how long the panel takes to become usable after the bookmark click, and /chat after navigation.
//
//   CHROMIUM_PATH=/path/to/chrome node scripts/measure-startup.mjs [options]
//
//   --runs N          cold loads per case (default 5); the table shows medians
//   --rtt MS          round trip added to every request (default 100)
//   --kbps N          download speed in kilobits per second (default 10000)
//   --cpu N           CPU slowdown (default 4)
//   --boot-ms MS      time the server spends on /api/boot (default 30)
//   --gzip            send the page gzipped, as a compressing server would
//   --case LIST       panel, panel-signed-out, chat (default: all three)
//   --widget FILE     the page to measure (default public/widget.html)
//   --against FILE    an older copy of the page: its runs alternate with the page's, and the table shows both
//   --trace           also record a Chrome trace per case and print where the main thread's time went
//   --json FILE       write every run's raw numbers
//
// No pagebot server or database is needed: a small local server plays the host page, the panel and its API, and adds
// the latency. Each run is a new browser context, so nothing is cached and storage is empty apart from the session
// token (cases "panel" and "chat"; "panel-signed-out" has none, like the first open on a new site).
// The page is served with the same Content-Security-Policy as server.js, so a script the policy would block fails here too.
//
// The panel's frame is another site than the page it sits on, so Chrome gives it a process of its own (as it does in real
// use). To slow that process down before the panel loads, a hidden frame from the same site goes into the host page first;
// so a run includes neither starting that process nor opening the connection. Times are milliseconds after the click (or
// after navigation, for /chat), each one the median of the runs.
//
//   htmlFirstByte, htmlDone   the page's bytes arriving
//   bootSent, bootBack        /api/boot reaching the server, and its answer reaching the page
//   ready, panelShown         the bookmark hears 'ready', and starts fading the panel in (it is invisible until then)
//   firstPaint                the panel's document first paints something
//   parsed                    the main script has run (DOMContentLoaded)
//   splashGone                the loading mark has yielded
//   usable                    the message box (or the sign-in form) is there to type in; focus: it has the keyboard
//   bootRequests              how many times /api/boot was asked for
//   longTasks, longTaskMs     main-thread tasks over 50 ms, and their total
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const flag = name => args.includes('--' + name);
const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback; };
const RUNS = Number(opt('runs', 5)), RTT = Number(opt('rtt', 100)), KBPS = Number(opt('kbps', 10000)), CPU = Number(opt('cpu', 4));
const BOOT_MS = Number(opt('boot-ms', 30)), GZIP = flag('gzip'), TRACE = flag('trace');
const CASES = opt('case', 'panel,panel-signed-out,chat').split(',');
const bookmarklet = await readFile(new URL('../bookmarklet.js', import.meta.url), 'utf8');
async function load(file) { // a page, with the policy server.js would send with it
  const html = await readFile(file, 'utf8'), body = Buffer.from(html);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
  const csp = frames => `default-src 'self'; script-src ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; ` +
    `object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${frames}`;
  return { file, body, gz: zlib.gzipSync(body, { level: 9 }), csp };
}
const PAGES = { now: await load(opt('widget', new URL('../public/widget.html', import.meta.url).pathname)), ...(opt('against') && { was: await load(opt('against')) }) };
let serving = PAGES.now;

// ---- the local server: the host page on 127.0.0.1, pagebot on localhost (another site, as it is in real use) ----
const now = () => performance.timeOrigin + performance.now();
const signedIn = {
  version: 13, theme: 'ember', lock: 'password', passwordSet: true, accounts: { on: true, signup: false }, authed: true, who: 'user', lockMinutes: 0, lockChoices: [1, 5, 15, 60],
  user: { id: 1, name: 'Reader', status: 'trusted', allowWeb: true, passcode: false }, prefs: { theme: 'ember', model: 'haiku', web: false },
  limits: { maxTokens: 2048, pageTokens: 5000, maxSearches: 3 }, models: [{ key: 'haiku', label: 'Haiku 5.5' }, { key: 'sonnet', label: 'Sonnet 5.5' }],
  quota: { pct: 12 }, announcement: null, restriction: null, commands: [], commandLimits: { maxCommands: 50, maxPrompt: 2000, maxStarters: 3, reserved: [] },
};
const signedOut = { version: 13, theme: 'ember', lock: 'password', passwordSet: true, accounts: { on: true, signup: false }, authed: false };
let requests = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function paced(res, body) { // the round trip, then the body at the chosen speed
  await sleep(RTT);
  const step = Math.max(1, Math.round(KBPS * 1000 / 8 / 100)); // bytes per 10 ms
  for (let i = 0; i < body.length; i += step) { res.write(body.subarray(i, i + step)); if (i + step < body.length) await sleep(10); }
  res.end();
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), entry = { path: url.pathname, start: now() };
  requests.push(entry);
  const json = async (value, think = 0) => { await sleep(think); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); await paced(res, Buffer.from(JSON.stringify(value))); };
  if (url.pathname === '/host') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><html><body style="margin:0;background:#fff"><h1>Host page</h1><p>Some text to read.</p></body></html>'); }
  if (url.pathname === '/blank') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html>'); }
  if (url.pathname === '/widget' || url.pathname === '/chat') {
    const gz = GZIP && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': serving.csp(url.pathname === '/widget' ? '*' : "'none'"), ...(gz && { 'Content-Encoding': 'gzip' }) });
    return paced(res, gz ? serving.gz : serving.body);
  }
  if (url.pathname === '/api/boot') return json(req.headers.authorization ? signedIn : signedOut, BOOT_MS);
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  entry.unexpected = true; res.writeHead(404); res.end(); // a start-up asks for nothing else
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port, HOST = `http://127.0.0.1:${PORT}`, ORIGIN = `http://localhost:${PORT}`;

// ---- what the page records about itself (runs in the panel's document before any of its own scripts) ----
// Only attributes are read, never layout: asking for a box while the page is still arriving would itself slow the page down.
const probe = `(() => {
  if (!/^\\/(widget|chat)$/.test(location.pathname)) return;
  const at = () => performance.timeOrigin + performance.now(), M = window.__m = { marks: {}, long: [], boots: [] };
  const mark = k => { if (!(k in M.marks)) M.marks[k] = at(); };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) M.long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name.endsWith('/api/boot')) M.boots.push(performance.timeOrigin + e.responseEnd); }).observe({ type: 'resource', buffered: true }); } catch {}
  const look = () => {
    if (!document.body) return;
    const boot = document.getElementById('boot'), box = document.getElementById('q'), composer = document.getElementById('composer'), login = document.getElementById('login');
    if (boot) return void mark('splash');
    if (!M.marks.splash) return;
    mark('splashGone');
    if (composer && box && !composer.hidden && !box.disabled) mark('composer');
    if (login && login.style.display === 'flex') mark('signIn');
    if (M.marks.composer || M.marks.signIn) mo.disconnect();
  };
  const mo = new MutationObserver(look);
  mo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style'] });
  addEventListener('focusin', e => { if (['q', 'uName', 'uPass', 'pw'].includes(e.target.id)) mark('focus'); }, true);
  addEventListener('DOMContentLoaded', () => mark('parsed'));
})()`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });

// where the panel's main thread spent its time, from a Chrome trace: each event's own time, without what is nested in it
const TRACE_KINDS = {
  ParseHTML: 'parse HTML', ParseAuthorStyleSheet: 'parse CSS', EvaluateScript: 'run scripts', 'v8.run': 'run scripts', 'v8.compile': 'compile', 'V8.CompileCode': 'compile',
  FunctionCall: 'callbacks', TimerFire: 'callbacks', FireAnimationFrame: 'callbacks', EventDispatch: 'callbacks', RunMicrotasks: 'callbacks', 'v8.callFunction': 'callbacks',
  UpdateLayoutTree: 'style', RecalculateStyles: 'style', Layout: 'layout', PrePaint: 'paint', Paint: 'paint', Layerize: 'paint', Commit: 'paint', MinorGC: 'gc', MajorGC: 'gc',
};
function traceSummary(buffer) {
  const events = (JSON.parse(buffer.toString()).traceEvents || []).filter(e => e.ph === 'X' && e.dur != null);
  const home = events.find(e => (e.name === 'ParseHTML' || e.name === 'EvaluateScript') && /\/(widget|chat)\b/.test(JSON.stringify(e.args || {})));
  if (!home) return null;
  const mine = events.filter(e => e.pid === home.pid && e.tid === home.tid).sort((x, y) => x.ts - y.ts || y.dur - x.dur);
  const sums = {}, stack = [], close = () => { const top = stack.pop(), kind = TRACE_KINDS[top.name]; if (kind) sums[kind] = (sums[kind] || 0) + top.self; };
  for (const e of mine) {
    while (stack.length && stack.at(-1).end <= e.ts) close();
    if (stack.length) stack.at(-1).self -= e.dur;
    stack.push({ name: e.name, end: e.ts + e.dur, self: e.dur });
  }
  while (stack.length) close();
  return Object.fromEntries(Object.entries(sums).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, Math.round(v / 1000)]));
}

async function run(kind, which, trace) {
  serving = PAGES[which];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const token = kind !== 'panel-signed-out';
  await context.addInitScript(([on]) => { try { if (on && location.hostname === 'localhost') localStorage.setItem('pb_token', 'measure-session'); } catch {} }, [token]);
  await context.addInitScript(probe);
  const tab = await context.newPage(), errors = [];
  tab.on('pageerror', e => errors.push(e.message));
  tab.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const cdp = await context.newCDPSession(tab);
  let t0, frame, shown = null, ready = null;
  if (kind === 'chat') {
    await tab.goto('about:blank');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    if (trace) await browser.startTracing(tab, { categories: ['devtools.timeline', 'v8', 'loading'] });
    requests = []; t0 = now();
    await tab.goto(ORIGIN + '/chat', { waitUntil: 'commit' });
    frame = tab.mainFrame();
  } else {
    await tab.goto(HOST + '/host');
    await tab.evaluate(u => new Promise(r => { const f = document.createElement('iframe'); f.style.display = 'none'; f.onload = r; f.src = u; document.body.appendChild(f); }), ORIGIN + '/blank');
    const slow = await context.newCDPSession(tab.frames().find(f => f.url() === ORIGIN + '/blank')); // the process the panel will run in
    await slow.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    await tab.evaluate(() => { // when the bookmark hears 'ready', and when it starts to fade its frame in
      window.__h = {};
      addEventListener('message', e => { if (e.data?.type === 'ready' && !window.__h.ready) window.__h.ready = performance.timeOrigin + performance.now(); });
      const tick = () => { const f = document.getElementById('__pagebot'); if (f && f.style.opacity === '1') window.__h.shown = performance.timeOrigin + performance.now(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    if (trace) await browser.startTracing(tab, { categories: ['devtools.timeline', 'v8', 'loading'] });
    const code = bookmarklet.replaceAll('__ORIGIN__', ORIGIN).replaceAll('__VERSION__', '13').replace(/\n\s*/g, '');
    requests = [];
    t0 = await tab.evaluate(c => { const t = performance.timeOrigin + performance.now(); (0, eval)(c); return t; }, code);
    for (let i = 0; i < 400 && !frame; i++) { frame = tab.frames().find(f => f.url().startsWith(ORIGIN + '/widget')); if (!frame) await sleep(10); }
  }
  const goal = token ? 'composer' : 'signIn';
  await frame.waitForFunction(g => window.__m?.marks[g], goal, { timeout: 60000 });
  await sleep(900); // the bookmark's fade, a late second boot, and anything else a slow start would still be doing
  const m = await frame.evaluate(() => ({
    ...window.__m, nav: performance.getEntriesByType('navigation')[0]?.toJSON(), origin: performance.timeOrigin,
    paint: performance.getEntriesByType('paint').map(p => [p.name, performance.timeOrigin + p.startTime]),
  }));
  if (kind !== 'chat') ({ ready, shown } = await tab.evaluate(() => window.__h));
  const breakdown = trace ? traceSummary(await browser.stopTracing()) : null;
  await context.close();
  const rel = t => t == null ? null : Math.round(t - t0), boots = requests.filter(r => r.path === '/api/boot');
  return {
    kind, which, errors,
    htmlFirstByte: rel(m.origin + m.nav.responseStart), htmlDone: rel(m.origin + m.nav.responseEnd), bootSent: rel(boots[0]?.start), bootBack: rel(m.boots[0]), bootRequests: boots.length,
    ready: rel(ready), panelShown: rel(shown), firstPaint: rel(m.paint.find(p => p[0] === 'first-contentful-paint')?.[1]), parsed: rel(m.marks.parsed),
    splashGone: rel(m.marks.splashGone), usable: rel(m.marks[goal]), focus: rel(m.marks.focus),
    longTasks: m.long.length, longTaskMs: m.long.reduce((a, l) => a + l, 0),
    requests: requests.map(r => `${r.path}@${rel(r.start)}`), unexpected: requests.filter(r => r.unexpected).map(r => r.path), breakdown,
  };
}

const median = list => { const a = list.filter(v => v != null).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
const COLS = ['htmlFirstByte', 'htmlDone', 'bootSent', 'bootBack', 'ready', 'panelShown', 'firstPaint', 'parsed', 'splashGone', 'usable', 'focus', 'bootRequests', 'longTasks', 'longTaskMs'];
const WHICH = Object.keys(PAGES).reverse(); // the older copy first, when there is one
const out = { settings: { gzip: GZIP, rtt: RTT, kbps: KBPS, cpu: CPU, bootMs: BOOT_MS, runs: RUNS, pages: Object.fromEntries(WHICH.map(w => [w, { file: PAGES[w].file, bytes: PAGES[w].body.length, gzipBytes: PAGES[w].gz.length }])) }, cases: {} };
for (const w of WHICH) console.log(`${w}: ${PAGES[w].file}, ${PAGES[w].body.length} bytes (${PAGES[w].gz.length} gzipped)`);
console.log(`sent ${GZIP ? 'gzipped' : 'as is'}; round trip ${RTT} ms, ${KBPS} kbit/s, CPU ${CPU}x slower, /api/boot ${BOOT_MS} ms, ${RUNS} runs each (medians)`);
for (const kind of CASES) {
  const runs = Object.fromEntries(WHICH.map(w => [w, []]));
  for (let i = 0; i < RUNS; i++) for (const w of WHICH) runs[w].push(await run(kind, w, false));
  const med = Object.fromEntries(WHICH.map(w => [w, Object.fromEntries(COLS.map(c => [c, median(runs[w].map(r => r[c]))]))]));
  let breakdown = null; // one traced run per page, one after the other (the browser records one trace at a time)
  if (TRACE) { breakdown = {}; for (const w of WHICH) breakdown[w] = (await run(kind, w, true)).breakdown; }
  out.cases[kind] = { median: med, runs, breakdown };
  console.log(`\n${kind}${' '.repeat(Math.max(1, 18 - kind.length))}${WHICH.map(w => w.padStart(7)).join('')}`);
  for (const c of COLS) if (WHICH.some(w => med[w][c] != null)) console.log(`  ${c.padEnd(16)}${WHICH.map(w => String(med[w][c] ?? '-').padStart(7)).join('')}   ${WHICH.map(w => `[${runs[w].map(r => r[c]).join(' ')}]`).join(' ')}`);
  for (const w of WHICH) console.log(`  requests (${w}): ${runs[w][0].requests.join('  ')}`);
  if (breakdown) for (const w of WHICH) console.log(`  main thread (${w}): ${Object.entries(breakdown[w] || {}).map(([k, v]) => `${k} ${v} ms`).join(', ')}`);
  const bad = WHICH.flatMap(w => runs[w].flatMap(r => [...r.errors, ...r.unexpected.map(p => 'unexpected request ' + p)].map(x => `${w}: ${x}`)));
  if (bad.length) console.log(`  PROBLEMS: ${[...new Set(bad)].join(' | ')}`);
}
if (opt('json')) await writeFile(opt('json'), JSON.stringify(out, null, 1));
await browser.close();
server.close();

// pagebot's side panel page. It frames the pagebot panel (this server's /widget) and runs the panel's page steps in this
// browser window: reading and clicking through the page-side helper (content.js, the bookmark's reviewed code), tabs and
// navigation through chrome.tabs, screenshots through captureVisibleTab, and real typing, keys and clicks at a point
// through chrome.debugger, attached for one step at a time. It lives exactly as long as the side panel, so closing the
// panel stops everything; worker.js only opens the panel and cleans up after one that closed in the middle of a step.
// The panel decides what to ask the person (it holds the approval cards); this page checks every step again: the answer
// it belongs to, this window, the tab that's showing, pages pagebot never works on, and the sites the person approved.
'use strict';
const ORIGIN = "__ORIGIN__", EXT_V = __EXT_VERSION__;
const frame = document.getElementById('pb');
const qs = new URLSearchParams(location.search);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clip = (v, n) => String(v ?? '').slice(0, n);

// the members of Anthropic's browser toolset this extension runs beyond what the bookmark can (README "Browser extension")
const TOOLS = ['navigate', 'new_tab', 'list_tabs', 'switch_tab', 'close_tab', 'read_console', 'read_network', 'javascript_exec',
  'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'type', 'key', 'hold_key'];
const NEEDS_DEBUGGER = new Set(['read_console', 'javascript_exec', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag',
  'left_mouse_down', 'left_mouse_up', 'type', 'key', 'hold_key']);

// ---- which window this panel belongs to ----
// The side panel's own window; the ?win= form is the same page opened as a small window (browsers without a side panel)
// or by the tests, acting on the window it names.
let winId = null;
const bound = (/^\d{1,12}$/.test(qs.get('win') || '') ? Promise.resolve(Number(qs.get('win'))) : chrome.windows.getCurrent().then(w => w.id))
  .then(id => { winId = id; return id; });

// ---- the panel (ORIGIN/widget) ----
// Only messages from the pagebot origin's frame inside this page are obeyed, and replies go only to that origin.
const toWidget = m => { try { frame.contentWindow.postMessage(m, ORIGIN); } catch {} };
addEventListener('message', e => {
  if (e.source !== frame.contentWindow || e.origin !== ORIGIN) return;
  const d = e.data;
  if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.type !== 'string' || !Object.hasOwn(HANDLERS, d.type)) return;
  onWidget(d);
});
async function onWidget(d) {
  let out;
  try { out = await HANDLERS[d.type](d); } catch (err) { out = { error: words(err) }; }
  if (d.id != null && out !== undefined) toWidget({ ...out, id: d.id });
}
function words(err) {
  const m = String(err?.message || err || 'It didn’t work.');
  if (/No tab with id|Tabs cannot be edited/i.test(m)) return 'That tab isn’t there anymore. Use list_tabs.';
  if (/Receiving end does not exist|message port closed|Could not establish connection/i.test(m)) return 'The page changed before pagebot could finish. Look at it again (screenshot or read_page).';
  if (/Cannot access|cannot be scripted|chrome:\/\/|edge:\/\//i.test(m)) return RESTRICT.browser;
  return clip(m, 300);
}
const fail = msg => { throw new Error(msg); };

// ---- the worker: it detaches the debugger if this page goes away in the middle of a step ----
let port = null;
function connect() {
  try {
    port = chrome.runtime.connect({ name: 'panel' });
    port.onDisconnect.addListener(() => { port = null; });
    for (const tabId of attached) port.postMessage({ t: 'dbg', tabId, on: true }); // a restarted worker learns what's attached
  } catch { port = null; }
}
function toWorker(m) { if (!port) connect(); try { port?.postMessage(m); } catch { port = null; } }
connect();
setInterval(() => { if (attached.size || R?.held.mouse) toWorker({ t: 'ping' }); }, 20000); // keeps the worker awake while it might have to clean up

// ---- tabs ----
const RESTRICT = {
  browser: 'pagebot can’t work on the browser’s own pages. Ask the user to switch to a normal web page, or use navigate.',
  store: 'pagebot doesn’t work on the extension store.',
  pagebot: 'pagebot doesn’t work on its own pages.',
  empty: 'This tab is empty. Use navigate to open an address in it.',
  pdf: 'This tab shows a PDF in the browser’s viewer. pagebot can look at it in a screenshot; to read all of it, ask the user to add the PDF with + → Upload a PDF.',
};
// what kind of page pagebot never works on ('' for a normal web page)
function kindOf(url) {
  if (!url || url === 'about:blank') return url ? 'empty' : 'browser';
  let u; try { u = new URL(url); } catch { return 'browser'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'browser';
  const h = u.hostname.toLowerCase();
  if (h === 'chromewebstore.google.com' || h === 'chrome.google.com' && u.pathname.startsWith('/webstore') || h === 'microsoftedge.microsoft.com' && u.pathname.startsWith('/addons')) return 'store';
  if (u.origin === ORIGIN) return 'pagebot';
  return '';
}
const originOf = url => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; } };
const hostOf = url => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };
const tabUrl = t => t.url || t.pendingUrl || '';
async function tabsList() {
  const all = await chrome.tabs.query({ windowId: winId });
  return all.map(t => ({ tab_id: 'tab-' + t.id, title: clip(t.title, 300), url: clip(tabUrl(t), 2000), ...(t.active && { active: true }) }));
}
async function activeTab() { await bound; const [t] = await chrome.tabs.query({ active: true, windowId: winId }); return t || null; }
async function tabIn(id) { // a tab of this window, or an error
  let t = null; try { t = await chrome.tabs.get(id); } catch {}
  if (!t || t.windowId !== winId) fail('That tab isn’t in this window. pagebot only works with the tabs in its own window; use list_tabs.');
  return t;
}
const tabNum = s => { const m = /^tab-(\d{1,10})$/.exec(typeof s === 'string' ? s : ''); return m ? Number(m[1]) : null; };

// ---- the page-side helper ----
// Injected on demand into the top frame of the tab that's showing (and into its frames only to check where typing would
// land). Each new document gets the next ref block number first, so refs never carry over from a page that's gone.
let genMem = 0;
async function nextGen() {
  try { const { gen = 0 } = await chrome.storage.session.get('gen'); const g = gen % 9000 + 1; await chrome.storage.session.set({ gen: g }); return g; }
  catch { return (genMem = genMem % 9000 + 1); }
}
async function ensure(tabId) {
  const ping = () => chrome.tabs.sendMessage(tabId, { t: 'ping' }, { frameId: 0 });
  try { const r = await ping(); if (r?.ok) return r; } catch {}
  const g = await nextGen();
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: n => { window.__pbxGen = n; }, args: [g] });
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
  const r = await ping();
  if (!r?.ok) fail('The page didn’t answer.');
  return r;
}
async function cs(tabId, msg) {
  await ensure(tabId);
  try { return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }); }
  catch { await ensure(tabId); return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }); } // it navigated in between
}
// the same question in every frame of the tab (cross-origin ones too): [{ frameId, r }]
async function allFrames(tabId, msg) {
  const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).catch(() => []);
  const out = [];
  for (const { frameId } of res) {
    try { out.push({ frameId, r: await chrome.tabs.sendMessage(tabId, msg, { frameId }) }); } catch {}
  }
  return out;
}

// ---- one answer ("run"): the panel says when it starts and ends ----
// R: { id, tabId: the tab pagebot works on, start, own: tabs it opened, sites: origins it may work on, held, ctl, sures,
// sessions: debugger sessions open for its steps, shots: each tab's visible size at its latest screenshot }
let R = null;
function runOn(id) {
  runOff();
  const r = R = { id, tabId: null, start: null, own: new Set(), sites: new Set(), created: new Set(), held: { mouse: false, keys: [], tab: null, x: 0, y: 0 },
    ctl: new AbortController(), noDebug: false, sures: new Map(), sessions: new Set(), shots: new Map() };
  r.ready = activeTab().then(t => {
    if (!t) return;
    r.tabId = r.start = t.id;
    if (!kindOf(tabUrl(t))) r.sites.add(originOf(tabUrl(t)));
  }).catch(() => {});
}
// Stop, the panel closing and the end of the answer all come here. The step in flight ends at once: every debugger command
// races the abort, and its session detaches (letting go of any key it holds) without waiting for the page. A mouse button
// a step left pressed is never let go of over the page, since that would finish a click nobody approved; it's forgotten
// instead, and the page's next real click starts afresh. Nothing touches the page after this.
function runOff() {
  const r = R;
  if (!r) return;
  R = null;
  r.ctl.abort();
  for (const s of r.sessions) s.kill();
  if (r.held.mouse) { r.held.mouse = false; toWorker({ t: 'held', tabId: r.held.tab, keys: [], mouse: false }); }
}
const stopped = () => new Error('Stopped.');
const nap = (r, ms) => new Promise((ok, no) => {
  const sig = r.ctl.signal;
  if (sig.aborted) return no(stopped());
  const stop = () => { clearTimeout(t); no(stopped()); };
  const t = setTimeout(() => { sig.removeEventListener('abort', stop); ok(); }, ms);
  sig.addEventListener('abort', stop, { once: true });
});

// ---- the gate, before every step ----
const SWITCHED = 'The user switched to another tab, so pagebot didn’t touch it. Finish in words, or ask the user; switch_tab asks them first.';
// o.page: false skips the allowed-page check, o.site: false the approved-site check, o.showing: false the tab-showing check; o.pdf lets a PDF tab through
async function gate(d, o = {}) {
  const r = R;
  if (!r || d.run !== r.id) return { stop: { error: 'Stopped.' } };
  await r.ready;
  if (o.showing === false) return { r };
  if (r.tabId == null) return { stop: { error: 'pagebot isn’t on a tab now. Use switch_tab to pick one of the tabs it opened, or new_tab.' } };
  if (d.tab != null && tabNum(d.tab) !== r.tabId) return { stop: { error: 'That isn’t the tab pagebot is working on, and it only acts on the tab that’s showing. Use switch_tab first.' } };
  let t = null; try { t = await chrome.tabs.get(r.tabId); } catch {}
  if (!t || t.windowId !== winId) return { stop: { error: 'That tab isn’t in this window anymore. Use list_tabs and switch_tab.' } };
  if (!t.active) return { stop: { error: SWITCHED, away: true } };
  const url = tabUrl(t);
  if (o.page !== false) {
    let k = kindOf(url);
    if (!k) { try { if ((await ensure(t.id)).pdf) k = 'pdf'; } catch { k = /\.pdf$/i.test(url.split(/[?#]/)[0]) ? 'pdf' : 'browser'; } }
    if (k && !(k === 'pdf' && o.pdf)) return { stop: { error: RESTRICT[k], restricted: k } };
  }
  if (o.site !== false) {
    const og = originOf(url);
    if (og && !r.sites.has(og)) {
      if (d.site === og) r.sites.add(og); // the person approved working here (the panel's new-site card)
      else return { stop: { no: 'site', site: hostOf(url), sure: og } };
    }
  }
  if (r !== R) return { stop: { error: 'Stopped.' } };
  return { r, t };
}
const far = (r, url) => { const o = originOf(url); return !o || !r.sites.has(o); };

// ---- settling after a step that may change the page or open tabs ----
// Tabs the working tab opened during the step join the ones pagebot opened (and if the browser showed one, pagebot follows
// it); then the working tab is given up to 10 s to finish loading, and the window's tabs go back with the result.
async function settle(r, { ms = 300, closeFar = null } = {}) {
  await sleep(ms);
  const opened = [...r.created]; r.created.clear();
  let blocked = '';
  for (const id of opened) {
    if (closeFar) { // a debugger step: a new tab on a site nobody approved is closed again
      let t = null; try { t = await chrome.tabs.get(id); } catch {}
      const u = t ? tabUrl(t) : '', o = originOf(u);
      if (t && o && !r.sites.has(o) && !closeFar.has(o)) { blocked = u; await chrome.tabs.remove(id).catch(() => {}); continue; }
    }
    r.own.add(id);
  }
  const a = await activeTab();
  if (a && r.own.has(a.id) && opened.includes(a.id)) r.tabId = a.id;
  for (const end = Date.now() + 10000; Date.now() < end; await sleep(150)) {
    let t; try { t = await chrome.tabs.get(r.tabId); } catch { break; }
    if (t.status === 'complete') break;
  }
  const tabs = await tabsList(), ids = new Set(tabs.map(x => x.tab_id)), cur = tabs.find(x => x.tab_id === 'tab-' + r.tabId);
  const kept = opened.map(n => 'tab-' + n).filter(x => ids.has(x));
  return { tabs, ...(kept.length && { opened: kept }), ...(cur && { url: cur.url, title: cur.title }), ...(blocked && { blocked }) };
}
const NOT_APPROVED = u => `That went to ${hostOf(u) || 'another site'}, which the user hasn’t approved, so pagebot stopped it. Use navigate if they should go there (it asks them).`;
const KEYS_AWAY = u => `The keys moved to something that goes to ${hostOf(u) || 'another site'}, which the user hasn’t approved, so pagebot stopped before pressing it. Use navigate if they should go there (it asks them).`;

// ---- chrome.debugger, attached only for the step that needs it ----
const attached = new Set();
let lastDetach = 0; // when this panel last let go of a tab (Chrome's bar stays up a few seconds after)
const NO_DEBUG = 'The user stopped pagebot from Chrome’s bar, so it can’t type or click at a point in this answer. Use refs with left_click and form_input instead.';
const SLOW = 'The page didn’t answer in time, so pagebot let go of it.';
// (it can't take hold of the tab: another debugger, such as DevTools, may be on it. A step that needs it doesn't run unheld.)
const TAKEN = 'Another tool is attached to this tab (DevTools, perhaps), so pagebot can’t do this step here right now. Ask the user to close it, or to do the step themselves.';
chrome.debugger?.onDetach.addListener((src, reason) => {
  if (src.tabId == null) return;
  attached.delete(src.tabId);
  if (reason === 'canceled_by_user' && R) R.noDebug = true;
});
const canDebug = r => !!chrome.debugger && !r.noDebug;
// One debugger session for one step. It ends, and detaches, when the step is done, when it runs past ms, or the moment the
// answer stops: every command races that end, so a command the page never answers (a script waiting forever) can't keep
// the debugger on the tab. What the step asked to undo on the way out (send.later: letting go of keys, listeners) runs
// before the detach. The panel's step gives up after msFor() in widget.html, so ms stays below that.
async function dbg(r, tabId, fn, ms = 15000) {
  if (!chrome.debugger) fail('Typing and clicking at a point aren’t available in this browser.');
  if (r.noDebug) fail(NO_DEBUG);
  if (r !== R || r.ctl.signal.aborted) throw stopped();
  const target = { tabId };
  try { await chrome.debugger.attach(target, '1.3'); }
  catch (e) {
    if (!(/already attached/i.test(e?.message || '') && attached.has(tabId))) fail(TAKEN);
    await chrome.debugger.detach(target).catch(() => {}); // our own leftover
    await chrome.debugger.attach(target, '1.3').catch(() => fail(TAKEN));
  }
  attached.add(tabId); toWorker({ t: 'dbg', tabId, on: true });
  let quit;
  const end = new Promise((_, no) => { quit = no; });
  end.catch(() => {});
  const timer = setTimeout(() => quit(new Error(SLOW)), ms);
  const onAbort = () => quit(stopped());
  r.ctl.signal.addEventListener('abort', onAbort, { once: true });
  const later = [];
  let over = false, closed;
  const s = { kill: () => quit(stopped()), done: new Promise(ok => { closed = ok; }) };
  r.sessions.add(s);
  const raw = (method, params) => chrome.debugger.sendCommand(target, method, params);
  const send = (method, params) => {
    if (over || r !== R || r.ctl.signal.aborted) return Promise.reject(stopped());
    if (r.noDebug) return Promise.reject(new Error(NO_DEBUG));
    return Promise.race([raw(method, params), end]);
  };
  send.later = f => later.push(f);
  try { return await Promise.race([fn(send), end]); }
  finally {
    over = true; clearTimeout(timer); r.ctl.signal.removeEventListener('abort', onAbort);
    for (const f of later.reverse()) { try { await Promise.race([f(raw), sleep(1000)]); } catch {} }
    await chrome.debugger.detach(target).catch(() => {});
    attached.delete(tabId); lastDetach = Date.now(); toWorker({ t: 'dbg', tabId, on: false });
    r.sessions.delete(s); closed();
  }
}
// While a step that may change the page runs, a page load toward a site nobody approved is held and refused: the tab's own
// navigations and every redirect hop of them (so a same-site address that bounces elsewhere stops at the bounce).
async function holdNav(r, tabId, send, approved) {
  let main = null; try { main = (await send('Page.getFrameTree')).frameTree.frame.id; } catch {}
  const st = { blocked: '' };
  const ok = u => { const o = originOf(u); return !!o && (r.sites.has(o) || approved.has(o)); };
  const on = (src, method, p) => {
    if (src.tabId !== tabId || method !== 'Fetch.requestPaused') return;
    if (main && p.frameId !== main || ok(p.request.url)) chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    else { st.blocked = p.request.url; chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' }).catch(() => {}); }
  };
  chrome.debugger.onEvent.addListener(on);
  send.later(() => chrome.debugger.onEvent.removeListener(on));
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
  return st;
}
// a step with input: attached, holding page loads, and staying attached half a second after the last input so a load
// the input starts is still held
async function inputStep(r, t, approved, fn, ms) {
  let st = null;
  await dbg(r, t.id, async send => {
    st = await holdNav(r, t.id, send, approved);
    await fn(send);
    await nap(r, 500);
  }, ms);
  return st?.blocked || '';
}
const mouse = (send, type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });

// ---- Chrome's "started debugging this browser" bar ----
// While pagebot has the debugger on a tab (and for about five seconds after), Chrome shows a bar that takes some of the
// page's height, and anything placed against the bottom of the window (a cookie bar, a chat button) moves up with it. So
// screenshots in an answer are taken with the bar up, and a step at a point waits until the page is the size it was in
// the latest screenshot: a point then means the same place in both. A point outside what's showing asks for a new one.
const view = async send => { const m = (await send('Page.getLayoutMetrics')).cssLayoutViewport; return { w: m.clientWidth, h: m.clientHeight }; };
async function barUp(r, send) {
  if (attached.size > 1 || Date.now() - lastDetach < 3500) return; // still up from a moment ago
  const a = await view(send);
  for (const end = Date.now() + 700; Date.now() < end;) { await nap(r, 40); if ((await view(send)).h !== a.h) { await nap(r, 80); return; } }
}
const RESIZED = 'The page’s visible area changed size since the latest screenshot, so that point may not be where it was. Take a new screenshot and use a point from it.';
const OUTSIDE = 'That point isn’t on the part of the page that’s showing now. Take a new screenshot and use a point from it.';
async function fits(r, t, send, pts) {
  const shot = r.shots.get(t.id), same = v => !shot || Math.abs(v.w - shot.w) <= 1 && Math.abs(v.h - shot.h) <= 1;
  let v = await view(send);
  for (const end = Date.now() + 900; !same(v) && Date.now() < end;) { await nap(r, 40); v = await view(send); }
  if (!same(v)) fail(RESIZED);
  for (const p of pts) if (!(p.x >= 0 && p.y >= 0 && p.x < v.w && p.y < v.h)) fail(OUTSIDE);
}

// ---- keys ----
const MOD = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, win: 4, shift: 8 };
const KEYS = {};
const def = (names, key, code, keyCode, text, shifted) => { for (const n of names.split(' ')) KEYS[n] = { key, code, keyCode, text, shifted }; };
def('enter return', 'Enter', 'Enter', 13, '\r'); def('tab', 'Tab', 'Tab', 9); def('escape esc', 'Escape', 'Escape', 27);
def('backspace', 'Backspace', 'Backspace', 8); def('delete del', 'Delete', 'Delete', 46); def('insert', 'Insert', 'Insert', 45);
def('space', ' ', 'Space', 32, ' ', ' ');
def('arrowup up', 'ArrowUp', 'ArrowUp', 38); def('arrowdown down', 'ArrowDown', 'ArrowDown', 40);
def('arrowleft left', 'ArrowLeft', 'ArrowLeft', 37); def('arrowright right', 'ArrowRight', 'ArrowRight', 39);
def('home', 'Home', 'Home', 36); def('end', 'End', 'End', 35); def('pageup', 'PageUp', 'PageUp', 33); def('pagedown', 'PageDown', 'PageDown', 34);
for (let i = 1; i <= 12; i++) def('f' + i, 'F' + i, 'F' + i, 111 + i);
for (let i = 0; i < 26; i++) { const c = String.fromCharCode(97 + i); def(c, c, 'Key' + c.toUpperCase(), 65 + i, c, c.toUpperCase()); }
for (let i = 0; i < 10; i++) def(String(i), String(i), 'Digit' + i, 48 + i, String(i), ')!@#$%^&*('[i]);
for (const [c, code, kc, sh] of [['`', 'Backquote', 192, '~'], ['-', 'Minus', 189, '_'], ['=', 'Equal', 187, '+'], ['[', 'BracketLeft', 219, '{'], [']', 'BracketRight', 221, '}'],
  ['\\', 'Backslash', 220, '|'], [';', 'Semicolon', 186, ':'], ["'", 'Quote', 222, '"'], [',', 'Comma', 188, '<'], ['.', 'Period', 190, '>'], ['/', 'Slash', 191, '?']]) def(c, c, code, kc, c, sh);
def('shift', 'Shift', 'ShiftLeft', 16); def('control ctrl', 'Control', 'ControlLeft', 17); def('alt option', 'Alt', 'AltLeft', 18); def('meta cmd command super win', 'Meta', 'MetaLeft', 91);
const BIT = { Shift: 8, Control: 2, Alt: 1, Meta: 4 };
// "ctrl+shift+a" → { mods: bits, modKeys, main, name }; unknown names are an error
function chord(s) {
  const parts = s === '+' ? ['shift', '='] : s.endsWith('++') ? [...s.slice(0, -2).split('+'), '='] : s.split('+');
  const mods = [], name = parts.at(-1);
  for (const p of parts.slice(0, -1)) { const n = p.toLowerCase(); if (MOD[n] == null) fail(`pagebot doesn’t know the key “${clip(p, 30)}”.`); mods.push(KEYS[n]); }
  let main = KEYS[name.toLowerCase()];
  if (!main) fail(`pagebot doesn’t know the key “${clip(name, 30)}”.`);
  if (/^[A-Z]$/.test(name)) mods.push(KEYS.shift);
  if (MOD[name.toLowerCase()] != null) { mods.push(main); main = null; } // a modifier on its own ("shift")
  const modKeys = [...new Set(mods)];
  return { mods: modKeys.reduce((m, k) => m | BIT[k.key], 0), modKeys, main, name: name.toLowerCase() };
}
const PASTE = c => (c.mods & (2 | 4)) && c.name === 'v' || (c.mods & 8) && c.name === 'insert';
const MAC = /Mac/.test(navigator.platform || '');
async function keyDown(send, c, repeat) {
  let m = 0;
  if (!repeat) for (const k of c.modKeys) { m |= BIT[k.key]; await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: m, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode }); }
  m = c.mods;
  if (!c.main) return;
  const k = c.main, text = m & 7 ? '' : (m & 8 ? k.shifted : k.text) || '';
  const key = text && text !== '\r' ? text : k.key;
  const commands = MAC && m & 4 && { a: ['selectAll'], c: ['copy'], x: ['cut'], z: [m & 8 ? 'redo' : 'undo'] }[c.name];
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', modifiers: m, key, code: k.code, windowsVirtualKeyCode: k.keyCode,
    ...(text && { text, unmodifiedText: text }), ...(repeat && { autoRepeat: true }), ...(commands && { commands }) });
}
async function keyUp(send, c) {
  let m = c.mods;
  if (c.main) {
    const k = c.main, text = m & 7 ? '' : (m & 8 ? k.shifted : k.text) || '';
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: m, key: text && text !== '\r' ? text : k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
  }
  for (const k of [...c.modKeys].reverse()) { m &= ~BIT[k.key]; await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: m, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode }); }
}
const printable = c => !!c.main && !(c.mods & 7) && !!c.main.text && c.main.text !== '\r';

// ---- words for refusals (the model reads these) ----
const NO = {
  gone: 'That ref isn’t on the page anymore. Use read_page or find again.',
  file: 'pagebot never opens file pickers. Ask the user to choose the file themselves.',
  password: 'pagebot never reads or types into password fields. Ask the user to fill it in themselves.',
  payment: 'pagebot never reads or types into payment card fields. Ask the user to fill it in themselves.',
  frame: 'The keyboard is in a part of the page that pagebot can’t check (a frame from another site, or a part the page keeps closed), so it didn’t type there. Click the field first, or ask the user.',
  nofocus: 'Nothing on the page is ready for typing. Click the field first (left_click), then type.',
  paste: 'pagebot never pastes from the clipboard: that would hand the user’s clipboard to the page. Type the text instead.',
  filled: 'Something is typed into a password or card field on this page, so pagebot won’t run a script here. Ask the user, or do it another way.',
  pagebot: 'That’s pagebot’s own panel inside this page. pagebot doesn’t click or type in its own pages.',
  ownframes: 'pagebot’s own panel is open inside this page (the bookmark’s), so pagebot doesn’t click at a point inside frames here. Use refs, or ask the user to close that panel.',
};
const refuse = f => fail(f.no === 'covered' ? `Something else is on top of that element${f.by ? ` (“${clip(f.by, 60)}”)` : ''}, so a click there wouldn’t reach it. Close it or scroll first.`
  : NO[f.no] || NO.gone);
// pagebot's own pages framed inside this one (the bookmark's panel): never clicked at a point or typed into
const ownUrl = u => typeof u === 'string' && (u === ORIGIN || u.startsWith(ORIGIN + '/'));
async function ownFrames(t) {
  const res = await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, func: () => [location.origin, location.href] }).catch(() => []);
  return res.some(x => x.frameId !== 0 && Array.isArray(x.result) && (x.result[0] === ORIGIN || ownUrl(x.result[1])));
}
// where a target is: a ref's centre (if a click there would land on it) or a point, with what's there. A point on a frame
// pagebot can't look into is refused while one of pagebot's own pages is framed anywhere in the tab, since it may be that.
async function where(t, target) {
  if (target?.type === 'ref') { const c = await cs(t.id, { t: 'center', ref: target.ref }); if (c?.no) refuse(c); return c; }
  if (target?.type === 'coordinate' && Number.isFinite(target.x) && Number.isFinite(target.y)) {
    let p = { role: 'generic', label: '', nav: '' };
    try { p = await cs(t.id, { t: 'point', x: target.x, y: target.y }); } catch {}
    if (p.frame && await ownFrames(t)) refuse({ no: 'ownframes' });
    return { ...p, x: target.x, y: target.y };
  }
  fail('target must be a ref or a point.');
}
// What has the keyboard. In a frame from another site, the frames are asked themselves: a protected field in any of them
// refuses, pagebot's own panel refuses, and no frame able to say (one pagebot can't reach) refuses too. `id` names the
// element (its frame and the helper's own number for it), so a step can check it's still the one the person approved.
async function focusOf(t) {
  let f = await cs(t.id, { t: 'focus' });
  if (f?.frame === 'cross') {
    const seen = (await allFrames(t.id, { t: 'focus' })).filter(x => x.frameId !== 0 && x.r && !x.r.frame && !x.r.error).map(x => ({ ...x.r, frameId: x.frameId }));
    const bad = seen.find(x => x.no);
    if (bad) return bad;
    const busy = seen.filter(x => !x.none), lit = busy.filter(x => x.hasFocus), pick = lit.length ? lit : busy;
    if (pick.some(x => ownUrl(x.url))) return { no: 'pagebot' };
    f = pick[0] || { no: 'frame' };
  } else f = { ...f, frameId: 0 };
  return { ...f, id: `${f.frameId || 0}/${f.fid || ''}` };
}
async function valueNow(t, f) {
  try { const x = f.frameId ? await chrome.tabs.sendMessage(t.id, { t: 'focus' }, { frameId: f.frameId }) : await cs(t.id, { t: 'focus' }); return x?.value; } catch { return undefined; }
}
const MS_LOAD = 15000;
async function loaded(r, tabId, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await nap(r, 150)) {
    let t; try { t = await chrome.tabs.get(tabId); } catch { return null; }
    if (t.status === 'complete') return t;
  }
  return null;
}
// Console and network lines lose what often carries a secret before the model sees them: query strings and #hashes, JWTs,
// anything after a credential-sounding name (sid=, session_id:, x-api-key=, Authorization: Bearer …), bearer and basic
// tokens, well-known key shapes (AWS, Stripe, GitHub, Slack), long mixed values after "=", and any long run of key-like
// characters.
const SECRET_NAME = String.raw`[\w.-]*(?:auth|bearer|token|api[_-]?key|apikey|secret|passw(?:or)?d|pwd|session|sess|sid|cookie|csrf|xsrf|jwt|signature|credential|private[_-]?key|access[_-]?key)[\w.-]*`;
function redact(s) {
  return String(s).replace(/\bhttps?:\/\/[^\s"'<>)]+/g, u => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u.split(/[?#]/)[0]; } })
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[hidden]')
    .replace(new RegExp(String.raw`\b(${SECRET_NAME})(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;&]+`, 'gi'), '$1$2[hidden]')
    .replace(/\b(bearer|basic|token)\s+(?!\[hidden\])[\w.~+/=-]{4,}/gi, '$1 [hidden]')
    .replace(/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g, '[hidden]')
    .replace(/\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{6,}/g, '[hidden]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})/g, '[hidden]')
    .replace(/(=\s*)(?=[^\s&;,"']*\d)(?=[^\s&;,"']*[A-Za-z])[^\s&;,"']{16,}/g, '$1[hidden]')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[hidden]');
}
const lines = (list, max) => { let n = 0; const out = []; for (const l of list.slice(0, max)) { const x = clip(redact(l), 300); if (n + x.length > 20000) break; out.push(x); n += x.length + 1; } return out; };
const consoleMark = new Map(); // tab → the newest console entry read so far

// ---- the toolset members only the extension runs (and the pointer and scroll members it runs for real) ----
// dry(r, t, input) returns what the panel shows and how it asks: ask 'no', 'setting' (asks unless the person said not to)
// or 'always'. run(r, t, input, ok) does it, with ok the dry run's facts: a run must carry the token its dry run handed
// out, for the same input, and if what it would touch changed since (where a click goes, which field has the keyboard) it
// answers { no: 'changed' } instead. Facts whose names start with "_" stay here and never reach the panel.
const CLICK = { left_click: ['left', 1], right_click: ['right', 1], middle_click: ['middle', 1], double_click: ['left', 2], triple_click: ['left', 3] };
const modsOf = s => s ? chord(String(s).replace(/\+?$/, '+a')).mods : 0;
const sameSite = (t, go) => !!originOf(go) && originOf(go) === originOf(tabUrl(t));
function clickFacts(r, t, name, f, modifiers) {
  // a middle click, or a click with ctrl, cmd or shift, opens a link in a new tab instead
  const newTab = name === 'middle_click' || name === 'left_click' && modsOf(modifiers) & (2 | 4 | 8);
  const go = name === 'right_click' ? '' : f.nav || f.tab || '';
  const away = !!go && far(r, go);
  return { role: f.role, label: f.label, at: [f.x, f.y], go, tab: !!f.tab || newTab && !!go, far: away, ask: away ? 'always' : 'setting', ...(go && sameSite(t, go) && { sameSite: true }) };
}
// what a step that may change the page reports: where it went (or what it opened), and the tabs after it settled
const went = (ok, s) => ({ ...(ok.go && (ok.tab ? { tab: ok.go, ...(ok.sameSite && { sameSite: true }) } : { nav: ok.go })), ...s });
// the approved place a step may go (its own destination, which the person saw on the card or which is on the same site)
function approve(r, go) { const o = originOf(go); if (o) r.sites.add(o); return new Set(o ? [o] : []); }
async function settled(r, approved) { const s = await settle(r, { closeFar: approved }); if (s.blocked) fail(NOT_APPROVED(s.blocked)); return s; }
const pointMember = {
  gate: {},
  async dry(r, t, x, name) {
    const f = await where(t, x.target);
    if (f.no) refuse(f);
    return clickFacts(r, t, name, f, x.modifiers);
  },
  async run(r, t, x, ok, name) {
    const f = await where(t, x.target);
    if (f.no) refuse(f);
    const now = clickFacts(r, t, name, f, x.modifiers);
    if (now.go !== ok.go || now.tab !== ok.tab) return { no: 'changed' };
    const approved = approve(r, ok.go);
    const [button, count] = CLICK[name], modifiers = modsOf(x.modifiers);
    const blocked = await inputStep(r, t, approved, async send => {
      await fits(r, t, send, [f]);
      await mouse(send, 'mouseMoved', f.x, f.y, { modifiers });
      for (let i = 1; i <= count; i++) {
        await mouse(send, 'mousePressed', f.x, f.y, { button, clickCount: i, modifiers });
        await mouse(send, 'mouseReleased', f.x, f.y, { button, clickCount: i, modifiers });
      }
    });
    if (blocked) fail(NOT_APPROVED(blocked));
    return { role: f.role, label: f.label, ...went(ok, await settled(r, approved)) };
  },
};
// A drag ends with the button let go: when it starts and ends on the same link, that's a click on it, so it asks the way
// a click there would. Anywhere else, a page load it sets off toward a site nobody approved is held, and a tab is closed.
function dragFacts(r, t, a, b) {
  const ga = a.nav || a.tab || '', gb = b.nav || b.tab || '', go = ga && ga === gb ? ga : '', away = !!go && far(r, go);
  return { ask: away ? 'always' : 'setting', from: { role: a.role, label: a.label }, to: { role: b.role, label: b.label }, go, tab: !!go && !!b.tab, far: away };
}
const MEMBERS = {
  left_click: pointMember, right_click: pointMember, middle_click: pointMember, double_click: pointMember, triple_click: pointMember,
  hover: {
    async dry() { return { ask: 'no' }; },
    async run(r, t, x) {
      const f = await where(t, x.target);
      await dbg(r, t.id, async send => {
        if (x.target?.type === 'coordinate') await fits(r, t, send, [f]);
        await mouse(send, 'mouseMoved', f.x, f.y, r.held.mouse ? { button: 'left', buttons: 1 } : {});
      });
      return { role: f.role, label: f.label };
    },
  },
  left_click_drag: {
    async dry(r, t, x) {
      const a = await where(t, x.from), b = await where(t, x.target);
      if (a.no) refuse(a);
      return dragFacts(r, t, a, b);
    },
    async run(r, t, x, ok) {
      const a = await where(t, x.from), b = await where(t, x.target);
      if (a.no) refuse(a);
      if (dragFacts(r, t, a, b).go !== ok.go) return { no: 'changed' };
      const approved = approve(r, ok.go);
      const blocked = await inputStep(r, t, approved, async send => {
        await fits(r, t, send, [a, b]);
        await mouse(send, 'mouseMoved', a.x, a.y);
        await mouse(send, 'mousePressed', a.x, a.y, { button: 'left', clickCount: 1 });
        for (let i = 1; i <= 10; i++) { await mouse(send, 'mouseMoved', a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10, { button: 'left', buttons: 1 }); await nap(r, 16); }
        await mouse(send, 'mouseReleased', b.x, b.y, { button: 'left', clickCount: 1 });
      });
      if (blocked) fail(NOT_APPROVED(blocked));
      return went(ok, await settled(r, approved));
    },
  },
  // Pressing alone goes nowhere. The button stays down for left_mouse_up (or a drag by hover) in this answer; if the answer
  // ends first, it's forgotten rather than let go over the page (runOff).
  left_mouse_down: {
    async dry(r, t, x) { const f = await where(t, x.target); if (f.no) refuse(f); return { ask: 'setting', role: f.role, label: f.label }; },
    async run(r, t, x) {
      const f = await where(t, x.target);
      if (f.no) refuse(f);
      await dbg(r, t.id, async send => {
        await fits(r, t, send, [f]);
        await mouse(send, 'mouseMoved', f.x, f.y);
        await mouse(send, 'mousePressed', f.x, f.y, { button: 'left', clickCount: 1 });
        Object.assign(r.held, { mouse: true, tab: t.id, x: f.x, y: f.y });
        toWorker({ t: 'held', tabId: t.id, keys: [], mouse: true, x: f.x, y: f.y });
      });
      return { role: f.role, label: f.label };
    },
  },
  // Letting go where the button went down is a click there, so it asks the way a click at that point would: another site,
  // or another site in a new tab, always asks, and the run is held to what the person approved.
  left_mouse_up: {
    async dry(r, t, x) { const f = await where(t, x.target); if (f.no) refuse(f); return clickFacts(r, t, 'left_click', f); },
    async run(r, t, x, ok) {
      const f = await where(t, x.target);
      if (f.no) refuse(f);
      const now = clickFacts(r, t, 'left_click', f);
      if (now.go !== ok.go || now.tab !== ok.tab) return { no: 'changed' };
      const approved = approve(r, ok.go);
      const blocked = await inputStep(r, t, approved, async send => {
        await fits(r, t, send, [f]);
        await mouse(send, 'mouseMoved', f.x, f.y, { button: 'left', buttons: 1 });
        await mouse(send, 'mouseReleased', f.x, f.y, { button: 'left', clickCount: 1 });
        r.held.mouse = false; toWorker({ t: 'held', tabId: t.id, keys: [], mouse: false });
      });
      if (blocked) fail(NOT_APPROVED(blocked));
      return { role: f.role, label: f.label, ...went(ok, await settled(r, approved)) };
    },
  },
  scroll: {
    gate: { pdf: true },
    async dry() { return { ask: 'no' }; },
    async run(r, t, x) {
      const p = x.target || {}, k = Math.min(Math.max(x.scroll_amount | 0 || 3, 1), 10) * 100, v = x.scroll_direction;
      let f = null; try { f = await cs(t.id, { t: 'point', x: p.x, y: p.y }); } catch {}
      if (f && !f.frame && !f.media) return cs(t.id, { t: 'tool', name: 'scroll', input: x }); // the bookmark's own scrolling
      // a frame from another site, a drawing, or a PDF: a real wheel turn there
      const sig = async () => { try { return (await cs(t.id, { t: 'sig', x: p.x, y: p.y })).sig; } catch { return null; } };
      const before = f && !f.frame ? await sig() : null;
      await dbg(r, t.id, async send => {
        await mouse(send, 'mouseMoved', p.x, p.y);
        await mouse(send, 'mouseWheel', p.x, p.y, { deltaX: v === 'left' ? -k : v === 'right' ? k : 0, deltaY: v === 'up' ? -k : v === 'down' ? k : 0 });
        await nap(r, 250);
      });
      return before != null && before === await sig() ? { moved: false } : {};
    },
  },
  // Typing goes into the field that had the keyboard when the person approved it, or nowhere.
  type: {
    async dry(r, t) { const f = await focusOf(t); if (f.no) refuse(f); if (f.none || !f.edit) fail(NO.nofocus); return { ask: 'setting', role: f.role, label: f.label, _id: f.id }; },
    async run(r, t, x, ok) {
      const f = await focusOf(t);
      if (f.no) refuse(f);
      if (f.none || !f.edit) fail(NO.nofocus);
      if (f.id !== ok._id) return { no: 'changed' };
      const blocked = await inputStep(r, t, new Set(), send => send('Input.insertText', { text: String(x.text) }));
      if (blocked) fail(NOT_APPROVED(blocked));
      const value = await valueNow(t, f);
      return { role: f.role, label: f.label, ...(value != null && { value }) };
    },
  },
  key: {
    async dry(r, t, x) {
      const list = keysOf(x.text), f = await focusOf(t);
      if (f.no) refuse(f);
      const g = keyGo(r, t, list, f);
      return { ask: g.far ? 'always' : 'setting', role: f.role, label: f.label, ...g, _id: f.id };
    },
    async run(r, t, x, ok) {
      const list = keysOf(x.text);
      let f = await focusOf(t);
      if (f.no) refuse(f);
      const g = keyGo(r, t, list, f);
      if (f.id !== ok._id || g.go !== ok.go || g.tab !== ok.tab) return { no: 'changed' };
      const approved = approve(r, ok.go);
      const times = Math.min(Math.max(x.repeat | 0 || 1, 1), 100);
      let moved = false;
      const blocked = await inputStep(r, t, approved, async send => {
        for (let n = 0; n < times; n++) for (const c of list) {
          // a key before this one may have moved the keyboard (Tab, Escape): look again before typing a character, or
          // before Enter or Space, which may now follow a link to a site nobody approved
          if (moved && (printable(c) || goes(c))) {
            f = await focusOf(t); if (f.no) refuse(f); moved = false;
            const h = keyGo(r, t, [c], f);
            if (h.go && h.far && !approved.has(originOf(h.go))) fail(KEYS_AWAY(h.go));
          }
          await keyDown(send, c); await keyUp(send, c);
          if (!printable(c)) moved = true;
        }
      });
      if (blocked) fail(NOT_APPROVED(blocked));
      return { role: f.role, label: f.label, ...went(ok, await settled(r, approved)) };
    },
  },
  hold_key: {
    async dry(r, t, x) { if (PASTE(chord(String(x.text)))) fail(NO.paste); const f = await focusOf(t); if (f.no) refuse(f); return { ask: 'setting', role: f.role, label: f.label, _id: f.id }; },
    async run(r, t, x, ok) {
      const c = chord(String(x.text));
      if (PASTE(c)) fail(NO.paste);
      const f = await focusOf(t);
      if (f.no) refuse(f);
      if (f.id !== ok._id) return { no: 'changed' };
      const ms = Math.min(Math.max(Number(x.duration) || 0, 0), 30) * 1000;
      await dbg(r, t.id, async send => {
        r.held.keys = [c]; r.held.tab = t.id; toWorker({ t: 'held', tabId: t.id, keys: [x.text], mouse: r.held.mouse });
        // always let go, Stop included: the session does this on its way out, before it detaches
        send.later(async raw => { r.held.keys = []; toWorker({ t: 'held', tabId: t.id, keys: [], mouse: r.held.mouse }); await keyUp(raw, c); });
        await keyDown(send, c);
        const end = Date.now() + ms;
        while (Date.now() < end) { await nap(r, Math.min(100, end - Date.now())); if (c.main && Date.now() < end) await keyDown(send, c, true); }
      }, ms + 8000);
      return {};
    },
  },
  // Going somewhere: an address, back, forward or reload. It runs with page loads held (when the debugger is there), so a
  // same-site address that redirects to a site nobody approved stops at that hop. Reloading doesn't approve anything: the
  // gate asks first when the tab is on a site this answer hasn't been approved for.
  navigate: {
    gate: x => x.url === 'reload' ? { pdf: true } : { page: false, site: false },
    async dry(r, t, x) {
      const u = String(x.url || '');
      if (u === 'reload') return { ask: 'setting', how: 'reload', dest: tabUrl(t) };
      if (u === 'back' || u === 'forward') {
        const e = await dbg(r, t.id, async send => { const h = await send('Page.getNavigationHistory'); return h.entries[h.currentIndex + (u === 'back' ? -1 : 1)]; });
        if (!e) fail(u === 'back' ? 'There’s no page to go back to.' : 'There’s no page to go forward to.');
        const away = far(r, e.url);
        return { ask: away ? 'always' : 'setting', how: u, dest: clip(e.url, 2000), far: away };
      }
      const k = destKind(u);
      if (k) fail(k);
      const away = far(r, u);
      // without the debugger a redirect can't be held, so every address asks
      return { ask: away || !canDebug(r) ? 'always' : 'setting', how: 'url', dest: u, far: away };
    },
    async run(r, t, x, ok) {
      const u = String(x.url || ''), history = u === 'back' || u === 'forward';
      if (!history && u !== 'reload' && destKind(u)) fail(destKind(u));
      const approved = u === 'reload' ? new Set() : approve(r, ok.dest);
      let done = null;
      const go = async send => {
        if (u === 'reload') await chrome.tabs.reload(t.id);
        else if (history) {
          const h = await send('Page.getNavigationHistory'), e = h.entries[h.currentIndex + (u === 'back' ? -1 : 1)];
          if (!e || clip(e.url, 2000) !== ok.dest) fail('The tab’s history changed after the user approved it.');
          await send('Page.navigateToHistoryEntry', { entryId: e.id });
        } else await chrome.tabs.update(t.id, { url: u });
        await nap(r, 200);
        done = await loaded(r, t.id, MS_LOAD);
      };
      if (canDebug(r)) { const blocked = await inputStep(r, t, approved, go, MS_LOAD + 5000); if (blocked) fail(NOT_APPROVED(blocked)); }
      else if (history) fail(NO_DEBUG);
      else await go(null);
      const now = done || await chrome.tabs.get(t.id).catch(() => null);
      return { url: now ? tabUrl(now) : '', title: now?.title || '', ...(!done && { loading: true }), tabs: await tabsList() };
    },
  },
  // A new tab becomes the one showing. While the person is on another tab, that would pull them away, so it asks first.
  new_tab: {
    gate: { showing: false },
    async dry(r) { const a = await activeTab(); return !a || a.id !== r.tabId ? { ask: 'always', away: true } : { ask: 'no' }; },
    async run(r) {
      const t = await chrome.tabs.create({ windowId: winId, url: 'about:blank', active: true });
      r.own.add(t.id); r.tabId = t.id;
      return { tabs: await tabsList(), opened: ['tab-' + t.id] };
    },
  },
  list_tabs: { gate: { showing: false }, async dry() { return { ask: 'no' }; }, async run() { return { tabs: await tabsList() }; } },
  switch_tab: {
    gate: { showing: false },
    async dry(r, t, x) {
      const id = tabNum(x.tab_id), to = await tabIn(id), a = await activeTab();
      const mine = (r.own.has(id) || id === r.start) && (!a || a.id === r.tabId || a.id === id);
      return { ask: mine ? 'no' : 'always', title: clip(to.title, 200), url: clip(tabUrl(to), 2000), mine };
    },
    async run(r, t, x, ok) {
      const id = tabNum(x.tab_id), to = await tabIn(id);
      if (!ok.mine && !kindOf(tabUrl(to))) r.sites.add(originOf(tabUrl(to)));
      r.tabId = id;
      await chrome.tabs.update(id, { active: true });
      return { tabs: await tabsList() };
    },
  },
  close_tab: {
    gate: { showing: false },
    async dry(r, t, x) {
      const id = tabNum(x.tab_id), to = await tabIn(id);
      if ((await chrome.tabs.query({ windowId: winId })).length < 2) fail('pagebot doesn’t close the last tab in the window.');
      const mine = r.own.has(id);
      return { ask: mine ? 'no' : 'always', title: clip(to.title, 200), url: clip(tabUrl(to), 2000), mine };
    },
    async run(r, t, x) {
      const id = tabNum(x.tab_id);
      await tabIn(id);
      await chrome.tabs.remove(id);
      r.own.delete(id);
      if (id === r.tabId) { const a = await activeTab(); r.tabId = a && (r.own.has(a.id) || a.id === r.start) ? a.id : null; }
      await sleep(100);
      return { tabs: await tabsList() };
    },
  },
  read_console: {
    async dry() { return { ask: 'no' }; },
    async run(r, t) {
      const got = [], seen = new Set();
      const add = (ts, level, text, where) => { const k = ts + '|' + text; if (seen.has(k)) return; seen.add(k); got.push({ ts, line: `[${level}] ${text}${where ? ` (${where})` : ''}` }); };
      const on = (src, method, p) => {
        if (src.tabId !== t.id) return;
        if (method === 'Runtime.consoleAPICalled') { const f = p.stackTrace?.callFrames?.[0]; add(p.timestamp, p.type === 'warning' ? 'warn' : p.type, (p.args || []).map(a => a.value ?? a.description ?? a.type).join(' '), f && `${f.url}:${f.lineNumber + 1}`); }
        else if (method === 'Runtime.exceptionThrown') { const e = p.exceptionDetails || {}; add(p.timestamp, 'error', e.exception?.description || e.text, e.url && `${e.url}:${(e.lineNumber || 0) + 1}`); }
        else if (method === 'Log.entryAdded') { const e = p.entry || {}; add(e.timestamp, e.level === 'warning' ? 'warn' : e.level, e.text, e.url && `${e.url}:${(e.lineNumber || 0) + 1}`); }
      };
      chrome.debugger.onEvent.addListener(on);
      try { await dbg(r, t.id, async send => { await send('Runtime.enable'); await send('Log.enable'); await nap(r, 300); }); }
      finally { chrome.debugger.onEvent.removeListener(on); }
      const mark = consoleMark.get(t.id) || 0, fresh = got.filter(g => g.ts > mark).sort((a, b) => a.ts - b.ts);
      if (fresh.length) consoleMark.set(t.id, fresh.at(-1).ts);
      const out = lines(fresh.map(g => String(g.line).replace(/\s+/g, ' ')), 100);
      return { text: out.join('\n'), n: out.length };
    },
  },
  read_network: {
    async dry() { return { ask: 'no' }; },
    async run(r, t) { const n = await cs(t.id, { t: 'net' }); const out = lines(String(n?.text || '').split('\n').filter(Boolean), 200); return { text: out.join('\n'), n: out.length, more: n?.more || 0 }; },
  },
  // The approved code, run in the page's own world as the console would run it (top-level await works). A value that's a
  // promise is waited for, and one that fails comes back as the error. A script gets 10 seconds: one still busy then is
  // stopped by Chrome itself (the evaluate's own timeout, which holds even after the debugger is let go, so Stop needs
  // nothing more), and one still waiting for something isn't waited for any longer: the debugger is let go.
  javascript_exec: {
    async dry(r, t) { if (await filled(t)) fail(NO.filled); return { ask: 'always' }; },
    async run(r, t, x) {
      if (await filled(t)) fail(NO.filled);
      let out = null;
      const LATE = `The script didn’t finish within ${SCRIPT_MS / 1000} seconds, so pagebot stopped it.`;
      const blocked = await inputStep(r, t, new Set(), async send => {
        const left = Date.now() + SCRIPT_MS + 500;
        const due = p => Promise.race([p, nap(r, Math.max(0, left - Date.now())).then(() => fail(LATE))]);
        // (a script Chrome cut off at its timeout comes back as an internal error, not as the script's own)
        const cut = err => { if (/Internal error|-32603/.test(err?.message || '')) fail(LATE); throw err; };
        let res = await due(send('Runtime.evaluate', { expression: String(x.text), objectGroup: 'pagebot', returnByValue: false, awaitPromise: true, replMode: true, timeout: SCRIPT_MS, userGesture: false }).catch(cut));
        if (!res.exceptionDetails && res.result?.subtype === 'promise') res = await due(send('Runtime.awaitPromise', { promiseObjectId: res.result.objectId, returnByValue: false }));
        const e = res.exceptionDetails;
        if (e) { out = { threw: clip(e.exception?.description || e.text || 'An error', 5000) }; return; }
        out = { value: clip(await shown(send, res.result), 5000) };
      }, SCRIPT_MS + 5000);
      if (blocked) fail(NOT_APPROVED(blocked));
      return out;
    },
  },
};
MEMBERS.mouse_move = MEMBERS.hover;
const SCRIPT_MS = 10000;
// a script's value in words: text as it is, numbers and plain objects as JSON, anything else (an element, a function) as
// the console describes it
async function shown(send, v) {
  if (!v || v.type === 'undefined') return 'undefined';
  if ('value' in v) return typeof v.value === 'string' ? v.value : JSON.stringify(v.value);
  if (v.unserializableValue) return v.unserializableValue;
  if (v.objectId && v.type === 'object' && !['node', 'regexp', 'date', 'error', 'proxy', 'promise'].includes(v.subtype)) {
    try { const j = await send('Runtime.callFunctionOn', { objectId: v.objectId, functionDeclaration: 'function () { return this; }', returnByValue: true }); if (!j.exceptionDetails && 'value' in j.result) return JSON.stringify(j.result.value); } catch {}
  }
  return v.description || v.type;
}
const goes = c => !!c.main && (c.main.key === 'Enter' || c.main.key === ' ');
// Where Enter or Space sends the page from the focused element: a link's address, a button's or a field's form. With ctrl,
// cmd or shift held, a link opens in a new tab or window instead, which pagebot can't hold, so another site always asks.
function keyGo(r, t, list, f) {
  const hits = list.filter(goes);
  const go = hits.length ? f.nav || f.tab || '' : '';
  if (!go) return { go: '', tab: false, far: false };
  const tab = !!f.tab || f.role === 'link' && hits.some(c => c.mods & (2 | 4 | 8));
  return { go, tab, far: far(r, go), ...(sameSite(t, go) && { sameSite: true }) };
}
function keysOf(text) {
  const list = String(text || '').trim().split(/\s+/).filter(Boolean).slice(0, 50).map(chord);
  if (!list.length) fail('key needs a key name like "Enter".');
  if (list.some(PASTE)) fail(NO.paste);
  return list;
}
async function filled(t) { for (const { r } of await allFrames(t.id, { t: 'guard' })) if (r?.filled) return true; return false; }
function destKind(u) { // where navigate never goes
  let x; try { x = new URL(u); } catch { return 'That isn’t an address pagebot can open.'; }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return 'Navigation refused. Only http and https URLs are allowed.';
  if (x.username || x.password) return 'pagebot doesn’t open addresses with a user name or password in them.';
  const k = kindOf(x.href);
  return k === 'store' ? RESTRICT.store : k === 'pagebot' ? 'pagebot doesn’t open its own pages.' : '';
}

// ---- screenshots: the visible part of the tab, without a "share this tab" step ----
let shooting = Promise.resolve();
function capture() {
  const p = shooting.then(async () => {
    try { return await chrome.tabs.captureVisibleTab(winId, { format: 'jpeg', quality: 92 }); }
    catch (e) { if (!/MAX_CAPTURE|per second/i.test(e?.message || '')) throw e; await sleep(600); return chrome.tabs.captureVisibleTab(winId, { format: 'jpeg', quality: 92 }); }
  });
  shooting = p.catch(() => {});
  return p;
}

// ---- what the panel asks for ----
const HANDLERS = {
  hello: () => ({ v: EXT_V, tools: chrome.debugger ? TOOLS : TOOLS.filter(n => !NEEDS_DEBUGGER.has(n)) }),
  run(d) { if (typeof d.run !== 'string' || !d.run) return; if (d.on) runOn(d.run); else if (R && R.id === d.run) runOff(); },
  close() { runOff(); window.close(); },
  // the page's text for a question, and what's highlighted (nothing on pages pagebot doesn't read)
  async page(d) {
    const t = await activeTab(), k = t ? kindOf(tabUrl(t)) : 'browser';
    if (k) return { page: null, selection: '', restricted: k };
    try { return await cs(t.id, { t: 'page', max: Number(d.max) || 0 }); }
    catch { return { page: null, selection: '', restricted: /\.pdf$/i.test(tabUrl(t).split(/[?#]/)[0]) ? 'pdf' : 'browser' }; }
  },
  // a quote from the answer, found and highlighted on the page
  async find(d) {
    const t = await activeTab();
    if (!t || kindOf(tabUrl(t))) return { found: 0 };
    try { return await cs(t.id, { t: 'find', text: clip(d.text, 4000) }); } catch { return { found: 0 }; }
  },
  // the bookmark's click, fill and highlight (refs), behind the same checks
  async act(d) {
    const g = await gate(d); if (g.stop) return g.stop;
    const { r, t } = g, name = String(d.name || '');
    const m = { name, input: d.input && typeof d.input === 'object' ? d.input : {}, ...(d.dry && { dry: 1 }), ...(d.sure != null && { sure: d.sure }) };
    const leaves = !d.dry && d.sure != null && name === 'click'; // the dry run said it leaves the page or opens a tab, and where to
    const approved = !d.dry && typeof d.sure === 'string' ? approve(r, d.sure) : new Set();
    let res = null, blocked = '';
    // a click that goes somewhere runs with page loads held (when the debugger is there), so a same-site link that
    // redirects to a site nobody approved stops at the bounce
    if (leaves && canDebug(r)) blocked = await inputStep(r, t, approved, async () => { res = await cs(t.id, { t: 'act', d: m }); });
    else res = await cs(t.id, { t: 'act', d: m });
    if (name === 'hl' || name === 'els' || !res || res.no) return res;
    const go = res.nav || res.tab;
    // (without the debugger, a click that leaves the page can't be held to the approved sites, so the panel asks first)
    if (d.dry) return go ? { ...res, ...(far(r, go) && { far: true }), ...(!canDebug(r) && { unheld: true }) } : res;
    if (blocked) fail(NOT_APPROVED(blocked));
    return { ...res, ...(await settled(r, approved)) };
  },
  // the bookmark's reading tools: read_page, find, get_page_text, scroll_to, and view (the viewport's size)
  async tool(d) {
    const name = String(d.name || '');
    const g = await gate(d, { pdf: name === 'view' }); if (g.stop) return g.stop;
    try { return await cs(g.t.id, { t: 'tool', name, input: d.input && typeof d.input === 'object' ? d.input : {} }); }
    catch (e) { if (name === 'view') return { w: g.t.width, h: g.t.height, dpr: 1 }; throw e; }
  },
  // a screenshot: for a step (with run) behind the gate; from the + menu, of any page pagebot may look at
  // (a step's screenshot is taken with Chrome's debugging bar up, and the page's size then kept for points; see barUp)
  async shot(d) {
    if (d.run == null) {
      const t = await activeTab(), k = t ? kindOf(tabUrl(t)) : 'browser';
      if (k && k !== 'pdf' && k !== 'empty') return { error: 'pagebot can’t take screenshots of the browser’s own pages.' };
      return { image: await capture() };
    }
    const g = await gate(d, { pdf: true }); if (g.stop) return g.stop;
    const { r, t } = g;
    let image = null;
    if (canDebug(r) && !kindOf(tabUrl(t))) {
      try {
        await dbg(r, t.id, async send => {
          await barUp(r, send);
          image = await capture();
          r.shots.set(t.id, await view(send));
        });
      } catch (e) { if (r !== R || r.ctl.signal.aborted) throw e; r.shots.delete(t.id); }
    }
    return { image: image || await capture() };
  },
  // a member only the extension runs: dry tells the panel what it is and how to ask; the run needs the dry run's token
  async ext(d) {
    const name = String(d.name || ''), m = Object.hasOwn(MEMBERS, name) && MEMBERS[name];
    if (!m) return { error: `pagebot doesn’t know ${clip(name, 40)}.` };
    const x = d.input && typeof d.input === 'object' && !Array.isArray(d.input) ? d.input : {};
    const g = await gate({ ...d, tab: ['switch_tab', 'close_tab'].includes(name) ? null : x.tab_id ?? null }, (typeof m.gate === 'function' ? m.gate(x) : m.gate) || {});
    if (g.stop) return g.stop;
    const { r, t } = g, key = JSON.stringify([name, x]);
    if (d.dry) {
      const info = await m.dry(r, t, x, name);
      const sure = crypto.randomUUID();
      r.sures.set(sure, { key, info });
      return { ...Object.fromEntries(Object.entries(info).filter(([k]) => !k.startsWith('_'))), sure };
    }
    const ok = r.sures.get(d.sure);
    r.sures.delete(d.sure);
    if (!ok || ok.key !== key) return { no: 'changed' };
    return m.run(r, t, x, ok.info, name);
  },
};

// ---- the tab that's showing: the panel hears about it, and the helper goes in so highlights reach the panel ----
let lastTell = '';
async function tabChanged(t) {
  if (!t || t.windowId !== winId || !t.active) return;
  const url = tabUrl(t), k = kindOf(url), msg = { type: 'tab', url: k ? '' : url, title: k ? '' : clip(t.title, 300), restricted: k };
  const s = JSON.stringify(msg);
  if (s !== lastTell) { lastTell = s; toWidget(msg); }
  if (!k && t.status === 'complete') ensure(t.id).catch(() => {});
}
bound.then(async () => {
  frame.src = ORIGIN + '/widget?host=ext&ext=' + EXT_V;
  chrome.tabs.onActivated.addListener(i => { if (i.windowId === winId) chrome.tabs.get(i.tabId).then(tabChanged, () => {}); });
  chrome.tabs.onUpdated.addListener((id, ch, t) => { if (ch.url || ch.title || ch.status === 'complete') tabChanged(t); });
  chrome.tabs.onCreated.addListener(t => { if (R && t.windowId === winId && t.openerTabId != null && t.openerTabId === R.tabId) R.created.add(t.id); });
  chrome.runtime.onMessage.addListener((m, sender) => {
    // highlights from the helper in the tab that's showing in this window (its top frame) and nowhere else
    if (sender.id !== chrome.runtime.id || !sender.tab || sender.tab.windowId !== winId || !sender.tab.active || sender.frameId !== 0) return;
    if (m && m.t === 'sel') toWidget({ type: 'sel', text: clip(m.text, 8000) });
  });
  frame.addEventListener('load', () => { lastTell = ''; activeTab().then(tabChanged, () => {}); });
});
addEventListener('pagehide', runOff);

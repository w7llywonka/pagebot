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
// R: { id, tabId: the tab pagebot works on, start, own: tabs it opened, sites: origins it may work on, held, ctl, sures }
let R = null;
function runOn(id) {
  runOff();
  const r = R = { id, tabId: null, start: null, own: new Set(), sites: new Set(), created: new Set(), held: { mouse: false, keys: [], tab: null, x: 0, y: 0 },
    ctl: new AbortController(), noDebug: false, sures: new Map() };
  r.ready = activeTab().then(t => {
    if (!t) return;
    r.tabId = r.start = t.id;
    if (!kindOf(tabUrl(t))) r.sites.add(originOf(tabUrl(t)));
  }).catch(() => {});
}
function runOff() {
  const r = R;
  if (!r) return;
  R = null;
  r.ctl.abort(); // the step in flight stops at its next debugger command; its own clean-up releases what it holds
  releaseHeld(r);
}
const stopped = () => new Error('Stopped.');
const nap = (r, ms) => new Promise((ok, no) => {
  if (r.ctl.signal.aborted) return no(stopped());
  const t = setTimeout(ok, ms);
  r.ctl.signal.addEventListener('abort', () => { clearTimeout(t); no(stopped()); }, { once: true });
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

// ---- chrome.debugger, attached only for the step that needs it ----
const attached = new Set();
const NO_DEBUG = 'The user stopped pagebot from Chrome’s bar, so it can’t type or click at a point in this answer. Use refs with left_click and form_input instead.';
chrome.debugger?.onDetach.addListener((src, reason) => {
  if (src.tabId == null) return;
  attached.delete(src.tabId);
  if (reason === 'canceled_by_user' && R) R.noDebug = true;
});
async function dbg(r, tabId, fn) {
  if (!chrome.debugger) fail('Typing and clicking at a point aren’t available in this browser.');
  if (r.noDebug) fail(NO_DEBUG);
  if (r !== R || r.ctl.signal.aborted) throw stopped();
  const target = { tabId };
  try { await chrome.debugger.attach(target, '1.3'); }
  catch (e) {
    if (!(/already attached/i.test(e?.message || '') && attached.has(tabId))) fail('Typing and clicking at a point aren’t available on this page right now.');
    await chrome.debugger.detach(target).catch(() => {}); // our own leftover
    await chrome.debugger.attach(target, '1.3').catch(() => fail('Typing and clicking at a point aren’t available on this page right now.'));
  }
  attached.add(tabId); toWorker({ t: 'dbg', tabId, on: true });
  const raw = (method, params) => chrome.debugger.sendCommand(target, method, params);
  const send = async (method, params) => {
    if (r !== R || r.ctl.signal.aborted) throw stopped();
    if (r.noDebug) fail(NO_DEBUG);
    return raw(method, params);
  };
  send.raw = raw;
  try { return await fn(send); }
  finally {
    await chrome.debugger.detach(target).catch(() => {});
    attached.delete(tabId); toWorker({ t: 'dbg', tabId, on: false });
  }
}
// While a pointer or key step runs, a page load the step starts toward a site nobody approved is held and refused.
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
  try { await send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }); }
  catch (e) { chrome.debugger.onEvent.removeListener(on); throw e; }
  return { st, off: () => chrome.debugger.onEvent.removeListener(on) };
}
// a step with input: attached, holding page loads, and staying attached half a second after the last input so a load
// the input starts is still held
async function inputStep(r, t, approved, fn) {
  let blocked = '';
  await dbg(r, t.id, async send => {
    const h = await holdNav(r, t.id, send, approved);
    try { await fn(send); await nap(r, 500); } finally { h.off(); blocked = h.st.blocked; }
  });
  return blocked;
}
const mouse = (send, type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });

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
// let go of a button or keys a step left held (Stop, or the end of the answer)
async function releaseHeld(r) {
  const h = r.held;
  if (!h.mouse && !h.keys.length || h.tab == null || !chrome.debugger) return;
  const target = { tabId: h.tab }, mine = !attached.has(h.tab);
  if (mine) { try { await chrome.debugger.attach(target, '1.3'); } catch { return; } }
  try {
    if (h.mouse) await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: h.x, y: h.y, button: 'left', clickCount: 1 });
    for (const c of h.keys) await keyUp(chrome.debugger.sendCommand.bind(null, target), c);
  } catch {}
  h.mouse = false; h.keys = [];
  toWorker({ t: 'held', tabId: h.tab, keys: [], mouse: false });
  if (mine) await chrome.debugger.detach(target).catch(() => {});
}

// ---- words for refusals (the model reads these) ----
const NO = {
  gone: 'That ref isn’t on the page anymore. Use read_page or find again.',
  file: 'pagebot never opens file pickers. Ask the user to choose the file themselves.',
  password: 'pagebot never reads or types into password fields. Ask the user to fill it in themselves.',
  payment: 'pagebot never reads or types into payment card fields. Ask the user to fill it in themselves.',
  frame: 'The keyboard is in a part of the page from another site that pagebot can’t check, so it didn’t type there. Click the field first, or ask the user.',
  nofocus: 'Nothing on the page is ready for typing. Click the field first (left_click), then type.',
  paste: 'pagebot never pastes from the clipboard: that would hand the user’s clipboard to the page. Type the text instead.',
  filled: 'Something is typed into a password or card field on this page, so pagebot won’t run a script here. Ask the user, or do it another way.',
};
const refuse = f => fail(f.no === 'covered' ? `Something else is on top of that element${f.by ? ` (“${clip(f.by, 60)}”)` : ''}, so a click there wouldn’t reach it. Close it or scroll first.`
  : NO[f.no] || NO.gone);
// where a target is: a ref's centre (if a click there would land on it) or a point, with what's there
async function where(t, target) {
  if (target?.type === 'ref') { const c = await cs(t.id, { t: 'center', ref: target.ref }); if (c?.no) refuse(c); return c; }
  if (target?.type === 'coordinate' && Number.isFinite(target.x) && Number.isFinite(target.y)) {
    let p = { role: 'generic', label: '', nav: '' };
    try { p = await cs(t.id, { t: 'point', x: target.x, y: target.y }); } catch {}
    return { ...p, x: target.x, y: target.y };
  }
  fail('target must be a ref or a point.');
}
// what has the keyboard; in a frame from another site, that frame is asked itself (a protected field in any frame refuses)
async function focusOf(t) {
  const f = await cs(t.id, { t: 'focus' });
  if (f?.frame !== 'cross') return f;
  let best = null;
  for (const { frameId, r } of await allFrames(t.id, { t: 'focus' })) {
    if (frameId === 0 || !r) continue;
    if (r.no) return r;
    if (!r.none && r.frame !== 'cross' && (!best || r.hasFocus && !best.hasFocus)) best = { ...r, frameId };
  }
  return best || { no: 'frame' };
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
// console and network lines: no tokens, keys or query strings
function redact(s) {
  return String(s).replace(/\bhttps?:\/\/[^\s"'<>)]+/g, u => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u.split(/[?#]/)[0]; } })
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[hidden]')
    .replace(/\b(authorization|bearer|token|api[_-]?key|secret|password|session|cookie)(\s*[:=]\s*)\S+/gi, '$1: [hidden]')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[hidden]');
}
const lines = (list, max) => { let n = 0; const out = []; for (const l of list.slice(0, max)) { const x = clip(redact(l), 300); if (n + x.length > 20000) break; out.push(x); n += x.length + 1; } return out; };
const consoleMark = new Map(); // tab → the newest console entry read so far

// ---- the toolset members only the extension runs (and the pointer and scroll members it runs for real) ----
// dry(r, t, input) returns what the panel shows and how it asks: ask 'no', 'setting' (asks unless the person said not to)
// or 'always'. run(r, t, input, approved) does it. A run must carry the token its dry run handed out, for the same input.
const CLICK = { left_click: ['left', 1], right_click: ['right', 1], middle_click: ['middle', 1], double_click: ['left', 2], triple_click: ['left', 3] };
const modsOf = s => s ? chord(String(s).replace(/\+?$/, '+a')).mods : 0;
function clickFacts(r, name, f, modifiers) {
  // a middle click, or a click with ctrl, cmd or shift, opens a link in a new tab instead
  const newTab = name === 'middle_click' || name === 'left_click' && modsOf(modifiers) & (2 | 4 | 8);
  const go = name === 'right_click' ? '' : f.nav || f.tab || '';
  const away = !!go && far(r, go);
  return { role: f.role, label: f.label, at: [f.x, f.y], go, tab: !!f.tab || newTab && !!go, far: away, ask: away ? 'always' : 'setting' };
}
const pointMember = {
  gate: {},
  async dry(r, t, x, name) {
    const f = await where(t, x.target);
    if (f.no) refuse(f);
    return clickFacts(r, name, f, x.modifiers);
  },
  async run(r, t, x, ok, name) {
    const f = await where(t, x.target);
    if (f.no) refuse(f);
    const now = clickFacts(r, name, f, x.modifiers);
    if (now.go !== ok.go) return { no: 'changed' };
    const approved = new Set(ok.go && originOf(ok.go) ? [originOf(ok.go)] : []);
    for (const o of approved) r.sites.add(o);
    const [button, count] = CLICK[name], modifiers = modsOf(x.modifiers);
    const blocked = await inputStep(r, t, approved, async send => {
      await mouse(send, 'mouseMoved', f.x, f.y, { modifiers });
      for (let i = 1; i <= count; i++) {
        await mouse(send, 'mousePressed', f.x, f.y, { button, clickCount: i, modifiers });
        await mouse(send, 'mouseReleased', f.x, f.y, { button, clickCount: i, modifiers });
      }
    });
    if (blocked) fail(NOT_APPROVED(blocked));
    const s = await settle(r, { closeFar: approved });
    if (s.blocked) fail(NOT_APPROVED(s.blocked));
    return { role: f.role, label: f.label, ...(now.go && (now.tab ? { tab: now.go } : { nav: now.go })), ...s };
  },
};
const MEMBERS = {
  left_click: pointMember, right_click: pointMember, middle_click: pointMember, double_click: pointMember, triple_click: pointMember,
  hover: {
    async dry() { return { ask: 'no' }; },
    async run(r, t, x) {
      const f = await where(t, x.target);
      await dbg(r, t.id, send => mouse(send, 'mouseMoved', f.x, f.y, r.held.mouse ? { button: 'left', buttons: 1 } : {}));
      return { role: f.role, label: f.label };
    },
  },
  left_click_drag: {
    async dry(r, t, x) {
      const a = await where(t, x.from), b = await where(t, x.target);
      if (a.no) refuse(a);
      return { ask: 'setting', from: { role: a.role, label: a.label }, to: { role: b.role, label: b.label } };
    },
    async run(r, t, x) {
      const a = await where(t, x.from), b = await where(t, x.target);
      const blocked = await inputStep(r, t, new Set(), async send => {
        await mouse(send, 'mouseMoved', a.x, a.y);
        await mouse(send, 'mousePressed', a.x, a.y, { button: 'left', clickCount: 1 });
        for (let i = 1; i <= 10; i++) { await mouse(send, 'mouseMoved', a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10, { button: 'left', buttons: 1 }); await sleep(16); }
        await mouse(send, 'mouseReleased', b.x, b.y, { button: 'left', clickCount: 1 });
      });
      if (blocked) fail(NOT_APPROVED(blocked));
      return { ...(await settle(r)) };
    },
  },
  left_mouse_down: {
    async dry(r, t, x) { const f = await where(t, x.target); if (f.no) refuse(f); return { ask: 'setting', role: f.role, label: f.label }; },
    async run(r, t, x) {
      const f = await where(t, x.target);
      await dbg(r, t.id, async send => { await mouse(send, 'mouseMoved', f.x, f.y); await mouse(send, 'mousePressed', f.x, f.y, { button: 'left', clickCount: 1 }); });
      Object.assign(r.held, { mouse: true, tab: t.id, x: f.x, y: f.y });
      toWorker({ t: 'held', tabId: t.id, keys: [], mouse: true, x: f.x, y: f.y });
      return { role: f.role, label: f.label };
    },
  },
  left_mouse_up: {
    async dry(r, t, x) { const f = await where(t, x.target); return { ask: 'setting', role: f.role, label: f.label, go: f.nav || f.tab || '', far: !!(f.nav || f.tab) && far(r, f.nav || f.tab) }; },
    async run(r, t, x) {
      const f = await where(t, x.target);
      const blocked = await inputStep(r, t, new Set(), async send => { await mouse(send, 'mouseMoved', f.x, f.y, { button: 'left', buttons: 1 }); await mouse(send, 'mouseReleased', f.x, f.y, { button: 'left', clickCount: 1 }); });
      r.held.mouse = false; toWorker({ t: 'held', tabId: t.id, keys: [], mouse: false });
      if (blocked) fail(NOT_APPROVED(blocked));
      return { role: f.role, label: f.label, ...(await settle(r)) };
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
  type: {
    async dry(r, t, x) { const f = await focusOf(t); if (f.no) refuse(f); if (f.none || !f.edit) fail(NO.nofocus); return { ask: 'setting', role: f.role, label: f.label }; },
    async run(r, t, x) {
      const f = await focusOf(t);
      if (f.no) refuse(f);
      if (f.none || !f.edit) fail(NO.nofocus);
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
      const go = list.some(c => c.main && (c.main.key === 'Enter' || c.main.key === ' ') && !(c.mods & 7)) ? f.nav || f.tab || '' : '';
      const away = !!go && far(r, go);
      return { ask: away ? 'always' : 'setting', role: f.role, label: f.label, go, tab: !!f.tab, far: away };
    },
    async run(r, t, x, ok) {
      const list = keysOf(x.text), f = await focusOf(t);
      if (f.no) refuse(f);
      const approved = new Set(ok.go && originOf(ok.go) ? [originOf(ok.go)] : []);
      for (const o of approved) r.sites.add(o);
      const times = Math.min(Math.max(x.repeat | 0 || 1, 1), 100);
      let moved = false;
      const blocked = await inputStep(r, t, approved, async send => {
        for (let n = 0; n < times; n++) for (const c of list) {
          if (printable(c) && moved) { // focus may have moved (Tab, a click): check again before typing a character
            const g = await focusOf(t); if (g.no) refuse(g); moved = false;
          }
          await keyDown(send, c); await keyUp(send, c);
          if (!printable(c)) moved = true;
        }
      });
      if (blocked) fail(NOT_APPROVED(blocked));
      const s = await settle(r, { closeFar: approved });
      if (s.blocked) fail(NOT_APPROVED(s.blocked));
      return { role: f.role, label: f.label, ...(ok.go && (ok.tab ? { tab: ok.go } : { nav: ok.go })), ...s };
    },
  },
  hold_key: {
    async dry(r, t, x) { if (PASTE(chord(String(x.text)))) fail(NO.paste); const f = await focusOf(t); if (f.no) refuse(f); return { ask: 'setting', role: f.role, label: f.label }; },
    async run(r, t, x) {
      const c = chord(String(x.text));
      if (PASTE(c)) fail(NO.paste);
      const f = await focusOf(t);
      if (f.no) refuse(f);
      const ms = Math.min(Math.max(Number(x.duration) || 0, 0), 30) * 1000;
      await dbg(r, t.id, async send => {
        r.held.keys = [c]; r.held.tab = t.id; toWorker({ t: 'held', tabId: t.id, keys: [x.text], mouse: r.held.mouse });
        try {
          await keyDown(send, c);
          const end = Date.now() + ms;
          while (Date.now() < end) { await nap(r, Math.min(100, end - Date.now())); if (c.main && Date.now() < end) await keyDown(send, c, true); }
        } finally {
          await keyUp(send.raw, c).catch(() => {}); // always let go, Stop included
          r.held.keys = []; toWorker({ t: 'held', tabId: t.id, keys: [], mouse: r.held.mouse });
        }
      });
      return {};
    },
  },
  navigate: {
    gate: { page: false, site: false },
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
      return { ask: away ? 'always' : 'setting', how: 'url', dest: u, far: away };
    },
    async run(r, t, x, ok) {
      const u = String(x.url || '');
      if (ok.dest && originOf(ok.dest)) r.sites.add(originOf(ok.dest));
      if (u === 'reload') await chrome.tabs.reload(t.id);
      else if (u === 'back' || u === 'forward') {
        await dbg(r, t.id, async send => {
          const h = await send('Page.getNavigationHistory'), e = h.entries[h.currentIndex + (u === 'back' ? -1 : 1)];
          if (!e || clip(e.url, 2000) !== ok.dest) fail('The tab’s history changed after the user approved it.');
          await send('Page.navigateToHistoryEntry', { entryId: e.id });
          await nap(r, 300);
        });
      } else {
        if (destKind(u)) fail(destKind(u));
        await chrome.tabs.update(t.id, { url: u });
      }
      await sleep(200);
      const done = await loaded(r, t.id, MS_LOAD);
      const now = done || await chrome.tabs.get(t.id).catch(() => null);
      return { url: now ? tabUrl(now) : '', title: now?.title || '', ...(!done && { loading: true }), tabs: await tabsList() };
    },
  },
  new_tab: {
    gate: { showing: false },
    async dry() { return { ask: 'no' }; },
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
  javascript_exec: {
    async dry(r, t) { if (await filled(t)) fail(NO.filled); return { ask: 'always' }; },
    async run(r, t, x) {
      if (await filled(t)) fail(NO.filled);
      let res;
      const blocked = await inputStep(r, t, new Set(), async send => {
        res = await send('Runtime.evaluate', { expression: String(x.text), returnByValue: true, awaitPromise: true, timeout: 10000, userGesture: false, replMode: true });
      });
      if (blocked) fail(NOT_APPROVED(blocked));
      if (res?.exceptionDetails) return { threw: clip(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'An error', 5000) };
      const v = res?.result;
      let value;
      if (!v || v.type === 'undefined') value = 'undefined';
      else if ('value' in v) value = typeof v.value === 'string' ? v.value : JSON.stringify(v.value);
      else value = v.description || v.type;
      return { value: clip(value, 5000) };
    },
  },
};
MEMBERS.mouse_move = MEMBERS.hover;
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
    const res = await cs(t.id, { t: 'act', d: m });
    if (name === 'hl' || name === 'els' || !res || res.no) return res;
    const go = res.nav || res.tab;
    if (d.dry) return go && far(r, go) ? { ...res, far: true } : res;
    if (typeof d.sure === 'string' && originOf(d.sure)) r.sites.add(originOf(d.sure)); // the person approved going there
    return { ...res, ...(await settle(r)) };
  },
  // the bookmark's reading tools: read_page, find, get_page_text, scroll_to, and view (the viewport's size)
  async tool(d) {
    const name = String(d.name || '');
    const g = await gate(d, { pdf: name === 'view' }); if (g.stop) return g.stop;
    try { return await cs(g.t.id, { t: 'tool', name, input: d.input && typeof d.input === 'object' ? d.input : {} }); }
    catch (e) { if (name === 'view') return { w: g.t.width, h: g.t.height, dpr: 1 }; throw e; }
  },
  // a screenshot: for a step (with run) behind the gate; from the + menu, of any page pagebot may look at
  async shot(d) {
    if (d.run != null) { const g = await gate(d, { pdf: true }); if (g.stop) return g.stop; }
    else { const t = await activeTab(), k = t ? kindOf(tabUrl(t)) : 'browser'; if (k && k !== 'pdf' && k !== 'empty') return { error: 'pagebot can’t take screenshots of the browser’s own pages.' }; }
    return { image: await capture() };
  },
  // a member only the extension runs: dry tells the panel what it is and how to ask; the run needs the dry run's token
  async ext(d) {
    const name = String(d.name || ''), m = Object.hasOwn(MEMBERS, name) && MEMBERS[name];
    if (!m) return { error: `pagebot doesn’t know ${clip(name, 40)}.` };
    const x = d.input && typeof d.input === 'object' && !Array.isArray(d.input) ? d.input : {};
    const g = await gate({ ...d, tab: ['switch_tab', 'close_tab'].includes(name) ? null : x.tab_id ?? null }, m.gate || {});
    if (g.stop) return g.stop;
    const { r, t } = g, key = JSON.stringify([name, x]);
    if (d.dry) {
      const info = await m.dry(r, t, x, name);
      const sure = crypto.randomUUID();
      r.sures.set(sure, { key, info });
      return { ...info, sure };
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

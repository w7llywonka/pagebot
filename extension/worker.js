// pagebot extension's service worker. It does two small things: the toolbar button (and Alt+Shift+P) opens pagebot in the
// side panel, and when a side panel closes in the middle of a step, it lets go of any key or mouse button that step held
// and detaches the debugger, so nothing is left attached to a tab. It never listens to web pages or other extensions.
'use strict';
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
// a browser without the side panel: the same page in a small window that works on the window it was opened from
if (!chrome.sidePanel) chrome.action.onClicked.addListener(tab => { chrome.windows.create({ url: 'sidepanel.html?win=' + tab.windowId, type: 'popup', width: 440, height: 760 }); });

const PANEL = chrome.runtime.getURL('sidepanel.html');
// what each open panel has attached or held: tab → { keys, mouse, x, y }, also kept in session storage for a worker that restarts
const panels = new Map(); // port → Map(tabId → state)
async function save() {
  const all = {};
  for (const tabs of panels.values()) for (const [id, s] of tabs) all[id] = s;
  await chrome.storage.session.set({ dbg: all }).catch(() => {});
}
const KEY = { Shift: ['ShiftLeft', 16], Control: ['ControlLeft', 17], Alt: ['AltLeft', 18], Meta: ['MetaLeft', 91] };
async function cleanUp(tabId, s) {
  const target = { tabId };
  try { await chrome.debugger.attach(target, '1.3'); } catch (e) { if (!/already attached/i.test(e?.message || '')) return; } // gone, or still ours from the step
  const send = (m, p) => chrome.debugger.sendCommand(target, m, p).catch(() => {});
  if (s.mouse) await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.x || 0, y: s.y || 0, button: 'left', clickCount: 1 });
  for (const k of s.keys || []) for (const part of String(k).split('+').reverse()) {
    const name = { ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt', option: 'Alt', meta: 'Meta', cmd: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta' }[part.toLowerCase()];
    if (name) await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: KEY[name][0], windowsVirtualKeyCode: KEY[name][1] });
    else await send('Input.dispatchKeyEvent', { type: 'keyUp', key: part.length === 1 ? part : part[0].toUpperCase() + part.slice(1) });
  }
  await chrome.debugger.detach(target).catch(() => {});
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'panel' || port.sender?.id !== chrome.runtime.id || !String(port.sender?.url || '').startsWith(PANEL)) return port.disconnect();
  const tabs = new Map();
  panels.set(port, tabs);
  port.onMessage.addListener(m => {
    if (!m || typeof m !== 'object' || !Number.isInteger(m.tabId)) return;
    const s = tabs.get(m.tabId) || { dbg: false, keys: [], mouse: false };
    if (m.t === 'dbg') s.dbg = !!m.on;
    else if (m.t === 'held') Object.assign(s, { keys: Array.isArray(m.keys) ? m.keys.slice(0, 4).map(String) : [], mouse: !!m.mouse, x: Number(m.x) || s.x || 0, y: Number(m.y) || s.y || 0 });
    else return;
    if (s.dbg || s.mouse || s.keys.length) tabs.set(m.tabId, s); else tabs.delete(m.tabId);
    save();
  });
  port.onDisconnect.addListener(async () => {
    panels.delete(port);
    await save();
    for (const [tabId, s] of tabs) await cleanUp(tabId, s);
  });
});
// A worker that starts with a record but no open panel: that panel went away while this worker was asleep. Only tabs it
// recorded are touched, so a debugger someone else attached (DevTools) is left alone.
chrome.storage.session.get('dbg').then(async ({ dbg = {} }) => {
  const ids = Object.keys(dbg);
  if (!ids.length) return;
  const open = chrome.runtime.getContexts ? (await chrome.runtime.getContexts({})).some(c => String(c.documentUrl || '').startsWith(PANEL)) : true;
  if (open) return;
  for (const id of ids) await cleanUp(Number(id), dbg[id]);
  await chrome.storage.session.set({ dbg: {} });
}).catch(() => {});

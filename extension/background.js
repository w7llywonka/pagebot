/* Pagebot's local extension broker. The remote chat never gets access to arbitrary extension APIs. */
importScripts('config.js');

const MESSAGE_SCOPE = 'pagebot-extension';
const PANEL_URL = new URL(chrome.runtime.getURL('panel.html'));
const TOOLS = new Set(['view', 'read_page', 'find', 'get_page_text', 'scroll', 'scroll_to', 'hover', 'mouse_move']);
const ACTIONS = new Set(['els', 'hl', 'scroll', 'click', 'fill', 'select', 'check']);
const PAGE_MESSAGE = 'Click the Pagebot toolbar button on this page to connect it again.';
const TAB_MESSAGE = 'The active tab changed. Return to the connected tab, or click Pagebot on the page you want to use.';

function panelTab(message, sender) {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string') throw new Error('Untrusted extension sender.');
  const source = new URL(sender.url);
  if (source.protocol !== PANEL_URL.protocol || source.host !== PANEL_URL.host || source.pathname !== PANEL_URL.pathname || source.searchParams.getAll('tab').length !== 1) throw new Error('Only the Pagebot side panel can use page tools.');
  const raw = source.searchParams.get('tab'), tabId = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(tabId) || tabId < 0 || message.tabId !== tabId) throw new Error('The page does not match this panel.');
  return tabId;
}
async function activeTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const active = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  if (!active.some(candidate => candidate.id === tabId && candidate.windowId === tab.windowId)) throw new Error(TAB_MESSAGE);
  if (!/^https?:\/\//i.test(tab.url || '')) throw new Error(tab.url ? 'This browser page does not allow extensions to read or capture it. Open a normal website to use page tools.' : PAGE_MESSAGE);
  return tab;
}
async function execute(tabId, operation, payload = {}) {
  const before = await activeTab(tabId);
  await chrome.scripting.executeScript({target: {tabId}, files: ['page-tools.js'], world: 'ISOLATED'});
  const connected = await activeTab(tabId);
  if (connected.url !== before.url) throw new Error('This page navigated before the operation could run. Ask again on the new page.');
  const result = await chrome.scripting.executeScript({
    target: {tabId}, world: 'ISOLATED',
    func: (op, value) => {
      if (document.visibilityState === 'hidden') throw new Error('Return to the connected tab before using page tools.');
      const helper = globalThis.__pagebotExtensionTools;
      if (!helper) throw new Error('Page tools could not be loaded. Click Pagebot to reconnect.');
      if (op === 'page') {
        const max = Math.min(400000, Math.max(1, Number(value.max) || 20000));
        return {page: {url: location.href, title: document.title, text: max <= 1 ? '' : helper.text().slice(0, max)}, selection: String(window.getSelection() || '').trim().slice(0, 8000)};
      }
      if (op === 'tool') return helper.tool(value.name, value.input || {});
      if (op === 'find') return {found: !!helper.find(String(value.text || '').slice(0, 4000))};
      if (op === 'act') return helper.act({name: value.name, input: value.input || {}, dry: value.dry ? 1 : 0, sure: value.sure});
      throw new Error('Unknown page operation.');
    },
    args: [operation, payload],
  });
  const after = await activeTab(tabId);
  if (after.url !== before.url && operation !== 'act') throw new Error('This page navigated while Pagebot was reading it. Ask again on the new page.');
  const value = result.find(item => item.frameId === 0)?.result;
  if (value == null) throw new Error('The page did not return a result.');
  return value;
}
// Native screenshots have a browser quota of two captures per second. Keep the queue short,
// and check the tab only after the wait so a stale request cannot capture another page.
let captureQueue = Promise.resolve(), captureAt = 0, pendingCaptures = 0;
function capture(tabId) {
  if (pendingCaptures >= 3) return Promise.reject(new Error('A screenshot is already in progress. Try again in a moment.'));
  pendingCaptures++;
  const result = captureQueue.then(async () => {
    const wait = Math.max(0, captureAt + 550 - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const before = await activeTab(tabId);
    captureAt = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(before.windowId, {format: 'jpeg', quality: 85});
    const after = await activeTab(tabId);
    if (after.url !== before.url) throw new Error('This page changed during the screenshot. Try again.');
    if (!/^data:image\/jpeg;base64,/.test(dataUrl || '')) throw new Error('The browser could not capture this page.');
    return {dataUrl};
  });
  captureQueue = result.catch(() => {});
  return result.finally(() => { pendingCaptures--; });
}
async function dispatch(message, sender) {
  const tabId = panelTab(message, sender);
  const payload = message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload) ? message.payload : {};
  if (JSON.stringify(payload).length > 60000) throw new Error('That page request is too large.');
  switch (message.type) {
    case 'status': {
      const tab = await activeTab(tabId);
      return {tab: {id: tab.id, url: tab.url, title: tab.title || new URL(tab.url).hostname}};
    }
    case 'page': return execute(tabId, 'page', {max: payload.max});
    case 'tool':
      if (!TOOLS.has(payload.name)) throw new Error('That page tool is not available.');
      return execute(tabId, 'tool', {name: payload.name, input: payload.input});
    case 'find': return execute(tabId, 'find', {text: payload.text});
    case 'act':
      if (!ACTIONS.has(payload.name)) throw new Error('That page action is not available.');
      return execute(tabId, 'act', {name: payload.name, input: payload.input, dry: payload.dry, sure: payload.sure});
    case 'capture': return capture(tabId);
    case 'selection': {
      const key = `pagebot-selection-${tabId}`, stored = await chrome.storage.session.get(key);
      await chrome.storage.session.remove(key);
      const selection = stored[key];
      return {selection: selection && Date.now() - selection.at < 120000 ? String(selection.text).slice(0, 8000) : ''};
    }
    default: throw new Error('That extension operation is not available.');
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || message.scope !== MESSAGE_SCOPE) return false;
  dispatch(message, sender).then(reply, error => {
    const details = String(error?.message || 'Pagebot could not access this page.');
    const store = /extensions gallery|chrome web store|chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons/i.test(details);
    const permission = /Cannot access|Missing host permission|cannot be scripted|permission to access/i.test(details);
    reply({error: store ? 'The browser extension store blocks page tools. Use a normal website for page context.' : permission ? PAGE_MESSAGE : details.slice(0, 350)});
  });
  return true;
});

// Issue both browser API calls inside the gesture callback. Awaiting storage first loses the user gesture.
function openPanel(tab, selection) {
  if (!Number.isSafeInteger(tab?.id)) return;
  if (selection) chrome.storage.session.set({[`pagebot-selection-${tab.id}`]: {text: String(selection).slice(0, 8000), at: Date.now()}}).catch(() => {});
  const configured = chrome.sidePanel.setOptions({tabId: tab.id, path: `panel.html?tab=${tab.id}`, enabled: true});
  const opened = chrome.sidePanel.open({tabId: tab.id});
  Promise.all([configured, opened]).catch(error => console.warn('Pagebot side panel:', error?.message));
}
chrome.action.onClicked.addListener(tab => openPanel(tab));
chrome.commands.onCommand.addListener((name, tab) => {
  if (name !== 'open-pagebot') return;
  if (tab) openPanel(tab);
  else chrome.tabs.query({active: true, currentWindow: true}).then(tabs => openPanel(tabs[0]));
});
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === 'ask-pagebot') openPanel(tab, info.selectionText); });
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({id: 'ask-pagebot', title: 'Ask Pagebot', contexts: ['selection'], documentUrlPatterns: ['http://*/*', 'https://*/*']}, () => { if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError.message); });
  }).catch(error => console.warn('Pagebot menu:', error?.message));
});
chrome.tabs.onRemoved.addListener(tabId => { chrome.storage.session.remove(`pagebot-selection-${tabId}`).catch(() => {}); });

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const panelSource = await readFile(new URL('../extension/panel.js', import.meta.url), 'utf8');
const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ORIGIN = `chrome-extension://${ID}`;
const event = () => ({listeners: [], addListener(fn) { this.listeners.push(fn); }});
const trusted = () => ({id: ID, url: `${ORIGIN}/panel.html?tab=7`});
const TAB = {id: 7, windowId: 9, url: 'https://article.test/story', title: 'Article'};

function worker({tab = TAB, active = [TAB], result = {ok: true}, queries, screenshot = 'data:image/jpeg;base64,AQID'} = {}) {
  const calls = [], stored = {};
  const chrome = {
    runtime: {id: ID, getURL: p => `${ORIGIN}/${p}`, onMessage: event(), onInstalled: event()},
    tabs: {
      get: async id => { calls.push(['get', id]); return {...tab}; },
      query: async query => { calls.push(['query', query]); return queries?.length ? queries.shift() : active; },
      captureVisibleTab: async (...args) => { calls.push(['capture', ...args]); return screenshot; },
      onRemoved: event(),
    },
    scripting: {executeScript: async options => {
      calls.push(['script', options]);
      return options.files ? [] : [{frameId: 0, result}];
    }},
    sidePanel: {
      setOptions: async options => calls.push(['options', options]),
      open: async options => calls.push(['open', options]),
    },
    action: {onClicked: event()}, commands: {onCommand: event()},
    contextMenus: {onClicked: event(), removeAll: async () => calls.push(['clear-menu']), create: (value, cb) => { calls.push(['menu', value]); cb?.(); }},
    storage: {session: {set: async value => Object.assign(stored, value), get: async key => ({[key]: stored[key]}), remove: async key => { delete stored[key]; }}},
  };
  vm.runInNewContext(source, {chrome, importScripts() {}, URL, console, Date, Set, JSON, Number, String, Error, Promise, setTimeout}, {filename: 'extension/background.js'});
  const send = (type, payload = {}, sender = trusted(), tabId = 7) => new Promise(resolve => {
    const keep = chrome.runtime.onMessage.listeners[0]({scope: 'pagebot-extension', type, tabId, payload}, sender, resolve);
    if (!keep) resolve(null);
  });
  return {chrome, calls, stored, send};
}

for (const [name, sender, tabId] of [
  ['a web page', {id: ID, url: 'https://article.test/panel.html?tab=7'}, 7],
  ['another extension', {id: 'other', url: `${ORIGIN}/panel.html?tab=7`}, 7],
  ['a forged extension host', {id: ID, url: 'chrome-extension://other/panel.html?tab=7'}, 7],
  ['a content script', {id: ID, url: 'https://article.test/story', tab: TAB}, 7],
  ['another local page', {id: ID, url: `${ORIGIN}/options.html?tab=7`}, 7],
  ['a different tab', trusted(), 8],
  ['duplicate tab bindings', {id: ID, url: `${ORIGIN}/panel.html?tab=7&tab=8`}, 7],
]) test(`the broker rejects ${name} before touching a tab`, async () => {
  const f = worker();
  assert.ok((await f.send('page', {}, sender, tabId)).error);
  assert.equal(f.calls.length, 0);
});

test('only fixed page tools and actions are forwarded into the isolated page helper', async () => {
  const f = worker();
  for (const [type, payload] of [['tool', {name: 'eval', input: {script: 'alert(1)'}}], ['act', {name: 'fetch'}], ['arbitrary-api', {}]]) {
    assert.ok((await f.send(type, payload)).error);
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.send('tool', {name: 'read_page', input: {depth: 4}}), {ok: true});
  const scripts = f.calls.filter(c => c[0] === 'script').map(c => c[1]);
  assert.deepEqual(Array.from(scripts[0].files), ['page-tools.js']);
  assert.equal(scripts[0].target.tabId, 7); assert.equal(scripts[0].world, 'ISOLATED');
  assert.equal(scripts[1].target.tabId, 7); assert.equal(scripts[1].world, 'ISOLATED');
  assert.equal(scripts[1].args[0], 'tool'); assert.equal(scripts[1].args[1].name, 'read_page');
});

test('an own extension panel opened as a browser tab is trusted by its URL', async () => {
  const f = worker();
  assert.deepEqual(await f.send('tool', {name: 'view'}, {...trusted(), tab: {...TAB, id: 10, url: `${ORIGIN}/panel.html?tab=7`}}), {ok: true});
});

test('switching tabs during helper injection prevents the page operation', async () => {
  const f = worker({queries: [[TAB], [{...TAB, id: 8}]]});
  assert.ok((await f.send('act', {name: 'click', input: {ref: 'ref_1'}})).error);
  assert.equal(f.calls.filter(c => c[0] === 'script').length, 1, 'only the helper was injected; the action was not executed');
});

test('a changed active tab and restricted browser URLs cannot be read or captured', async () => {
  for (const f of [worker({active: [{...TAB, id: 8}]}), worker({tab: {...TAB, url: 'chrome://settings/'}}), worker({tab: {...TAB, url: undefined}})]) {
    assert.ok((await f.send('capture')).error);
    assert.ok((await f.send('page')).error);
    assert.equal(f.calls.some(c => c[0] === 'capture' || c[0] === 'script'), false);
  }
});

test('native captures use the bound window and discard a capture if the active tab changes', async () => {
  const f = worker();
  assert.equal((await f.send('capture')).dataUrl, 'data:image/jpeg;base64,AQID');
  const call = f.calls.find(c => c[0] === 'capture');
  assert.equal(call[1], 9); assert.equal(call[2].format, 'jpeg'); assert.equal(call[2].quality, 85);
  const changed = worker({queries: [[TAB], [{...TAB, id: 8}]]});
  const response = await changed.send('capture');
  assert.ok(response.error); assert.equal(response.dataUrl, undefined);
});

test('native screenshot requests are paced and their queue is bounded', async () => {
  const f = worker(), times = [];
  f.chrome.tabs.captureVisibleTab = async () => { times.push(Date.now()); return 'data:image/jpeg;base64,AQID'; };
  const requests = [f.send('capture'), f.send('capture'), f.send('capture')];
  assert.match((await f.send('capture')).error, /already in progress/);
  const results = await Promise.all(requests);
  assert.ok(results.every(value => value.dataUrl));
  assert.ok(times[1] - times[0] >= 540 && times[2] - times[1] >= 540, 'calls stay below the browser capture quota');
});

test('a result read across navigation is discarded rather than attached to the wrong page', async () => {
  const f = worker({result: {page: {text: 'Before navigation'}}});
  let gets = 0;
  f.chrome.tabs.get = async () => ({...TAB, url: ++gets === 1 ? TAB.url : 'https://article.test/next'});
  const result = await f.send('page', {max: 5000});
  assert.match(result.error, /navigated/); assert.equal(result.page, undefined);
});

test('context-menu selection is bounded, delivered once, and expires', async () => {
  const f = worker();
  f.chrome.contextMenus.onClicked.listeners[0]({menuItemId: 'ask-pagebot', selectionText: 'x'.repeat(10000)}, TAB);
  assert.equal((await f.send('selection')).selection.length, 8000);
  assert.equal((await f.send('selection')).selection, '');
  f.stored['pagebot-selection-7'] = {text: 'Old selection', at: Date.now() - 130000};
  assert.equal((await f.send('selection')).selection, '');
});

test('toolbar, shortcut, and context-menu gestures open a panel pinned to that tab without awaiting an API first', () => {
  for (const trigger of [f => f.chrome.action.onClicked.listeners[0](TAB), f => f.chrome.commands.onCommand.listeners[0]('open-pagebot', TAB), f => f.chrome.contextMenus.onClicked.listeners[0]({menuItemId: 'ask-pagebot'}, TAB)]) {
    const f = worker(); trigger(f);
    const local = f.calls.filter(c => c[0] === 'options' || c[0] === 'open');
    assert.equal(local[0][1].path, 'panel.html?tab=7');
    assert.equal(local[1][0], 'open'); assert.equal(local[1][1].tabId, 7);
  }
});

function panel() {
  const listeners = {}, posts = [], sent = [];
  const element = () => ({hidden: false, textContent: '', addEventListener(name, fn) { this[name] = fn; }});
  const elements = Object.fromEntries(['chat', 'context', 'notice', 'fallback', 'fullChat', 'resume'].map(key => [key, element()]));
  elements.chat.contentWindow = {postMessage: (...args) => posts.push(args)};
  const window = {addEventListener(name, fn) { listeners[name] = fn; }};
  const document = {hidden: false, getElementById: id => elements[id], addEventListener(name, fn) { listeners[name] = fn; }};
  const chrome = {runtime: {sendMessage: async message => { sent.push(message); return message.type === 'status' ? {tab: TAB} : {page: {title: 'Article', text: 'Allowed'}}; }}};
  vm.runInNewContext(panelSource, {PAGEBOT_CONFIG: {origin: 'https://pagebot.test', version: 14}, chrome, document, window, location: {search: '?tab=7'}, URL, URLSearchParams, setTimeout() {}, innerWidth: 400, innerHeight: 800, Map, Set, Number, String}, {filename: 'extension/panel.js'});
  return {listeners, posts, sent, elements};
}

test('the side-panel bridge ignores forged windows, origins, and unknown operations', async () => {
  const f = panel(); await Promise.resolve(); const before = f.sent.length;
  const message = {type: 'page', id: 2, max: 1000};
  for (const event of [{origin: 'https://evil.test', source: f.elements.chat.contentWindow, data: message}, {origin: 'https://pagebot.test', source: {}, data: message}, {origin: 'https://pagebot.test', source: f.elements.chat.contentWindow, data: {...message, type: '__proto__'}}]) await f.listeners.message(event);
  assert.equal(f.sent.length, before);
  assert.equal(f.posts.length, 0);
  await f.listeners.message({origin: 'https://pagebot.test', source: f.elements.chat.contentWindow, data: message});
  assert.equal(f.sent.find(m => m.type === 'page').tabId, 7);
  assert.equal(f.posts.at(-1)[0].id, 2); assert.equal(f.posts.at(-1)[1], 'https://pagebot.test');
  assert.equal(f.elements.chat.src, 'https://pagebot.test/widget?host=extension&v=14');
});

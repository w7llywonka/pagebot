/* The only bridge from the site's chat to local browser capabilities. */
(() => {
  'use strict';
  const config = globalThis.PAGEBOT_CONFIG, frame = document.getElementById('chat');
  const context = document.getElementById('context'), notice = document.getElementById('notice'), fallback = document.getElementById('fallback');
  const origin = new URL(config.origin).origin;
  const params = new URLSearchParams(location.search), raw = params.get('tab'), tabId = Number(raw);
  const full = document.getElementById('fullChat'); full.href = `${origin}/chat`;
  if (raw == null) {
    chrome.tabs.query({active: true, currentWindow: true}).then(tabs => {
      if (Number.isSafeInteger(tabs[0]?.id)) location.replace(`panel.html?tab=${tabs[0].id}`);
      else { notice.hidden = false; notice.textContent = 'Open a website, then click the Pagebot toolbar button.'; }
    });
    return;
  }
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(tabId)) { notice.hidden = false; notice.textContent = 'Open Pagebot using its toolbar button.'; return; }
  let ready = false, closed = false;
  const post = data => frame.contentWindow?.postMessage(data, origin);
  const showNotice = text => { notice.textContent = text || ''; notice.hidden = !text; };
  const request = (type, payload = {}) => chrome.runtime.sendMessage({scope: 'pagebot-extension', type, tabId, payload});
  async function status() {
    try {
      const value = await request('status');
      if (value.error) { context.textContent = 'Page tools need a connection'; showNotice(value.error); }
      else { context.textContent = new URL(value.tab.url).hostname; context.title = value.tab.title; showNotice(''); }
    } catch { context.textContent = 'Extension needs to be reloaded'; showNotice('Reload this extension in your browser, then click the Pagebot toolbar button again.'); }
  }
  const controls = new Set(['ready', 'hide', 'show', 'close', 'where', 'glass', 'clear']);
  const operations = new Map([['page', 'page'], ['tool', 'tool'], ['act', 'act'], ['find', 'find'], ['extensionCapture', 'capture']]);
  window.addEventListener('message', async event => {
    if (event.source !== frame.contentWindow || event.origin !== origin || !event.data || typeof event.data !== 'object') return;
    const data = event.data;
    const hasId = typeof data.id === 'string' && data.id.length <= 80 || Number.isSafeInteger(data.id) && data.id > 0;
    const reply = value => { if (hasId) post({...value, id: data.id}); };
    if (controls.has(data.type)) {
      if (data.type === 'ready') {
        ready = true; closed = false; frame.hidden = false; fallback.hidden = true;
        post({type: 'open'}); reply({}); status();
        try { const value = await request('selection'); if (value.selection) post({type: 'sel', text: value.selection}); } catch {}
      } else if (data.type === 'close') {
        closed = true; frame.hidden = true; fallback.hidden = false; post({type: 'hidden'}); reply({});
        if (typeof chrome.sidePanel?.close === 'function') chrome.sidePanel.close({tabId}).catch(() => {});
      } else if (data.type === 'where') reply({pos: {r: 0, b: 0}, size: {w: innerWidth, h: innerHeight}});
      else if (data.type === 'glass' || data.type === 'clear') reply({light: false});
      else reply({}); // native captures exclude the side panel, so hide/show are unnecessary
      return;
    }
    const operation = operations.get(data.type);
    if (!operation || !hasId) return;
    try {
      const value = await request(operation, data);
      if (value?.error) showNotice(value.error);
      else if (data.type === 'page') status();
      reply(value || {error: 'The extension did not return a result.'});
    } catch { const error = 'The extension could not connect. Click the Pagebot toolbar button again.'; showNotice(error); reply({error}); }
  });
  document.getElementById('resume').addEventListener('click', () => {
    closed = false; frame.hidden = false; fallback.hidden = true;
    if (ready) post({type: 'open'}); status();
  });
  frame.addEventListener('error', () => showNotice('Pagebot could not load. Check your connection or open the full-page chat.'));
  frame.src = `${origin}/widget?host=extension&v=${encodeURIComponent(config.version)}`;
  setTimeout(() => { if (!ready && !closed) showNotice('Pagebot is taking longer to load. Check your connection or use the full-page chat link above.'); }, 15000);
  document.addEventListener('visibilitychange', () => { if (ready) post({type: document.hidden || closed ? 'hidden' : 'open'}); });
  window.addEventListener('focus', () => { if (!closed) status(); });
  status();
})();

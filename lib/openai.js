import { EventEmitter } from 'node:events';

// Adapt Responses to the same text/tool/usage events as the Claude client. Page actions still run
// through pageActs: the model never executes code or bypasses the bookmarklet's permission checks.
const URL = 'https://api.openai.com/v1/responses';
const error = (message, status) => Object.assign(new Error(message), { openai: true, status });
const interrupted = () => error('The model connection was interrupted before the answer finished. Try again.');
const ref = { type: 'object', properties: { type: { const: 'ref' }, ref: { type: 'string' } }, required: ['type', 'ref'], additionalProperties: false };
const point = { type: 'object', properties: { type: { const: 'coordinate' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['type', 'x', 'y'], additionalProperties: false };
const target = { anyOf: [ref, point] };
const browser = {
  screenshot: ['See the current page as an image. The user may need to share the tab first.', {}],
  zoom: ['See part of the latest screenshot. region is [x0,y0,x1,y1] in screenshot pixels.', { region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 } }],
  read_page: ['Read the page tree and element refs, including open shadow roots and same-origin frames.', { filter: { enum: ['all', 'interactive'] }, depth: { type: 'integer', minimum: 1, maximum: 50 }, ref: { type: 'string' } }],
  find: ['Find elements on the page by a short description; returns refs for other tools.', { query: { type: 'string', maxLength: 300 } }],
  get_page_text: ['Read the current page text.', {}],
  scroll: ['Scroll at a point in the latest screenshot.', { target: point, scroll_direction: { enum: ['up', 'down', 'left', 'right'] }, scroll_amount: { type: 'integer', minimum: 1, maximum: 10 } }],
  scroll_to: ['Scroll an element ref into view.', { target: ref }],
  hover: ['Hover over an element ref or screenshot coordinate.', { target }],
  mouse_move: ['Move the pointer to a screenshot coordinate.', { target: point }],
  wait: ['Wait for the page to update, up to 30 seconds.', { duration: { type: 'number', minimum: 0, maximum: 30 } }],
  left_click: ['Click an element ref from read_page or find. The user approves the click.', { target: ref }],
  form_input: ['Fill a field, select an option, or set a checkbox by ref. The user approves it. Protected fields are refused.', { target: ref, value: { type: ['string', 'number', 'boolean'] } }],
};
// The browser extension (README "Browser extension") runs more of the toolset. The server turns those members on in the
// toolset's configs only for a panel running in the extension; each still goes through the server's checks and the
// extension's own asking, exactly as with Claude.
const tab = { tab_id: { type: 'string', description: 'A tab from list_tabs, like "tab-12". Leave it out for the current tab.' } };
const mods = { modifiers: { type: 'string', description: 'Keys held during the click, like "shift" or "ctrl+shift".' } };
const ext = {
  left_click: ['Click an element ref, or a point in the latest screenshot. The user approves the click.', { target, ...mods }],
  right_click: ['Right-click an element ref or a point in the latest screenshot.', { target, ...mods }],
  middle_click: ['Middle-click an element ref or a point in the latest screenshot.', { target, ...mods }],
  double_click: ['Double-click an element ref or a point in the latest screenshot.', { target, ...mods }],
  triple_click: ['Triple-click an element ref or a point in the latest screenshot.', { target, ...mods }],
  left_click_drag: ['Drag from one screenshot point to another with the left button.', { from: point, target: point }],
  left_mouse_down: ['Press the left mouse button at a screenshot point.', { target: point }],
  left_mouse_up: ['Let go of the left mouse button at a screenshot point.', { target: point }],
  type: ['Type text where the keyboard focus is.', { text: { type: 'string', maxLength: 5000 } }],
  key: ['Press keys: a name like "Enter", a chord like "ctrl+a", or several separated by spaces.', { text: { type: 'string', maxLength: 200 }, repeat: { type: 'integer', minimum: 1, maximum: 100 } }],
  hold_key: ['Hold one key or chord for some seconds.', { text: { type: 'string', maxLength: 60 }, duration: { type: 'number', minimum: 0, maximum: 30 } }],
  navigate: ['Go to an address, or "back", "forward" or "reload". Another site asks the user first.', { url: { type: 'string', maxLength: 2000 } }],
  new_tab: ['Open a new empty tab and work in it.', {}],
  list_tabs: ['List the open tabs.', {}],
  switch_tab: ['Work in another tab from list_tabs.', { tab_id: tab.tab_id }],
  close_tab: ['Close a tab from list_tabs.', { tab_id: tab.tab_id }],
  read_console: ['Read the page console messages logged since the last read.', {}],
  read_network: ['Read the page network requests (addresses without query strings).', {}],
  javascript_exec: ['Run JavaScript in the page and get its result. The user always approves it first.', { text: { type: 'string', maxLength: 5000 } }],
};
const required = { zoom: ['region'], find: ['query'], scroll: ['target', 'scroll_direction'], scroll_to: ['target'], hover: ['target'], mouse_move: ['target'], wait: ['duration'], left_click: ['target'], form_input: ['target', 'value'],
  right_click: ['target'], middle_click: ['target'], double_click: ['target'], triple_click: ['target'], left_click_drag: ['from', 'target'], left_mouse_down: ['target'], left_mouse_up: ['target'],
  type: ['text'], key: ['text'], hold_key: ['text', 'duration'], navigate: ['url'], switch_tab: ['tab_id'], close_tab: ['tab_id'], javascript_exec: ['text'] };
const OPTIONAL = new Set(['read_console', 'read_network', 'javascript_exec']); // off in the toolset unless its configs turn them on
const fn = (name, [description, properties], withTab) => ({
  type: 'function', name, description, strict: false,
  parameters: { type: 'object', properties: withTab && !properties.tab_id ? { ...properties, ...tab } : properties, required: required[name] || [], additionalProperties: false },
});
const browserTools = Object.entries(browser).map(([name, def]) => fn(name, def));
// the toolset's members as functions: the bookmark's set, or, when its configs turn extension members on, those too
function toolsetTools(configs) {
  if (!configs) return browserTools;
  const on = name => configs[name]?.enabled === true || !OPTIONAL.has(name) && configs[name]?.enabled !== false;
  if (!Object.keys(ext).some(name => name !== 'left_click' && on(name))) return browserTools;
  const names = [...new Set([...Object.keys(browser), ...Object.keys(ext)])].filter(on);
  return names.map(name => fn(name, ext[name] || browser[name], true));
}
const isBrowser = name => Object.hasOwn(browser, name) || Object.hasOwn(ext, name);
// the extension's tab list (the toolset's browser_state block), as text the model can read. Titles come from pages, so
// each title and address is a quoted JSON string: a title can't pass itself off as an address, a marker or another tab.
function tabsText(b) {
  const tabs = (b.tabs || []).map(t => `${t.tab_id}${t.active ? ' (current)' : ''}: title ${JSON.stringify(String(t.title || ''))}, address ${JSON.stringify(String(t.url || ''))}`);
  const opened = (b.state_changes || []).filter(c => c.type === 'tab_opened').map(c => c.tab_id);
  return `Open tabs:\n${tabs.join('\n') || '(none)'}${opened.length ? `\nJust opened: ${opened.join(', ')}` : ''}`;
}

function content(block) {
  if (block.type === 'text') return { type: 'input_text', text: block.text };
  if (block.type === 'browser_state') return { type: 'input_text', text: tabsText(block) };
  if (block.type === 'image') return { type: 'input_image', image_url: `data:${block.source.media_type};base64,${block.source.data}` };
  if (block.type === 'document' && block.source.media_type === 'application/pdf')
    return { type: 'input_file', filename: block.title || 'document.pdf', file_data: `data:application/pdf;base64,${block.source.data}` };
  throw error(`Unsupported OpenAI input: ${block.type}`);
}

export function responseInput(messages) {
  return messages.flatMap(m => {
    // Keep function calls and encrypted reasoning exactly as returned for the next page-action round.
    if (m.openaiOutput) return m.openaiOutput;
    if (typeof m.content === 'string') return [{ role: m.role, content: m.content }];
    const items = [], blocks = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') items.push({ type: 'function_call_output', call_id: b.tool_use_id, output: b.content.map(content) });
      else blocks.push(content(b));
    }
    if (blocks.length) items.push({ role: m.role, content: blocks });
    return items;
  });
}

export function responseParams(params) {
  const tools = (params.tools || []).flatMap(t => t.type?.startsWith('browser_toolset_') ? toolsetTools(t.configs)
    : t.name === 'web_search' ? [{ type: 'web_search', search_context_size: 'low' }]
    : [{ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false }]);
  const searches = params.tools?.find(t => t.name === 'web_search');
  return {
    model: params.model, instructions: params.system, input: responseInput(params.messages),
    max_output_tokens: params.max_tokens, reasoning: { effort: params.output_config.effort },
    store: false, stream: true, include: ['reasoning.encrypted_content'],
    ...(tools.length && { tools, parallel_tool_calls: false }),
    ...(searches && { max_tool_calls: searches.max_uses }),
    ...(params.tool_choice?.type === 'none' && { tool_choice: 'none' }),
  };
}

function message(response, promptTokens = 0) {
  const output = response.output || [], blocks = [];
  let searches = 0, refused = false;
  for (const item of output) {
    if (!item) continue;
    if (item.type === 'function_call') {
      let input;
      try { input = JSON.parse(item.arguments); } catch { throw error('The model returned unreadable page-action arguments. Try again.'); }
      blocks.push({ type: 'tool_use', id: item.call_id, name: item.name, input, ...(isBrowser(item.name) && { toolset_name: 'browser' }) });
    } else if (item.type === 'web_search_call' && item.status === 'completed' && item.action?.type === 'search') {
      searches++;
      blocks.push({ type: 'web_search_tool_result', content: [] });
    } else if (item.type === 'message') for (const part of item.content || []) {
      if (part.type === 'refusal') { refused = true; blocks.push({ type: 'text', text: part.refusal }); }
      if (part.type === 'output_text') blocks.push({ type: 'text', text: part.text, citations: (part.annotations || [])
        .filter(a => a.type === 'url_citation').map(a => ({ type: 'web_search_result_location', url: a.url, title: a.title })) });
    }
  }
  const u = response.usage, cached = u?.input_tokens_details?.cached_tokens || 0;
  const stop = response.status === 'incomplete' ? response.incomplete_details?.reason === 'content_filter' ? 'refusal' : 'max_tokens'
    : refused ? 'refusal' : blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  return {
    model: response.model, content: blocks, openaiOutput: output,
    stop_reason: ['completed', 'incomplete'].includes(response.status) ? stop : null,
    usageComplete: !!u,
    usage: { input_tokens: u ? Math.max(0, u.input_tokens - cached) : promptTokens,
      cache_read_input_tokens: cached, output_tokens: u?.output_tokens || 0, server_tool_use: { web_search_requests: searches } },
  };
}

// SSE frames may cross chunks, contain multibyte text, or end without a trailing newline.
async function* events(body) {
  if (!body) throw interrupted();
  const decoder = new TextDecoder();
  let buffer = '', data = [];
  function line(s) {
    if (!s) { const payload = data.join('\n'); data = []; return payload || null; }
    if (s.startsWith('data:')) data.push(s.slice(5).replace(/^ /, ''));
    return null;
  }
  function* consume(final = false) {
    for (;;) {
      const i = buffer.search(/[\r\n]/);
      if (i < 0 || (!final && i === buffer.length - 1 && buffer[i] === '\r')) break;
      const s = buffer.slice(0, i), n = buffer[i] === '\r' && buffer[i + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(i + n);
      const p = line(s); if (p) yield p;
    }
    if (final) { if (buffer) line(buffer); buffer = ''; const p = line(''); if (p) yield p; }
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* consume();
  }
  buffer += decoder.decode(); yield* consume(true);
}

export function createOpenAI({ apiKey, fetch: fetchAPI = globalThis.fetch }) {
  return { stream(params, { promptTokens = 0 } = {}) {
    const emitter = new EventEmitter(), controller = new AbortController();
    let pending;
    emitter.abort = () => controller.abort();
    emitter.currentMessage = null;
    emitter.finalMessage = () => pending ||= (async () => {
      let response = { model: params.model, output: [], status: 'in_progress' };
      try {
        const r = await fetchAPI(URL, {
          method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]),
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(responseParams(params)),
        });
        if (!r.ok) { const b = await r.json().catch(() => null); throw error(b?.error?.message || `OpenAI error ${r.status}`, r.status); }
        emitter.currentMessage = message(response, promptTokens);
        for await (const payload of events(r.body)) {
          let ev;
          try { ev = JSON.parse(payload); } catch { throw error('The model provider sent an unreadable response. Try again.'); }
          if (ev.response) response = { ...response, ...ev.response };
          if (ev.type === 'response.output_item.added' || ev.type === 'response.output_item.done') response.output[ev.output_index] = ev.item;
          if (ev.type === 'response.content_part.added') response.output[ev.output_index].content[ev.content_index] = ev.part;
          if (ev.type === 'response.output_text.delta' || ev.type === 'response.refusal.delta') {
            const part = response.output[ev.output_index].content[ev.content_index], field = ev.type === 'response.refusal.delta' ? 'refusal' : 'text';
            part[field] = (part[field] || '') + ev.delta;
            emitter.emit('text', ev.delta);
          }
          if (ev.type === 'response.web_search_call.in_progress') emitter.emit('streamEvent', { type: 'content_block_start', content_block: { type: 'server_tool_use', name: 'web_search' } });
          // Function arguments can be incomplete while streaming; parse them only when the response finishes.
          const snapshot = { ...response, output: response.output.filter(x => x && x.type !== 'function_call') };
          emitter.currentMessage = message(snapshot, promptTokens);
          if (ev.type === 'error' || ev.type === 'response.failed') throw error(ev.message || response.error?.message || 'OpenAI could not finish this answer.', ev.status);
          if (ev.type === 'response.completed' || ev.type === 'response.incomplete') {
            const final = message(response, promptTokens);
            emitter.currentMessage = final;
            for (const b of final.content) emitter.emit('contentBlock', b);
            return final;
          }
        }
        throw interrupted();
      } catch (e) {
        if (e.name === 'AbortError' || e.openai) throw e;
        throw Object.assign(interrupted(), { cause: e });
      }
    })();
    return emitter;
  } };
}

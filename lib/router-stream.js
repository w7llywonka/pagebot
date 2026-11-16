// OpenRouter uses SSE, whose events can span lines and network chunks. Keep this independent of
// credentials and persistence so incomplete responses can be detected without losing streamed usage.
const STOP_REASONS = { stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal' };
const interrupted = cause => Object.assign(new Error('The model connection was interrupted before the answer finished. Try again.', { cause }), { router: true });

export async function readRouterStream(stream, state, onText) {
  if (!stream) throw interrupted();
  const decoder = new TextDecoder();
  let buffer = '', data = [], finish = null, done = false;
  function dispatch() {
    if (!data.length || done) { data = []; return; }
    const payload = data.join('\n').trim(); data = [];
    if (!payload) return;
    if (payload === '[DONE]') { done = true; return; }
    let event;
    try { event = JSON.parse(payload); }
    catch (cause) { throw Object.assign(new Error('The model provider sent an unreadable response. Try again.', { cause }), { router: true }); }
    if (event.usage) state.usage = event.usage;
    if (event.error) throw Object.assign(new Error(String(event.error.message || 'The model provider could not finish this answer.')), { status: event.error.code, router: true });
    const choice = event.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    for (const item of choice?.delta?.annotations || [])
      if (item?.type === 'url_citation' && item.url_citation) state.sources.push(item.url_citation);
    if (choice?.delta?.content) onText(choice.delta.content);
  }
  function line(value) {
    if (!value) return dispatch();
    // SSE permits `data:` with or without a space. Comments and other fields are not JSON.
    if (value === 'data') data.push('');
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  }
  function consume(final = false) {
    for (;;) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0 || (!final && index === buffer.length - 1 && buffer[index] === '\r')) break;
      const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      const value = buffer.slice(0, index); buffer = buffer.slice(index + width);
      line(value);
      if (done) return;
    }
    if (final) { if (buffer) line(buffer); buffer = ''; dispatch(); }
  }
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true }); consume();
      if (done) break;
    }
    if (!done) { buffer += decoder.decode(); consume(true); }
  } catch (error) {
    // User cancellation remains cancellation. Preserve provider errors/status codes and partial state.
    if (error?.name === 'AbortError' || error?.router) throw error;
    throw interrupted(error);
  }
  // A clean socket EOF alone is not a completion event. Never save a silently truncated answer as done.
  if (!done && !finish) throw interrupted();
  return STOP_REASONS[finish] || finish || 'end_turn';
}

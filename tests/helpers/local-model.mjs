// Loaded only by the integration test subprocess. Never contact a real model provider.
const fetchLocal = globalThis.fetch;
const mockOrigin = process.env.PAGEBOT_MOCK_MODEL_ORIGIN;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.href === 'https://openrouter.ai/api/v1/chat/completions') {
    return fetchLocal(`${mockOrigin}/router`, init);
  }
  if (url.origin !== mockOrigin) throw new Error(`Unexpected outbound test request: ${url.origin}`);
  return fetchLocal(input, init);
};

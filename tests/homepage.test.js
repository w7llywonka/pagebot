import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The homepage keeps the bookmark installation flow and a local extension download guide.
// Account and administration routes stay out of this public entry page.
const html = readFileSync(fileURLToPath(new URL('../public/install.html', import.meta.url)), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1];
const visible = body.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the homepage shows the bookmark, its copy fallback, and the requested extension option', () => {
  assert.equal(visible, 'pagebot Drag this up to your bookmarks bar. Can’t drag? Copy it instead Get the extension');
});

test('the button is the bookmark, with its version, where the server and the other tests look for it', () => {
  assert.match(body, /<a class="btn" id="bm" href="\{\{HREF\}\}"[^>]* data-v="\{\{VERSION\}\}">/);
  assert.equal(html.split('{{HREF}}').length, 2, 'the bookmark is on the page once, not also in a box to read');
});

test('it links only to the bookmark and the local extension guide', () => {
  const links = [...html.matchAll(/\s(?:href|src|action)\s*=\s*["']?([^"'\s>]+)/gi)].map(m => m[1]);
  assert.deepEqual(links, ['{{HREF}}', '/extension']);
  assert.doesNotMatch(html, /\/admin|\/chat|\/widget|https?:\/\//i);
  assert.doesNotMatch(html, /\{\{ORIGIN\}\}/, 'the server address is not printed on the page');
});

test('nothing on it, shown or not, describes what the bookmark does', () => {
  // (the page's source is public too, so its comments stay as quiet as its text; why it's bare is explained in server.js)
  const words = /\b(chat|ai|assistant|model|claude|haiku|sonnet|answers?|ask|reads?|screenshots?|highlight\w*|searches|web search|panel|summar\w*|homework|quiz\w*|admin|owner|account|sign.?in|sign.?up|passcode|password)\b/i;
  assert.doesNotMatch(html.replace('{{HREF}}', ''), words);
});

test('search engines are told to leave it out', () => {
  assert.match(html, /<meta name="robots" content="[^"]*noindex[^"]*">/);
});

test('it stays tiny: no scenery, no sections', () => {
  assert.ok(html.length < 6000, `the homepage is ${html.length} characters`);
  assert.doesNotMatch(html, /<canvas|<section|<nav|<footer|<details|<textarea/i);
});

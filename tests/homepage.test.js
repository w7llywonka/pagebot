import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The homepage is only the button you drag to the bookmarks bar. It doesn't say what the bookmark does and it doesn't link to the
// rest of the site, so someone who lands on it learns nothing; whoever was invited gets the rest after signing in and being accepted.
const html = readFileSync(fileURLToPath(new URL('../public/install.html', import.meta.url)), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1];
const visible = body.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the homepage shows the button, one line on where it goes, and the copy fallback, and nothing else', () => {
  assert.equal(visible, '📌 pagebot Drag to your bookmarks bar. Can’t drag? Copy it instead');
});

test('the button is the bookmark, with its version, where the server and the other tests look for it', () => {
  assert.match(body, /<a class="btn" id="bm" href="\{\{HREF\}\}"[^>]* data-v="\{\{VERSION\}\}">/);
  assert.equal(html.split('{{HREF}}').length, 2, 'the bookmark is on the page once, not also in a box to read');
});

test('it links nowhere: not to the chat, the admin page, or anything outside', () => {
  const links = [...html.matchAll(/\s(?:href|src|action)\s*=\s*["']?([^"'\s>]+)/gi)].map(m => m[1]);
  assert.deepEqual(links, ['{{HREF}}']);
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

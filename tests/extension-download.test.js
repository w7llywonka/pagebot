import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import { once } from 'node:events';
import { sendExtensionZip } from '../lib/extension-package.js';

let server, origin;
before(async () => {
  const app = express();
  app.get('/extension.zip', (req, res) => sendExtensionZip(res, req.get('x-test-origin') || 'https://pagebot.example', 14));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('the site download returns a ZIP attachment scoped to its host instead of a cached page', async () => {
  const response = await fetch(origin + '/extension.zip');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="pagebot-extension.zip"');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('vary'), /Host/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.ok(bytes.length > 1000);
  const other = await fetch(origin + '/extension.zip', {headers: {'x-test-origin': 'https://other.pagebot.example'}});
  assert.equal(other.status, 200);
  assert.notDeepEqual(Buffer.from(await other.arrayBuffer()), bytes, 'another installation receives its own configuration');
});

test('an unsafe public origin returns an actionable error rather than an unsafe extension', async () => {
  for (const address of ['http://public.example', 'https://user:secret@pagebot.example', 'https://pagebot.example/path']) {
    const response = await fetch(origin + '/extension.zip', {headers: {'x-test-origin': address}});
    assert.equal(response.status, 400);
    assert.match(await response.text(), /HTTPS Pagebot site/);
  }
});

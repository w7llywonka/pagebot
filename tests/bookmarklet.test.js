import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../bookmarklet.js', import.meta.url), 'utf8');
const origin = 'https://pagebot.test';

function page(texts = []) {
  const frames = new Map(), listeners = new Map(), replies = [], ranges = [];
  let nextFrame = 1, layoutReads = 0, pageReads = 0;
  const nodes = texts.map(value => {
    const config = typeof value === 'string' ? { text: value } : value;
    const element = { nodeName: config.tag || 'P', style: {}, scrollIntoView() {} };
    return { nodeValue: config.text, parentNode: element, parentElement: element, visible: config.visible !== false };
  });
  const frameWindow = { postMessage(message) { replies.push(message); } };
  const frame = {
    style: { setProperty() {} }, contentWindow: frameWindow, isConnected: true,
    get offsetWidth() { layoutReads++; return 380; }, remove() { this.isConnected = false; },
  };
  const body = { get innerText() { pageReads++; return 'Page text to send'; } };
  const document = {
    body, title: 'Sample page', documentElement: { appendChild() {} },
    getElementById() { return null; }, createElement() { return frame; }, addEventListener() {},
    createTreeWalker(root, filter, options) {
      const accepted = nodes.filter(node => options.acceptNode(node) === 1);
      let i = 0;
      return { nextNode: () => accepted[i++] || null };
    },
    createRange() {
      const range = {
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
        getClientRects() { return this.startContainer.visible ? [{}] : []; },
      };
      ranges.push(range);
      return range;
    },
  };
  const window = {
    innerWidth: 1200, innerHeight: 900, getSelection: () => ' selected text ',
    addEventListener(type, handler) { listeners.set(type, handler); },
  };
  const context = vm.createContext({
    window, document, location: { href: 'https://example.com/article' },
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    setTimeout() {}, clearTimeout() {},
  });
  // Match the homepage's bookmarklet serialization as well as its browser execution.
  vm.runInContext(source.replaceAll('__ORIGIN__', origin).replaceAll('__VERSION__', '8').replace(/\n\s*/g, ''), context);
  return {
    bot: window.__pb, frame, nodes, ranges, replies, window,
    get pageReads() { return pageReads; }, get layoutReads() { return layoutReads; },
    get pendingFrames() { return frames.size; },
    message(type, data = {}) { listeners.get('message')({ origin, source: frameWindow, data: { type, id: 'reply', ...data } }); },
    resize() { listeners.get('resize')(); },
    paint() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); },
  };
}

test('site metadata does not read page text; ordinary page requests still respect the limit', () => {
  const p = page();
  p.message('page', { max: 1 });
  assert.equal(p.pageReads, 0);
  assert.equal(p.replies[0].page.text, '');
  assert.equal(p.replies[0].page.url, 'https://example.com/article');
  assert.equal(p.replies[0].page.title, 'Sample page');
  assert.equal(p.replies[0].selection, 'selected text');
  p.message('page', { max: 4 });
  assert.equal(p.pageReads, 1);
  assert.equal(p.replies[1].page.text, 'Page');
});

test('drag bursts paint once without losing pointer deltas at the screen edge', () => {
  const p = page();
  p.message('drag', { dx: 100, dy: 100 });
  p.message('drag', { dx: -10, dy: -20 });
  p.message('where');
  assert.equal(p.pendingFrames, 1);
  assert.equal(p.replies[0].pos.r, 10);
  assert.equal(p.replies[0].pos.b, 20);
  p.paint();
  assert.equal(p.frame.style.right, '10px');
  assert.equal(p.frame.style.bottom, '20px');
});

test('resize bursts keep final dimensions available before the next paint and flush layout once', () => {
  const p = page(), before = p.layoutReads;
  for (let i = 0; i < 100; i++) p.message('size', { w: 400 + i, h: 500 + i });
  p.message('where');
  assert.equal(p.pendingFrames, 1);
  assert.equal(p.layoutReads, before);
  assert.equal(p.replies[0].size.w, 499);
  assert.equal(p.replies[0].size.h, 599);
  p.paint();
  assert.equal(p.frame.style.width, '499px');
  assert.equal(p.frame.style.height, '599px');
  assert.equal(p.layoutReads, before + 1);
});

test('viewport resize keeps the panel on screen and docked resize retains its constraints', () => {
  const p = page();
  p.bot.r = 600; p.bot.b = 300;
  p.window.innerWidth = 500; p.window.innerHeight = 600;
  p.resize(); p.resize();
  assert.equal(p.bot.r, 120);
  assert.equal(p.bot.b, 40);
  assert.equal(p.pendingFrames, 1);
  p.paint();
  p.bot.dock = 1;
  p.message('size', { dw: 1000 }); p.paint();
  assert.equal(p.frame.style.width, '460px');
  assert.equal(p.frame.style.height, '100vh');
});

test('citation ranges span nodes and preserve whitespace, Unicode expansion, and surrogate offsets', () => {
  const p = page(['prefix \n İSTAN', ' BUL\t 😀 tail']);
  assert.equal(p.bot.find('İstanbul 😀'), 1);
  const range = p.ranges.at(-1);
  assert.equal(range.startContainer, p.nodes[0]);
  assert.equal(range.startOffset, 9);
  assert.equal(range.endContainer, p.nodes[1]);
  assert.equal(range.endOffset, 8);
});

test('citation lookup skips script content and prefers visible matches over hidden duplicates', () => {
  const p = page([
    { text: 'target', tag: 'SCRIPT' },
    { text: 'target', visible: false },
    'actual target',
  ]);
  assert.equal(p.bot.find('target'), 1);
  assert.equal(p.ranges.length, 2);
  assert.equal(p.ranges.at(-1).startContainer, p.nodes[2]);
  assert.equal(p.ranges.at(-1).startOffset, 7);
});

test('long citations fall back to their matching prefix and re-read changed page text', () => {
  const prefix = 'a'.repeat(40);
  const p = page([prefix + ' changed ending']);
  assert.equal(p.bot.find(prefix + 'z'.repeat(30)), 1);
  assert.equal(p.ranges.at(-1).endOffset, 40);
  p.nodes[0].nodeValue = 'replacement text';
  assert.equal(p.bot.find(prefix), 0);
  assert.equal(p.bot.find('replacement'), 1);
});

test('citation lookup retains its one-million-character bound', () => {
  const p = page(['a'.repeat(1_000_000), 'target']);
  assert.equal(p.bot.find('target'), 0);
  assert.equal(p.bot.find('a'.repeat(20)), 1);
  assert.equal(p.ranges.at(-1).startOffset, 0);
  assert.equal(p.ranges.at(-1).endOffset, 20);
});

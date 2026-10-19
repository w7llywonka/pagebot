import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The bookmark opens the panel at about half the window (50% wide, 80% tall; docked: 40% wide), worked out when the page loads.
// A size the person saved still wins (the panel sends it on "ready"), and whatever it's sent is kept inside the window.
const source = fs.readFileSync(new URL('../bookmarklet.js', import.meta.url), 'utf8');
const origin = 'https://pagebot.test';

function page({ width = 1440, height = 900, screen } = {}) {
  const listeners = new Map(), opened = [];
  const frameWindow = { postMessage() {} };
  const frame = { style: { setProperty() {} }, contentWindow: frameWindow, isConnected: true, offsetWidth: 380, remove() { this.isConnected = false; } };
  const document = {
    body: {}, title: 'Sample', documentElement: { appendChild() {} }, getElementById() { return null; },
    createElement() { return frame; }, addEventListener() {},
  };
  const window = {
    innerWidth: width, innerHeight: height, getSelection: () => '', addEventListener(type, handler) { listeners.set(type, handler); },
    ...(screen && { screen }), open(url, name, features) { opened.push({ url, features }); return { closed: false, focus() {} }; },
  };
  const context = vm.createContext({ window, document, location: { href: 'https://example.com/' }, requestAnimationFrame() { return 1; }, setTimeout() {}, clearTimeout() {} });
  vm.runInContext(source.replaceAll('__ORIGIN__', origin).replaceAll('__VERSION__', '11').replace(/\n\s*/g, ''), context); // as the homepage serves it
  return {
    bot: window.__pb, frame, window, opened,
    message(type, data = {}) { listeners.get('message')({ origin, source: frameWindow, data: { type, id: 'reply', ...data } }); },
    paint() { /* frames are not run in this harness: place() is called directly */ window.__pb.place(1); },
  };
}

test('the default panel is half the window: 50% wide, 80% tall, a docked sidebar 40% wide', () => {
  const big = page({ width: 1440, height: 900 }).bot;
  assert.deepEqual([big.w, big.h, big.dw], [720, 720, 576]);
  const laptop = page({ width: 1024, height: 700 }).bot;
  assert.deepEqual([laptop.w, laptop.h, laptop.dw], [512, 560, 420]); // 40% would be 410: the sidebar is never under 420
  const huge = page({ width: 3840, height: 2160 }).bot;
  assert.deepEqual([huge.w, huge.h, huge.dw], [1920, 1728, 1536]);
});

test('the default is clamped: at least 360 wide, never wider than the window less 32', () => {
  const small = page({ width: 640, height: 800 }).bot;
  assert.equal(small.w, 360); // half would be 320
  const edge = page({ width: 700, height: 800 }).bot;
  assert.equal(edge.w, 360);
  const phone = page({ width: 390, height: 800 }).bot;
  assert.equal(phone.w, 358); // 360 would run off the window, so it fills the window less the 16px gutters
  assert.equal(phone.h, 640);
  const tiny = page({ width: 320, height: 480 }).bot;
  assert.deepEqual([tiny.w, tiny.h, tiny.dw], [288, 420, 280]);
  const short = page({ width: 1440, height: 400 }).bot;
  assert.equal(short.h, 368); // the 420 minimum can't run past the window less 32
});

test('a window that reports no size keeps the old fallback instead of NaN', () => {
  const p = page({ width: 0, height: 0 }).bot;
  assert.deepEqual([p.w, p.h, p.dw], [380, 560, 420]);
});

test('the panel is placed at the computed size', () => {
  const p = page({ width: 1440, height: 900 });
  p.paint();
  assert.equal(p.frame.style.width, '720px');
  assert.equal(p.frame.style.height, '720px');
  assert.equal(p.frame.style.right, '16px');
  assert.equal(p.frame.style.bottom, '16px');
  p.bot.dock = 1; p.paint();
  assert.equal(p.frame.style.width, '576px');
  assert.equal(p.frame.style.height, '100vh');
});

test('a saved size wins: "ready" with a size replaces the default; "ready" without one keeps it', () => {
  const keep = page({ width: 1440, height: 900 });
  keep.message('ready', {});
  assert.deepEqual([keep.bot.w, keep.bot.h, keep.bot.dw], [720, 720, 576]);
  const saved = page({ width: 1440, height: 900 });
  saved.message('ready', { size: { w: 430, h: 610 }, dock: true, dw: 500, pos: { r: 40, b: 30 } });
  assert.deepEqual([saved.bot.w, saved.bot.h, saved.bot.dw, saved.bot.r, saved.bot.b], [430, 610, 500, 40, 30]);
  assert.equal(saved.bot.dock, 1);
  saved.paint();
  assert.equal(saved.frame.style.width, '500px'); // docked, at the saved width
});

test('an old bookmark can be sent a bigger size by the panel; it is kept in the window', () => {
  const p = page({ width: 900, height: 700 });
  p.message('ready', { size: { w: 1000, h: 900 }, dw: 2000 });
  p.paint(); p.bot.dock = 0; p.paint();
  assert.equal(p.frame.style.width, '868px'); // 900 - 32
  assert.equal(p.frame.style.height, '668px');
  p.bot.dock = 1; p.paint();
  assert.equal(p.frame.style.width, '860px'); // 900 - 40
});

test('resizing still works and replaces the default; the viewport shrinking keeps the panel on screen', () => {
  const p = page({ width: 1440, height: 900 });
  p.message('size', { w: 500, h: 500 });
  p.message('where');
  assert.deepEqual([p.bot.w, p.bot.h], [500, 500]);
  p.bot.r = 16; p.bot.b = 16;
  p.window.innerWidth = 480; p.window.innerHeight = 520;
  p.window.__pb.bounds();
  p.paint();
  assert.equal(p.frame.style.width, '448px');
  assert.equal(p.frame.style.height, '488px');
});

test('the pop-up window opens at half the screen, and keeps the old size when the screen is unknown', () => {
  const a = page({ screen: { availWidth: 1920, availHeight: 1040 } });
  a.bot.pop = null; a.bot.win();
  assert.match(a.opened[0].features, /^width=960,height=832$/);
  const b = page({ screen: { availWidth: 800, availHeight: 600 } });
  b.bot.win();
  assert.match(b.opened[0].features, /^width=420,height=600$/); // never bigger than the screen
  const c = page();
  c.bot.win();
  assert.match(c.opened[0].features, /^width=420,height=680$/);
});

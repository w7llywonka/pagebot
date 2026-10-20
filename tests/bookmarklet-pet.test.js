import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Bookmarklet v13, the host side of the pet: a `min` message with pet:true makes the frame a see-through square (no radius, shadow or
// blur) that stays on screen, may grow for the speech bubble and shrinks back, is dragged with the usual 'drag', and old pill behaviour
// is untouched. The panda itself is tested in widget-pet.test.js.
const source = fs.readFileSync(new URL('../bookmarklet.js', import.meta.url), 'utf8');
const origin = 'https://pagebot.test';

function page({ width = 1200, height = 900 } = {}) {
  const listeners = new Map(), replies = [];
  const frameWindow = { postMessage(m) { replies.push(m); } };
  const frame = { style: { setProperty() {} }, contentWindow: frameWindow, isConnected: true, offsetWidth: 380, remove() { this.isConnected = false; } };
  const document = { body: {}, title: 'Sample', documentElement: { appendChild() {} }, getElementById() { return null; }, createElement() { return frame; }, addEventListener() {} };
  const window = { innerWidth: width, innerHeight: height, getSelection: () => '', addEventListener(type, handler) { listeners.set(type, handler); } };
  const context = vm.createContext({ window, document, location: { href: 'https://example.com/' }, requestAnimationFrame() { return 1; }, getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)' }), setTimeout() {}, clearTimeout() {} });
  vm.runInContext(source.replaceAll('__ORIGIN__', origin).replaceAll('__VERSION__', '13').replace(/\n\s*/g, ''), context);
  const p = {
    bot: window.__pb, frame, window, replies,
    message(type, data = {}) { listeners.get('message')({ origin, source: frameWindow, data: { type, id: 'reply', ...data } }); },
    paint() { window.__pb.place(1); },
  };
  return p;
}
const box = p => { const s = p.frame.style; return { w: s.width, h: s.height, r: s.right, b: s.bottom, radius: s.borderRadius, shadow: s.boxShadow, blur: s.backdropFilter }; };

test('pet:true makes a see-through square: no radius, no shadow, no blur, 120 px, at the corner the pill sat in', () => {
  const p = page();
  p.message('min', { on: true, pet: true, w: 120, h: 120 }); p.paint();
  assert.deepEqual(box(p), { w: '120px', h: '120px', r: '16px', b: '16px', radius: '0', shadow: 'none', blur: '' });
  assert.equal(p.bot.pet, 1);
});

test('the pet frame is see-through on glass too, and the glass panel gets its look back when it opens', () => {
  const p = page();
  p.message('glass', { on: true });
  p.message('min', { on: true, pet: true, w: 120, h: 120 }); p.paint();
  assert.equal(box(p).shadow, 'none'); assert.equal(box(p).blur, '');
  p.message('min', { on: false, w: 200, h: 46 }); p.paint();
  assert.match(box(p).shadow, /rgba/); assert.match(box(p).blur, /blur/);
  assert.equal(box(p).radius, '14px'); assert.equal(p.bot.pet, 0);
});

test('the old pill is exactly as before: 200 x 46 with a half-height radius and its shadow', () => {
  const p = page();
  p.message('min', { on: true, w: 200, h: 46 }); p.paint();
  assert.deepEqual([box(p).w, box(p).h, box(p).radius], ['200px', '46px', '23px']);
  assert.notEqual(box(p).shadow, 'none');
  p.message('min', { on: true, pet: false, w: 200, h: 46 }); p.paint();
  assert.equal(box(p).radius, '23px', 'pet:false is the pill');
});

test('the frame grows for the speech bubble and shrinks back; the panda stays put and the saved spot is not moved by the bubble', () => {
  const p = page();
  p.bot.r = 1150; p.bot.b = 100; // right at the window's edge: the panda is 120 wide
  p.message('min', { on: true, pet: true, w: 120, h: 120 }); p.paint();
  assert.equal(box(p).r, '1080px', 'kept on screen: 1200 - 120');
  p.message('min', { on: true, pet: true, w: 260, h: 180 }); p.paint();
  assert.deepEqual([box(p).w, box(p).h], ['260px', '180px']);
  assert.equal(box(p).r, '940px', 'the bigger frame slides left to stay on screen');
  p.message('where');
  assert.equal(p.replies.at(-1).pos.r, 1080, 'but where the panda was left is unchanged');
  p.message('min', { on: true, pet: true, w: 120, h: 120 }); p.paint();
  assert.deepEqual([box(p).w, box(p).h, box(p).r], ['120px', '120px', '1080px']);
});

test('dragging the pet is bounded by the pet, not by the panel or the bubble frame', () => {
  const p = page();
  p.message('min', { on: true, pet: true, w: 120, h: 120 });
  p.message('drag', { dx: -5000, dy: -5000 }); p.message('where');
  assert.deepEqual({ ...p.replies.at(-1).pos }, { r: 1080, b: 780 });
  p.message('drag', { dx: 5000, dy: 5000 }); p.message('where');
  assert.deepEqual({ ...p.replies.at(-1).pos }, { r: 0, b: 0 });
  // with the bubble up the frame is bigger, but the bounds stay the panda's
  p.message('min', { on: true, pet: true, w: 280, h: 200 });
  p.message('drag', { dx: -5000, dy: -5000 }); p.message('where');
  assert.deepEqual({ ...p.replies.at(-1).pos }, { r: 1080, b: 780 });
});

test('the pet can be put back where it was left: min carries pos, which is kept on screen', () => {
  const p = page();
  p.message('min', { on: true, pet: true, w: 120, h: 120, pos: { r: 300, b: 200 } }); p.paint();
  assert.deepEqual([box(p).r, box(p).b], ['300px', '200px']);
  p.message('min', { on: false, w: 200, h: 46 });
  p.message('min', { on: true, pet: true, w: 120, h: 120, pos: { r: 9999, b: -5 } }); p.paint(); // junk: ignored (negative) or clamped
  assert.ok(parseInt(box(p).r) <= 1080 && parseInt(box(p).b) >= 0);
  p.message('min', { on: true, pet: true, w: 120, h: 120, pos: { r: 9999, b: 40 } }); p.paint();
  assert.equal(box(p).r, '1080px');
});

test('opening the panel from the pet: the panel takes its normal size, radius and dock rules back', () => {
  const p = page();
  p.message('min', { on: true, pet: true, w: 120, h: 120 }); p.paint();
  p.message('min', { on: false, w: 200, h: 46 }); p.paint();
  assert.equal(box(p).radius, '14px');
  assert.equal(p.bot.min, 0);
  assert.equal(parseInt(box(p).w), p.bot.w);
});

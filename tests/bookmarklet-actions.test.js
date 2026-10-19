import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The bookmarklet's page actions (v9) against a small fake DOM: refs, masking, the refused fields and the
// navigation check all live in the bookmarklet, so they hold whatever the server or model asks for.
const source = fs.readFileSync(new URL('../bookmarklet.js', import.meta.url), 'utf8');
const origin = 'https://pagebot.test';

// form controls keep their value on the prototype, like the DOM, so a framework's own setter on the element (React's)
// can be told apart from the native one the bookmarklet should call
class Control { get value() { return this._value ?? ''; } set value(v) { this._value = String(v); this.nativeSets = (this.nativeSets || 0) + 1; } }
function node(tag, o = {}) {
  const e = Object.create(Control.prototype);
  const attrs = { ...(o.attrs || {}) };
  Object.assign(e, {
    tagName: tag.toUpperCase(), nodeName: tag.toUpperCase(), type: o.type ?? (tag === 'button' ? 'submit' : tag === 'input' ? 'text' : undefined),
    name: o.name || '', id: o.id || '', placeholder: o.placeholder || '', title: o.title || '', innerText: o.text || '', textContent: o.text || '',
    checked: !!o.checked, disabled: !!o.disabled, readOnly: !!o.readOnly, isContentEditable: !!o.editable, isConnected: true, multiple: false,
    labels: o.label ? [{ innerText: o.label, textContent: o.label, cloneNode() { return { textContent: o.label, querySelectorAll: () => [] }; }, getClientRects: () => o.visible === false && !o.labelShown ? [] : [{}] }] : [], form: o.form || null, parent: o.parent || null,
    style: { outline: '' }, events: [], clicks: 0, shown: o.visible !== false, hiddenStyle: !!o.hiddenStyle,
    getAttribute: k => Object.hasOwn(attrs, k) ? attrs[k] : null, hasAttribute: k => Object.hasOwn(attrs, k),
    getClientRects() { return this.shown ? [{}] : []; },
    dispatchEvent(ev) { this.events.push(ev.type); return true; },
    focus() { this.focused = true; }, scrollIntoView() { this.scrolled = true; },
    querySelector: () => null,
    closest(sel) {
      for (let x = this; x; x = x.parent) if (sel === 'a[href]' && x.tagName === 'A' && x.hasAttribute('href')) return x;
      return null;
    },
    click() {
      this.clicks++;
      if (this.tagName === 'INPUT' && (this.type === 'checkbox' || this.type === 'radio')) { this.checked = this.type === 'radio' ? true : !this.checked; this.events.push('click', 'input', 'change'); }
    },
  });
  if (o.value != null) e._value = String(o.value);
  if (tag === 'a') e.href = o.href; e.target = o.target || '';
  if (o.options) {
    e.options = o.options.map((t, i) => ({ text: Array.isArray(t) ? t[0] : t, value: Array.isArray(t) ? t[1] : t, index: i, disabled: false, get selected() { return e.selectedIndex === i; }, set selected(v) { if (v) e.selectedIndex = i; } }));
    e.selectedIndex = 0;
  }
  return e;
}
function page(elements, { texts = [], url = 'https://shop.example/cart' } = {}) {
  const listeners = new Map(), replies = [], ranges = [];
  const frameWindow = { postMessage(message) { replies.push(message); } };
  const frame = { style: { setProperty() {} }, contentWindow: frameWindow, isConnected: true, offsetWidth: 380, remove() {} };
  const textNodes = texts.map(text => { const parent = { nodeName: 'P', style: {}, scrollIntoView() { this.scrolled = true; } }; return { nodeValue: text, parentNode: parent, parentElement: parent }; });
  const isControl = e => e.tagName === 'INPUT' ? e.type !== 'hidden' : ['TEXTAREA', 'SELECT', 'BUTTON'].includes(e.tagName) || e.tagName === 'A' && e.hasAttribute('href')
    || ['button', 'link', 'checkbox', 'radio', 'switch'].includes(e.getAttribute('role')) || e.isContentEditable;
  const document = {
    body: { innerText: texts.join('\n') }, title: 'Shop', documentElement: { appendChild() {} },
    getElementById: id => elements.find(e => e.id === id) || null, createElement: () => frame, addEventListener() {},
    querySelectorAll: () => elements.filter(isControl),
    execCommand(cmd, ui, value) { const e = elements.find(x => x.focused && x.isContentEditable); if (cmd === 'insertText' && e) { e.innerText = value; e.events.push('input'); } return true; },
    createTreeWalker(root, filter, options) { const ok = textNodes.filter(n => options.acceptNode(n) === 1); let i = 0; return { nextNode: () => ok[i++] || null }; },
    createRange() {
      const r = { setStart(n, o) { this.startContainer = n; this.startOffset = o; }, setEnd(n, o) { this.endContainer = n; this.endOffset = o; }, getClientRects: () => [{}] };
      ranges.push(r); return r;
    },
  };
  const window = { innerWidth: 1200, innerHeight: 900, getSelection: () => '', addEventListener(type, handler) { listeners.set(type, handler); } };
  const context = vm.createContext({
    window, document, location: { href: url },
    getComputedStyle: e => ({ visibility: e.hiddenStyle ? 'hidden' : 'visible', backgroundColor: 'rgb(255,255,255)' }),
    Event: class { constructor(type, o) { this.type = type; this.bubbles = !!o?.bubbles; } },
    requestAnimationFrame: () => 1, setTimeout() {}, clearTimeout() {},
  });
  vm.runInContext(source.replaceAll('__ORIGIN__', origin).replaceAll('__VERSION__', '9').replace(/\n\s*/g, ''), context);
  return {
    bot: window.__pb, replies, ranges, textNodes,
    act(name, input, extra = {}) { listeners.get('message')({ origin, source: frameWindow, data: { type: 'act', id: 7, name, input, ...extra } }); return JSON.parse(JSON.stringify(replies.at(-1))); }, // as postMessage would clone it
    // the pop-up window gets answers too
    actFrom(source, name, input) { listeners.get('message')({ origin, source, data: { type: 'act', id: 8, name, input } }); },
    forged(name, input) { listeners.get('message')({ origin: 'https://evil.example', source: frameWindow, data: { type: 'act', id: 9, name, input } }); },
  };
}

function shop() {
  const form = { action: 'https://shop.example/checkout', target: '', getAttribute: k => k === 'method' ? 'post' : null };
  const els = {
    search: node('input', { placeholder: 'Search the shop', value: 'socks' }),
    pass: node('input', { type: 'password', name: 'pw', label: 'Password', value: 'hunter2' }),
    card: node('input', { attrs: { autocomplete: 'cc-number' }, label: 'Number on the front', value: '4242424242424242' }),
    cvc: node('input', { name: 'security_code', label: 'CVC', value: '123' }),
    exp: node('select', { name: 'exp_month', label: 'Expiry month', options: ['01', '02'] }),
    file: node('input', { type: 'file', label: 'Receipt' }),
    size: node('select', { label: 'Size', options: [['Small', 's'], ['Medium', 'm'], ['Large', 'l']] }),
    gift: node('input', { type: 'checkbox', label: 'Gift wrap' }),
    express: node('input', { type: 'radio', name: 'ship', label: 'Express', visible: false, labelShown: true }), // a styled radio: hidden, with a visible label
    hidden: node('input', { type: 'hidden', name: 'csrf', value: 'secret-token' }),
    gone: node('input', { label: 'Coupon', visible: false }),
    ghost: node('button', { text: 'Invisible', hiddenStyle: true }),
    off: node('button', { text: 'Sold out', disabled: true, type: 'button' }),
    add: node('button', { text: 'Add to cart', type: 'button' }),
    buy: node('button', { text: 'Place order', form }),
    reset: node('button', { text: 'Start over', type: 'reset', form }),
    note: node('div', { editable: true, attrs: { 'aria-label': 'Gift note' }, text: '' }),
    other: node('a', { href: 'https://shop.example/help', text: 'Help', attrs: { href: '/help' } }),
    top: node('a', { href: 'https://shop.example/cart#top', text: 'Back to top', attrs: { href: '#top' } }),
    tab: node('a', { href: 'https://other.example/', text: 'Partner', target: '_blank', attrs: { href: 'https://other.example/' } }),
    js: node('a', { href: 'javascript:void(0)', text: 'Menu', attrs: { href: 'javascript:void(0)' } }),
    same: node('a', { href: 'https://shop.example/cart#reviews', text: 'Reviews', attrs: { href: 'https://shop.example/cart#reviews' } }),
    reload: node('a', { href: 'https://shop.example/cart', text: 'Refresh', attrs: { href: '' } }),
  };
  els.icon = node('span', { text: 'Account', parent: els.other }); // inside a link
  return els;
}
const refOf = (list, label) => list.find(e => e.label === label)?.ref;

test('find_elements lists visible controls with stable refs, fields first, and never shows a protected value', () => {
  const els = shop(), p = page(Object.values(els));
  const r = p.act('els', {});
  assert.equal(r.id, 7);
  const list = r.els, labels = list.map(e => e.label);
  assert.ok(!labels.includes('Coupon') && !labels.includes('Invisible') && !list.some(e => e.label === 'csrf'), 'hidden controls are left out');
  assert.ok(labels.includes('Express'), 'a hidden radio with a visible label is listed');
  const firstButton = list.findIndex(e => e.role === 'button'), lastField = list.findLastIndex(e => !['button', 'link'].includes(e.role));
  assert.ok(lastField < firstButton, 'form fields come before buttons');
  assert.ok(list.findIndex(e => e.role === 'link') > list.findLastIndex(e => e.role === 'button'), 'links come last');
  const by = l => list.find(e => e.label === l);
  assert.deepEqual(by('Search the shop'), { role: 'textbox', label: 'Search the shop', ref: by('Search the shop').ref, value: 'socks' });
  assert.deepEqual([by('Password').no, by('Password').value, by('Password').type], ['password', '••••', 'password']);
  assert.deepEqual([by('Number on the front').no, by('CVC').no, by('Expiry month').no, by('Receipt').no], ['payment', 'payment', 'payment', 'file']);
  assert.equal(by('Expiry month').opts, undefined);
  const json = JSON.stringify(r);
  for (const secret of ['hunter2', '4242', '123"', 'secret-token']) assert.ok(!json.includes(secret), `never sends ${secret}`);
  assert.deepEqual([by('Size').value, by('Size').opts], ['Small', ['Small', 'Medium', 'Large']]);
  assert.equal(by('Gift wrap').checked, false);
  assert.equal(by('Sold out').off, 1);
  assert.equal(by('Gift note').role, 'textbox');
  assert.equal(by('Help').nav, 1);
  assert.equal(by('Back to top').nav, undefined);
  assert.equal(by('Place order').nav, 1);
  assert.equal(by('Add to cart').nav, undefined);
  assert.equal(r.more, 0);
  // the same elements keep their refs; a query narrows the list
  const again = p.act('els', { query: 'gift' }).els;
  assert.deepEqual(again.map(e => [e.label, e.ref]), [['Gift wrap', by('Gift wrap').ref], ['Gift note', by('Gift note').ref]]);
  assert.equal(new Set(list.map(e => e.ref)).size, list.length);
});

test('fill, select, check and click change the page the way a framework notices', () => {
  const els = shop(), p = page(Object.values(els)), list = p.act('els', {}).els;
  // a framework's own setter on the element must be skipped in favour of the native one
  let frameworkSets = 0;
  Object.defineProperty(els.search, 'value', { configurable: true, get() { return Control.prototype.__lookupGetter__('value').call(this); }, set() { frameworkSets++; } });
  let r = p.act('fill', { ref: refOf(list, 'Search the shop'), text: 'red socks' });
  assert.deepEqual([r.value, r.role, r.label], ['red socks', 'textbox', 'Search the shop']);
  assert.equal(els.search.nativeSets, 1);
  assert.equal(frameworkSets, 0);
  assert.deepEqual(els.search.events, ['input', 'change']);
  assert.ok(els.search.focused);
  r = p.act('fill', { ref: refOf(list, 'Gift note'), text: 'Happy birthday' });
  assert.equal(r.value, 'Happy birthday');
  r = p.act('select', { ref: refOf(list, 'Size'), option: 'large' });
  assert.deepEqual([r.option, els.size.selectedIndex], ['Large', 2]);
  assert.deepEqual(els.size.events, ['input', 'change']);
  assert.equal(p.act('select', { ref: refOf(list, 'Size'), option: 'm' }).option, 'Medium', 'by value too');
  assert.equal(p.act('select', { ref: refOf(list, 'Size'), option: 'Med' }).option, 'Medium', 'or the start of its text');
  r = p.act('select', { ref: refOf(list, 'Size'), option: 'Huge' });
  assert.deepEqual(r, { no: 'option', opts: ['Small', 'Medium', 'Large'], id: 7 });
  r = p.act('check', { ref: refOf(list, 'Gift wrap'), checked: true });
  assert.deepEqual([r.checked, els.gift.clicks], [true, 1]);
  assert.equal(p.act('check', { ref: refOf(list, 'Gift wrap') }).checked, true);
  assert.equal(els.gift.clicks, 1, 'already ticked: no second click');
  assert.equal(p.act('check', { ref: refOf(list, 'Gift wrap'), checked: false }).checked, false);
  assert.deepEqual(p.act('check', { ref: refOf(list, 'Express'), checked: false }), { no: 'radio', id: 7 });
  assert.equal(p.act('check', { ref: refOf(list, 'Express') }).checked, true);
  r = p.act('click', { ref: refOf(list, 'Add to cart') });
  assert.deepEqual([r.role, r.label, r.nav, els.add.clicks], ['button', 'Add to cart', '', 1]);
  // a dry run checks and describes without doing anything
  r = p.act('fill', { ref: refOf(list, 'Search the shop'), text: 'nothing' }, { dry: 1 });
  assert.deepEqual([r.role, r.label, r.nav, r.value], ['textbox', 'Search the shop', '', undefined]);
  assert.equal(els.search.nativeSets, 1);
  // scrolling to an element outlines it; wrong kinds, disabled and removed elements are refused
  assert.equal(p.act('scroll', { ref: refOf(list, 'Size') }).label, 'Size');
  assert.ok(els.size.scrolled && els.size.style.outline);
  assert.deepEqual(p.act('fill', { ref: refOf(list, 'Size'), text: 'x' }), { no: 'kind', role: 'select', id: 7 });
  assert.deepEqual(p.act('click', { ref: refOf(list, 'Sold out') }), { no: 'off', id: 7 });
  els.add.isConnected = false;
  assert.deepEqual(p.act('click', { ref: refOf(list, 'Add to cart') }), { no: 'gone', id: 7 });
  assert.deepEqual(p.act('click', { ref: 999 }), { no: 'gone', id: 7 });
});

test('password, payment card and file fields are refused whatever is asked, even without a dry run', () => {
  const els = shop(), p = page(Object.values(els)), list = p.act('els', {}).els;
  for (const [label, why] of [['Password', 'password'], ['Number on the front', 'payment'], ['CVC', 'payment']]) {
    assert.deepEqual(p.act('fill', { ref: refOf(list, label), text: 'typed' }), { no: why, id: 7 }, label);
    assert.deepEqual(p.act('fill', { ref: refOf(list, label), text: 'typed' }, { sure: 1 }), { no: why, id: 7 });
  }
  assert.deepEqual(p.act('select', { ref: refOf(list, 'Expiry month'), option: '02' }), { no: 'payment', id: 7 });
  assert.deepEqual(p.act('click', { ref: refOf(list, 'Receipt') }), { no: 'file', id: 7 });
  assert.deepEqual(p.act('scroll', { ref: refOf(list, 'Password') }).label, 'Password', 'scrolling to one is fine');
  assert.deepEqual([els.pass.value, els.card.value, els.cvc.value, els.exp.selectedIndex, els.file.clicks], ['hunter2', '4242424242424242', '123', 0, 0]);
  // payment fields found by their name, label or autocomplete; one-time codes count as passwords
  const odd = [
    node('input', { name: 'cardnumber' }), node('input', { label: 'Credit card' }), node('input', { attrs: { autocomplete: 'cc-exp' } }),
    node('input', { placeholder: 'MM / YY' }), node('input', { attrs: { autocomplete: 'one-time-code' } }), node('input', { id: 'new-password' }),
  ];
  const q = page(odd), l2 = q.act('els', {}).els;
  assert.deepEqual(l2.map(e => e.no), ['payment', 'payment', 'payment', 'payment', 'password', 'password']);
  assert.ok(l2.every(e => q.act('fill', { ref: e.ref, text: 'x' }).no));
  // nobody else can ask: other origins are ignored
  q.forged('fill', { ref: l2[0].ref, text: 'x' });
  assert.equal(q.replies.length, 1 + l2.length);
});

test('a click that leaves the page needs sure, while in-page links, new tabs and plain buttons do not', () => {
  const els = shop(), p = page(Object.values(els)), list = p.act('els', {}).els;
  let r = p.act('click', { ref: refOf(list, 'Help') }, { dry: 1 });
  assert.equal(r.nav, 'https://shop.example/help');
  assert.deepEqual(p.act('click', { ref: refOf(list, 'Help') }), { no: 'nav', nav: 'https://shop.example/help', id: 7 });
  assert.equal(els.other.clicks, 0);
  assert.equal(p.act('click', { ref: refOf(list, 'Help') }, { sure: 1 }).nav, 'https://shop.example/help');
  assert.equal(els.other.clicks, 1);
  assert.equal(p.act('click', { ref: refOf(list, 'Place order') }, { dry: 1 }).nav, 'https://shop.example/checkout', 'a submit button in a form');
  assert.deepEqual(p.act('click', { ref: refOf(list, 'Place order') }).no, 'nav');
  for (const label of ['Back to top', 'Partner', 'Menu', 'Reviews', 'Add to cart', 'Start over']) {
    assert.equal(p.act('click', { ref: refOf(list, label) }).nav, '', label);
  }
  assert.equal(p.act('click', { ref: refOf(list, 'Refresh') }, { dry: 1 }).nav, 'https://shop.example/cart', 'reloading counts');
  // inside a link counts as the link
  const q = page([els.other, els.icon]);
  q.bot.refs.push(els.icon);
  assert.equal(q.act('click', { ref: q.bot.refs.length }, { dry: 1 }).nav, 'https://shop.example/help');
  // a dialog form doesn't navigate
  const dialog = node('button', { text: 'Close', form: { action: 'x', target: '', getAttribute: k => k === 'method' ? 'dialog' : null } });
  const d = page([dialog]);
  assert.equal(d.act('click', { ref: d.act('els', {}).els[0].ref }).nav, '');
  assert.equal(dialog.clicks, 1);
});

test('highlight marks several passages at once and reports which it found; the pop-up window gets answers too', () => {
  const p = page([], { texts: ['The first passage is here.', 'Another passage follows.'] });
  const r = p.act('hl', { quotes: ['first passage', 'not on the page', 'Another passage'] });
  assert.deepEqual(r.found, [1, 0, 1]);
  assert.ok(p.textNodes[0].parentNode.scrolled, 'scrolls to the first');
  assert.ok(!p.textNodes[1].parentNode.scrolled, 'and only the first');
  assert.equal(p.act('scroll', { quote: 'Another passage' }).found, 1);
  const pop = { postMessage(m) { this.got = m; } };
  p.actFrom(pop, 'els', {});
  assert.deepEqual(JSON.parse(JSON.stringify(pop.got)), { els: [], more: 0, id: 8 });
});

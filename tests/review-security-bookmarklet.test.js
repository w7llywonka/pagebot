import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Review of the bookmarklet's page actions: how a page's markup can (and can't) get past the protected-field and navigation checks.
// The same small fake DOM as bookmarklet-actions.test.js; the fake form's properties are shadowed the way a field named "target" shadows them.
const source = fs.readFileSync(new URL('../bookmarklet.js', import.meta.url), 'utf8');
const origin = 'https://pagebot.test';

// form controls keep their value on the prototype, like the DOM, so a framework's own setter on the element (React's)
// can be told apart from the native one the bookmarklet should call
class Control { get value() { return this._value ?? ''; } set value(v) { this._value = String(v); this.nativeSets = (this.nativeSets || 0) + 1; } }
function node(tag, o = {}) {
  const e = Object.create(Control.prototype);
  const attrs = { ...(o.attrs || {}), ...(o.target && { target: o.target }) };
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
function page(elements, { texts = [], url = 'https://shop.example/cart', dots = new Set(), byId = {} } = {}) {
  const listeners = new Map(), replies = [], ranges = [];
  const frameWindow = { postMessage(message) { replies.push(message); } };
  const frame = { style: { setProperty() {} }, contentWindow: frameWindow, isConnected: true, offsetWidth: 380, remove() {} };
  const textNodes = texts.map(text => { const parent = { nodeName: 'P', style: {}, scrollIntoView() { this.scrolled = true; } }; return { nodeValue: text, parentNode: parent, parentElement: parent }; });
  const isControl = e => e.tagName === 'INPUT' ? e.type !== 'hidden' : ['TEXTAREA', 'SELECT', 'BUTTON'].includes(e.tagName) || e.tagName === 'A' && e.hasAttribute('href')
    || ['button', 'link', 'checkbox', 'radio', 'switch'].includes(e.getAttribute('role')) || e.isContentEditable;
  const document = {
    body: { innerText: texts.join('\n') }, title: 'Shop', documentElement: { appendChild() {} },
    getElementById: id => byId[id] || elements.find(e => e.id === id) || null, createElement: () => frame, addEventListener() {},
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
    window, document, location: { href: url }, URL,
    getComputedStyle: e => ({ visibility: e.hiddenStyle ? 'hidden' : 'visible', backgroundColor: 'rgb(255,255,255)', webkitTextSecurity: dots.has(e) ? 'disc' : 'none' }),
    Event: class { constructor(type, o) { this.type = type; this.bubbles = !!o?.bubbles; } },
    requestAnimationFrame: () => 1, setTimeout() {}, clearTimeout() {},
  });
  vm.runInContext(source.replaceAll('__ORIGIN__', origin).replaceAll('__VERSION__', '10').replace(/\n\s*/g, ''), context);
  return {
    bot: window.__pb, replies, ranges, textNodes,
    act(name, input, extra = {}) { listeners.get('message')({ origin, source: frameWindow, data: { type: 'act', id: 7, name, input, ...extra } }); return JSON.parse(JSON.stringify(replies.at(-1))); }, // as postMessage would clone it
    // the pop-up window gets answers too
    actFrom(source, name, input) { listeners.get('message')({ origin, source, data: { type: 'act', id: 8, name, input } }); },
    forged(name, input) { listeners.get('message')({ origin: 'https://evil.example', source: frameWindow, data: { type: 'act', id: 9, name, input } }); },
  };
}


const refOf = (list, label) => list.find(e => e.label === label)?.ref;
const clobber = { toString: () => '[object HTMLInputElement]' }; // what form.target / form.action give back when a field is named that
const form = (o = {}) => ({ action: clobber, target: clobber, getAttribute: k => o[k] ?? null });
// (the page itself is https://shop.example/cart)

test('a submit button is judged by its own formaction/formtarget, and a field named "target" or "action" does not hide a navigation', () => {
  const f = form({ method: 'post', action: '/checkout' });
  const els = {
    cancel: node('button', { text: 'Cancel', form: f }), // a plain submit button; the form's properties are shadowed
    elsewhere: node('button', { text: 'Pay', form: f, attrs: { formaction: 'https://evil.example/collect' } }),
    popup: node('button', { text: 'Pop', form: f, attrs: { formaction: 'https://evil.example/collect', formtarget: '_blank' } }),
    local: node('button', { text: 'Local', form: f, attrs: { formtarget: '_blank' } }),
    submitInput: node('input', { type: 'submit', name: 'go', form: f, attrs: { value: 'x' } }),
    dialog: node('button', { text: 'Close', form: f, attrs: { formmethod: 'dialog' } }),
  };
  const p = page(Object.values(els)), list = p.act('els', {}).els, dry = l => p.act('click', { ref: refOf(list, l) }, { dry: 1 });
  assert.equal(dry('Cancel').nav, 'https://shop.example/checkout', 'shadowed form properties no longer make a submit look harmless');
  assert.equal(dry('Pay').nav, 'https://evil.example/collect', 'the button’s own formaction is where it goes');
  assert.equal(p.act('click', { ref: refOf(list, 'Pay') }).no, 'nav');
  assert.equal(els.elsewhere.clicks, 0);
  const pop = dry('Pop');
  assert.deepEqual([pop.nav, pop.tab], ['', 'https://evil.example/collect'], 'a submit into a new tab on another site is a tab');
  assert.deepEqual(dry('Local').tab, undefined, 'a new tab on the same site is fine');
  assert.equal(p.act('click', { ref: refOf(list, 'Local') }).nav, '');
  assert.equal(dry('Close').nav, '', 'formmethod=dialog does not navigate');
  assert.equal(list.find(e => e.label === 'Cancel').nav, 1);
  assert.equal(list.find(e => e.label === 'Pop').tab, 1);
});

test('a link to another site in a new tab asks, the approved address is bound to the click, and javascript: links that do something ask', () => {
  const els = {
    far: node('a', { href: 'https://evil.example/login', text: 'Learn more', target: '_blank', attrs: { href: 'https://evil.example/login' } }),
    near: node('a', { href: 'https://shop.example/help', text: 'Help', target: '_blank', attrs: { href: '/help' } }),
    named: node('a', { href: 'https://evil.example/x', text: 'Named', target: 'someframe', attrs: { href: 'https://evil.example/x' } }),
    top: node('a', { href: 'https://evil.example/y', text: 'Top', target: '_top', attrs: { href: 'https://evil.example/y' } }),
    script: node('a', { href: 'javascript:location=1', text: 'Go', attrs: { href: 'javascript:location="https://evil.example"' } }),
    void: node('a', { href: 'javascript:void(0)', text: 'Menu', attrs: { href: ' javascript:void(0);' } }),
    download: node('a', { href: 'https://shop.example/a.pdf', text: 'Get PDF', attrs: { href: '/a.pdf', download: '' } }),
    farDownload: node('a', { href: 'https://evil.example/a.pdf', text: 'Get it', attrs: { href: 'https://evil.example/a.pdf', download: '' } }),
  };
  const p = page(Object.values(els)), list = p.act('els', {}).els;
  const by = l => list.find(e => e.label === l);
  assert.deepEqual([by('Learn more').tab, by('Learn more').nav], [1, undefined]);
  assert.deepEqual([by('Help').tab, by('Help').nav], [undefined, undefined]);
  assert.equal(by('Named').tab, 1);
  assert.equal(by('Top').nav, 1);
  assert.equal(by('Go').nav, 1);
  assert.equal(by('Menu').nav, undefined);
  assert.equal(by('Get PDF').nav, undefined);
  assert.equal(by('Get it').nav, 1, 'a download from another site just navigates');
  // the other site's tab needs sure, and then opens
  assert.deepEqual(p.act('click', { ref: by('Learn more').ref }), { no: 'tab', tab: 'https://evil.example/login', id: 7 });
  assert.equal(els.far.clicks, 0);
  assert.equal(p.act('click', { ref: by('Learn more').ref }, { dry: 1 }).tab, 'https://evil.example/login');
  assert.equal(p.act('click', { ref: by('Learn more').ref }, { sure: 1 }).tab, 'https://evil.example/login');
  assert.equal(els.far.clicks, 1);
  // sure can name the address that was approved; a link that has changed where it goes since asks again
  assert.equal(p.act('click', { ref: by('Named').ref }, { sure: 'https://evil.example/x' }).tab, 'https://evil.example/x');
  els.near.clicks = 0;
  assert.equal(p.act('click', { ref: by('Go').ref }, { sure: 'https://other.example/' }).no, 'nav');
  assert.equal(p.act('click', { ref: by('Go').ref }, { sure: 'javascript:' }).nav, 'javascript:');
  assert.equal(els.script.clicks, 1);
  assert.equal(p.act('click', { ref: by('Help').ref }).tab, undefined);
});

test('protected fields are found by any label, by dots drawn over text, and by common card and code names', () => {
  const byId = { pwlabel: { textContent: 'Your password' }, cardlabel: { textContent: 'Card number' } };
  const odd = [
    node('input', { attrs: { 'aria-labelledby': 'pwlabel' } }),
    node('input', { attrs: { 'aria-labelledby': 'cardlabel' } }),
    node('input', { name: 'cc_number' }), node('input', { name: 'ccnumber' }), node('input', { id: 'billing_ccexp' }), node('input', { name: 'cc-csc' }),
    node('input', { title: 'Password (again)' }), node('input', { name: 'otp' }), node('input', { placeholder: 'PIN' }), node('input', { name: 'client_secret' }),
    node('input', { name: 'dots' }), node('div', { editable: true, attrs: { 'aria-label': 'Digits' } }),
    node('input', { name: 'cc', placeholder: 'CC these people' }), node('input', { placeholder: '1234 5678 9012 3456' }), node('input', { placeholder: 'Phone 555 1234 5678' }), node('input', { name: 'ship_pincode' }), node('input', { name: 'spinner' }),
  ];
  const p = page(odd, { dots: new Set([odd[10], odd[11]]), byId });
  const l = p.act('els', {}).els;
  assert.deepEqual(l.map(e => e.no || ''), ['password', 'payment', 'payment', 'payment', 'payment', 'payment', 'password', 'password', 'password', 'password', 'password', 'password', '', 'payment', '', '', ''],
    'aria-labelledby, titles, codes and secrets, card names with underscores, text drawn as dots; a plain "cc" box is left alone');
  for (const e of l.slice(0, 12)) assert.ok(p.act('fill', { ref: e.ref, text: 'x' }).no, e.ref);
  assert.ok(odd.slice(0, 12).every(e => !e.nativeSets && !e.events.length));
});

test('the dry run says what the control itself shows when that is not the label the model saw', () => {
  const buy = node('button', { text: 'Pay $500 now', attrs: { 'aria-label': 'Cancel' }, type: 'button' });
  const same = node('button', { text: 'Save', type: 'button' }), field = node('input', { placeholder: 'Search', value: 'x' });
  const p = page([buy, same, field]), list = p.act('els', {}).els;
  const r = p.act('click', { ref: refOf(list, 'Cancel') }, { dry: 1 });
  assert.deepEqual([r.label, r.text], ['Cancel', 'Pay $500 now']);
  assert.equal(p.act('click', { ref: refOf(list, 'Save') }, { dry: 1 }).text, undefined);
  assert.equal(p.act('fill', { ref: refOf(list, 'Search'), text: 'y' }, { dry: 1 }).text, undefined);
});

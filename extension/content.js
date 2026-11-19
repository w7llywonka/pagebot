// pagebot extension: its own part of the page side. lib/extension.js puts this inside the function that wraps the
// bookmark's page-action code (bookmarklet.js), so W, D and P are that code's window, document and helpers: P.bad
// (protected fields), P.go (where a click goes), P.act (click and fill), P.tool (the page tree, find, scrolling), P.at.
// It answers only pagebot's own side panel page (chrome.runtime messages with that sender), never the page itself: there
// is no window message listener here and nothing the page can call.

// After the extension is reloaded or updated, an old copy can't talk to it anymore; a fresh copy takes over.
P.alive = function () { try { return !!chrome.runtime.id; } catch (e) { return false; } };
// Refs can't outlive their page. Each new document in a tab numbers its refs from its own block (ref_100001, then
// ref_200001 after the next page loads, ...), set by the side panel just before this runs, so a ref from a page that's
// gone never names something on this one: P.el finds nothing there and the model hears it's gone.
P.refs.length = (W.__pbxGen | 0) * 100000;

// ---- what you highlight goes to the side panel, as the bookmark sends it to its panel ----
P.lastSel = null;
if (W === W.top) D.addEventListener('selectionchange', function () {
  clearTimeout(P.sd2);
  P.sd2 = setTimeout(function () {
    if (!P.alive()) return;
    var x = String(W.getSelection() || '').trim().slice(0, 8000);
    if (x === P.lastSel) return;
    P.lastSel = x;
    try { chrome.runtime.sendMessage({ t: 'sel', text: x }).catch(function () {}); } catch (e) {}
  }, 160);
});

// ---- facts about what's under a point, what has the keyboard, and where a ref is ----
// an element inside another, through open shadow roots
P.within = function (h, e) { while (h) { if (h === e) return true; h = h.parentNode || h.host; } return false; };
// the control a click lands on: the link, button, field or label around what's under the pointer
P.ctl = function (e) {
  var c = e.closest && e.closest('a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable=true]');
  c = c || e;
  return c.tagName === 'LABEL' && c.control ? c.control : c;
};
P.facts = function (e) {
  var c = P.ctl(e), ro = P.rl(c) || P.rl(e) || 'generic', g = P.go(c), b = P.bad(c), r = { role: ro, label: P.nm(c, ro) || '', nav: g.nav.slice(0, 300) };
  if (g.tab) r.tab = g.tab.slice(0, 300);
  if (b) r.prot = b;
  return r;
};
// a viewport point (CSS pixels of this window): what's there, whether it's a frame from another site or a drawing the
// page can't describe, and where a click there would go. A file picker is never clicked.
P.point = function (x, y) {
  var a = P.at(+x, +y), e = a && a.e, r;
  if (!e) return { role: 'generic', label: '', nav: '' };
  r = P.facts(e);
  // P.at goes into frames it can read, so a frame left here is another site's (an <object> or <embed> can hold a page too)
  if (/^(I?FRAME|OBJECT|EMBED)$/.test(e.tagName)) r.frame = 'cross';
  else if (/^(CANVAS|VIDEO)$/.test(e.tagName)) r.media = true;
  if (r.prot === 'file') r.no = 'file';
  return r;
};
// a ref's centre, scrolled into view, and only if a click there would really land on it (not on something covering it)
P.center = function (ref) {
  var e = P.el(ref), r, x, y, a, h, f;
  if (!e || !P.vis(e)) return { no: 'gone' };
  if (e.scrollIntoView) e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  r = P.rect(e);
  x = Math.round(Math.min(Math.max(r.left + r.width / 2, 1), W.innerWidth - 2));
  y = Math.round(Math.min(Math.max(r.top + r.height / 2, 1), W.innerHeight - 2));
  a = P.at(x, y); h = a && a.e;
  f = P.facts(e);
  if (!h || !(P.within(h, e) || [].some.call(e.labels || [], function (l) { return P.within(h, l); }))) return { no: 'covered', by: h ? P.facts(h).label : '' };
  if (f.prot === 'file') return { no: 'file' };
  f.x = x; f.y = y;
  return f;
};
// typing lands here
P.editable = function (e) {
  if (e.disabled || e.readOnly) return false;
  if (e.isContentEditable || e.tagName === 'TEXTAREA') return true;
  return e.tagName === 'INPUT' && !/^(button|submit|reset|image|checkbox|radio|file|hidden|range|color)$/i.test(e.type || '');
};
// where a form goes when it's submitted with Enter (P.go's form rule, for the form itself)
P.fgo = function (f) {
  var u = f.getAttribute('action') || '', g = f.getAttribute('target'), r = { nav: '', tab: '' };
  if (/^dialog$/i.test(f.getAttribute('method') || '')) return r;
  try { u = new URL(u, D.baseURI || location.href).href; } catch (z) { u = location.href; }
  if (g && !/^_(self|top|parent)$/i.test(g)) { try { if (new URL(u).origin !== location.origin) r.tab = u; } catch (z) { r.tab = u; } } else r.nav = u;
  return r;
};
// An element's shadow root, closed ones too: an extension may look inside them (chrome.dom), so a password field a page
// keeps in a closed shadow root is still seen, and still refused.
P.sroot = function (e) {
  var s = e && e.shadowRoot;
  if (!s && e && e.nodeType === 1) { try { s = chrome.dom.openOrClosedShadowRoot(e); } catch (x) { s = null; } }
  return s || null;
};
// a name for an element that lasts while this page does, so the side panel can tell whether the keyboard is still where
// the person approved typing (a random part per page, so one page's numbers never match another's)
P.fids = new WeakMap(); P.fidN = 0; P.fidDoc = Math.random().toString(36).slice(2, 10);
P.fid = function (e) { var v = P.fids.get(e); if (!v) { v = P.fidDoc + '.' + (++P.fidN); P.fids.set(e, v); } return v; };
// what has the keyboard: the deep active element (through shadow roots, open or closed, and frames this page can read). A
// protected field is refused, with its value never read; a frame from another site (or an <object> or <embed>, which can
// hold one) is checked inside that frame instead. The answer says which page it came from, and whether that page has focus.
P.focus = function () {
  var e = D.activeElement, d, s, ro, b, r, g, at = { hasFocus: D.hasFocus(), url: String(location.href).slice(0, 300) };
  for (;;) {
    if (!e) break;
    s = P.sroot(e);
    if (s && s.activeElement) { e = s.activeElement; continue; }
    if (/^(I?FRAME|OBJECT|EMBED)$/.test(e.tagName)) { try { d = e.contentDocument; } catch (x) { d = null; } if (d) { e = d.activeElement; continue; } at.frame = 'cross'; return at; }
    break;
  }
  if (!e || /^(BODY|HTML)$/.test(e.tagName)) { at.role = 'document'; at.label = ''; at.nav = ''; at.none = 1; at.fid = P.fidDoc + '.0'; return at; }
  ro = P.rl(e) || 'generic'; b = P.bad(e); r = { role: ro, label: P.nm(e, ro) || '', nav: '', fid: P.fid(e), hasFocus: at.hasFocus, url: at.url };
  if (b) { r.no = b; return r; }
  r.edit = P.editable(e);
  if (r.edit) r.value = P.tx(e.isContentEditable ? e.innerText : e.value, 100);
  g = P.go(e);
  if (!g.nav && !g.tab && e.form && e.tagName === 'INPUT' && r.edit) { // Enter in a field submits its form
    s = e.form.querySelector('button:not([type=button]):not([type=reset]),input[type=submit],input[type=image]');
    g = s ? P.go(s) : P.fgo(e.form);
  }
  r.nav = (g.nav || '').slice(0, 300);
  if (g.tab) r.tab = g.tab.slice(0, 300);
  return r;
};
// The page's own record of what it loaded (the Performance API: no debugger needed, and it covers the whole page load),
// since the last read. Addresses lose their query string and #hash: those often carry tokens.
P.netMark = 0;
P.net = function () {
  var all = performance.getEntriesByType('navigation').concat(performance.getEntriesByType('resource')), out = [], i, e, u, st, sz;
  for (i = P.netMark; i < all.length && out.length < 200; i++) {
    e = all[i];
    try { u = new URL(e.name); u = u.origin + u.pathname; } catch (x) { u = String(e.name).split(/[?#]/)[0]; }
    st = e.responseStatus || '?';
    sz = e.transferSize === 0 && e.decodedBodySize > 0 ? 'cached' : e.transferSize != null ? e.transferSize + ' B' : '';
    out.push((st + ' ' + (e.initiatorType || e.entryType) + ' ' + u + ' ' + Math.round(e.duration) + ' ms ' + sz).trim().slice(0, 300));
  }
  var more = all.length - i;
  P.netMark = i;
  return { text: out.join('\n'), n: out.length, more: more };
};
// is anything protected filled in (a password, a card number)? javascript_exec doesn't run while one is.
P.guard = function () {
  var filled = false;
  function scan(root) {
    var s = root.querySelectorAll('*'), i, e, b, d;
    for (i = 0; i < s.length && !filled; i++) {
      e = s[i];
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) || e.isContentEditable) { b = P.bad(e); if (b && b !== 'file' && (e.value || e.isContentEditable && P.tx(e.innerText))) filled = true; }
      d = P.sroot(e);
      if (d) scan(d);
      if (/^(I?FRAME|OBJECT)$/.test(e.tagName)) { try { d = e.contentDocument; } catch (x) { d = null; } if (d && d.documentElement) scan(d); }
    }
  }
  scan(D);
  return { filled: filled };
};
// where the page is scrolled, at a point and around it (compared before and after a wheel turn)
P.sig = function (x, y) {
  var a = P.at(+x, +y), e = a && a.e, s = [W.scrollX, W.scrollY];
  while (e) { if (e.nodeType === 1 && (e.scrollTop || e.scrollLeft)) s.push(e.scrollTop, e.scrollLeft); e = e.parentNode && e.parentNode.nodeType === 11 ? e.parentNode.host : e.parentNode; }
  return { sig: s.join(',') };
};

// ---- the side panel's requests ----
P.ask = function (m) {
  switch (m.t) {
    case 'ping': return { ok: 1, pdf: D.contentType === 'application/pdf', top: W === W.top };
    case 'page': { var x = m.max > 0 && m.max <= 1 ? '' : D.body ? D.body.innerText : ''; return { page: { url: location.href, title: D.title, text: x.slice(0, Math.min(m.max || 20000, 400000)) }, selection: String(W.getSelection() || '').trim().slice(0, 8000) }; }
    case 'find': { var ok = 0; try { ok = P.find(String(m.text || '').slice(0, 4000)); } catch (z) {} return { found: ok }; }
    case 'act': try { return P.act(m.d && typeof m.d === 'object' ? m.d : {}); } catch (z) { return { no: 'err', why: String(z && z.message || z).slice(0, 200) }; }
    case 'tool': return P.tool(String(m.name || ''), m.input && typeof m.input === 'object' ? m.input : {});
    case 'point': return P.point(m.x, m.y);
    case 'center': return P.center(m.ref);
    case 'focus': return P.focus();
    case 'net': return P.net();
    case 'guard': return P.guard();
    case 'sig': return P.sig(m.x, m.y);
  }
  return { error: 'The page doesn’t know that.' };
};
chrome.runtime.onMessage.addListener(function (m, sender, reply) {
  // only pagebot's side panel page (the ?win= form too): not another tab's copy of this script, and never a web page
  if (!P.alive() || sender.id !== chrome.runtime.id || String(sender.url || '').indexOf(chrome.runtime.getURL('sidepanel.html')) !== 0) return;
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
  var r;
  try { r = P.ask(m); } catch (z) { r = { error: 'It went wrong on the page: ' + String(z && z.message || z).slice(0, 200) }; }
  reply(r);
});

// Reads the panel's real colour tokens out of its <style> blocks, the way the cascade applies them, and measures WCAG contrast.
// No browser: every `:root…{--x:…}` rule is applied in source order to the themes it names (`:root` alone is the default,
// ember), with var() resolved. Glass and Clear are see-through, so their pairs are measured over a stated backing.

const SEL = /^:root(?:\[data-theme=([a-z]+)\])?(?:\[data-page=(light)\])?$/;

// every rule whose selectors are all plain theme selectors, in source order: [{ targets: [[theme|null, page|null]], decls: {name: value} }]
export function tokenRules(html) {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  // only top-level rules (the token rules are never inside @media)
  let depth = 0, start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') { if (depth === 0) { rules.push({ sel: css.slice(start, i).trim(), at: i + 1 }); } depth++; }
    else if (css[i] === '}') { depth--; if (depth === 0) { rules.at(-1).body = css.slice(rules.at(-1).at, i); start = i + 1; } }
  }
  const out = [];
  for (const { sel, body } of rules) {
    if (!sel || sel.startsWith('@') || body == null) continue;
    const parts = sel.split(',').map(s => s.trim());
    const targets = parts.map(s => SEL.exec(s));
    if (targets.some(t => !t)) continue;
    const decls = {};
    for (const d of body.split(';')) { const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d); if (m) decls[m[1]] = m[2]; }
    if (Object.keys(decls).length) out.push({ targets: targets.map(t => [t[1] || null, t[2] || null]), decls });
  }
  return out;
}

// the tokens of one theme (and page brightness, for glass and clear), with var() resolved
export function themeTokens(rules, theme, page = null) {
  const v = {};
  // by specificity first (:root, then :root[data-theme], then with [data-page]), then by source order
  const tier = ([t, p]) => (t ? 1 : 0) + (p ? 1 : 0);
  for (const level of [0, 1, 2]) for (const r of rules) {
    if (r.targets.some(x => tier(x) === level && (x[0] === null || x[0] === theme) && (x[1] === null || x[1] === page))) Object.assign(v, r.decls);
  }
  const resolve = (val, seen = new Set()) => val.replace(/var\((--[\w-]+)(?:,\s*([^)]*))?\)/g, (_, n, fb) => {
    if (seen.has(n)) return fb || '';
    return v[n] != null ? resolve(v[n], new Set([...seen, n])) : (fb || '');
  });
  const out = {};
  for (const k of Object.keys(v)) out[k] = resolve(v[k]);
  return out;
}

export function parseColor(c) {
  c = c.trim().toLowerCase();
  if (c === 'transparent') return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{3,8})$/.exec(c);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map(x => x + x).join('');
    const n = [0, 2, 4, 6].map(i => parseInt(h.slice(i, i + 2) || 'ff', 16));
    return [n[0], n[1], n[2], n[3] / 255];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(c);
  if (m) {
    const nums = m[1].split(/[\s,/]+/).filter(Boolean).map(x => x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x));
    return [nums[0], nums[1], nums[2], nums[3] ?? 1];
  }
  throw new Error('not a colour: ' + c);
}
// a see-through colour laid over an opaque one
export const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
const lum = ([r, g, b]) => { const f = x => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
export const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };

// text pairs need 4.5:1; outlines of fields and controls (and the accent used as a control) need 3:1
export const TEXT_PAIRS = [
  ['--text', '--bg'], ['--text', '--panel'], ['--text', '--tint'], ['--text', '--user'], ['--text', '--code'], ['--text', '--chip-on'], ['--text', '--err-tint'], ['--text', '--warn-tint'],
  ['--muted', '--bg'], ['--muted', '--panel'], ['--muted', '--tint'], ['--muted', '--chip-on'], ['--muted', '--code'], ['--muted', '--user'],
  ['--accent', '--bg'], ['--accent', '--panel'], ['--accent', '--tint'], ['--on-accent', '--accent'],
  ['--err', '--bg'], ['--err', '--panel'], ['--err', '--err-tint'], ['--warn', '--panel'], ['--warn', '--warn-tint'],
];
export const EDGE_PAIRS = [['--edge', '--bg'], ['--edge', '--panel'], ['--accent', '--bg'], ['--accent', '--panel']];

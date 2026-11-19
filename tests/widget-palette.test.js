import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { tokenRules, themeTokens, parseColor, over, ratio, TEXT_PAIRS, EDGE_PAIRS } from './helpers/palette.mjs';

// Every theme's real colour tokens, read out of public/widget.html (no browser): 4.5:1 for every text pair, 3:1 for field
// outlines and the accent as a control. Glass and Clear are see-through, so they are measured over what is behind them:
// Clear's words sit on their own backing (--pop); Glass's on the panel's tint over a light grey picture (a dark page) or
// a dark grey one (a light page).
const widget = await readFile(new URL('../public/widget.html', import.meta.url), 'utf8');
const rules = tokenRules(widget);
const SOLID = [...widget.slice(widget.indexOf('const THEMES = ['), widget.indexOf('const light = matchMedia')).matchAll(/^\s*\['([a-z]+)', '[^']+', '#/gm)].map(m => m[1]);

function failures(name, t, base) {
  const out = [];
  const col = n => { if (t[n] == null) throw new Error(`${name}: ${n} is not defined`); const c = parseColor(t[n]); return c[3] < 1 ? over(c, base(n)) : c; };
  for (const [fg, bg] of TEXT_PAIRS) { const r = ratio(col(fg), col(bg)); if (!(r >= 4.5)) out.push(`${name}: ${fg} on ${bg} is ${r.toFixed(2)}, needs 4.5`); }
  for (const [fg, bg] of EDGE_PAIRS) { const r = ratio(col(fg), col(bg)); if (!(r >= 3)) out.push(`${name}: ${fg} on ${bg} is ${r.toFixed(2)}, needs 3`); }
  return out;
}

test('the palette reads the real tokens: all eleven solid themes are listed and fully defined', () => {
  assert.deepEqual(SOLID, ['ember', 'paper', 'midnight', 'forest', 'dusk', 'sakura', 'terminal', 'pond', 'orbit', 'void', 'arcade']);
  for (const name of SOLID) {
    const t = themeTokens(rules, name);
    for (const n of ['--bg', '--panel', '--tint', '--user', '--code', '--chip-on', '--line', '--edge', '--text', '--muted', '--accent', '--on-accent', '--err', '--warn', '--err-tint', '--warn-tint'])
      assert.ok(t[n] && parseColor(t[n])[3] === 1, `${name} ${n} is an opaque colour (${t[n]})`);
  }
});

test('every solid theme passes 4.5:1 for text and 3:1 for control outlines', () => {
  const bad = SOLID.flatMap(name => { const t = themeTokens(rules, name); return failures(name, t, () => parseColor(t['--bg'])); });
  assert.deepEqual(bad, []);
});

test('Glass and Clear stay readable over the page behind them', () => {
  const bodyBg = sel => { const all = [...widget.matchAll(new RegExp(sel.replace(/[[\]]/g, '\\$&') + ' body\\{background:([^;}]+)[;}]', 'g'))]; return parseColor(all.at(-1)[1]); };
  const bad = [];
  for (const page of [null, 'light']) {
    const behind = page ? [64, 64, 64, 1] : [192, 192, 192, 1]; // a dark grey picture on a light page, a light grey one on a dark page
    // Glass: everything sits on the body's tint, laid over the page
    const g = themeTokens(rules, 'glass', page), glassBase = over(bodyBg(page ? ':root[data-theme=glass][data-page=light]' : ':root[data-theme=glass]'), behind);
    bad.push(...failures('glass' + (page ? '/light page' : ''), { ...g, '--bg': 'transparent' }, () => glassBase));
    // Clear: the words carry their own backing (--pop), so the panel's own colours are measured on it
    const c = themeTokens(rules, 'clear', page), pop = over(parseColor(c['--pop']), behind);
    bad.push(...failures('clear' + (page ? '/light page' : ''), { ...c, '--bg': c['--pop'], '--panel': c['--pop'] }, () => pop));
  }
  assert.deepEqual(bad, []);
});

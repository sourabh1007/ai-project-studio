import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCENT_KEYS, resolveAccent } from '../lib/accent.js';
import { IDE_PALETTES } from '../lib/terminal-schemes.js';

/*
 * Composed contrast for default palettes only: foregrounds are resolved the
 * way the CSS does (sRGB color-mix / alpha tint over the real surface). User
 * accents are deliberately out of scope (see lib/accent.test.ts).
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const tokens = `\n${read(join(here, 'design-tokens.css'))}`;
const app = `\n${read(join(here, 'app.css'))}`;

type Rgb = [number, number, number];
const hex = (value: string): Rgb => {
  const h = value.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
};
const lum = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const blend = (fg: Rgb, bg: Rgb, alpha: number): Rgb =>
  fg.map((v, i) => v * alpha + bg[i]! * (1 - alpha)) as Rgb;

function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`missing block ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}

const root = block(tokens, ':root');
const light = { ...root, ...block(tokens, ":root,\n[data-theme='light']") };
const dark = { ...root, ...block(tokens, "[data-theme='dark']") };
const VARIANTS: Record<string, { dark: boolean; t: Record<string, string> }> = {
  light: { dark: false, t: light },
  dark: { dark: true, t: dark },
  'clarity-light': { dark: false, t: { ...light, ...block(tokens, "[data-appearance='clarity'][data-theme='light']") } },
  'clarity-dark': { dark: true, t: { ...dark, ...block(tokens, "[data-appearance='clarity'][data-theme='dark']") } },
  'futuristic-light': { dark: false, t: { ...light, ...block(tokens, "[data-appearance='futuristic'][data-theme='light']") } },
  'futuristic-dark': { dark: true, t: { ...dark, ...block(tokens, "[data-appearance='futuristic'][data-theme='dark']") } },
};
const PALETTE_VARIANTS = IDE_PALETTES.filter((palette) => palette !== 'default').flatMap((palette) =>
  (['light', 'dark'] as const).map((theme) => {
    const t = { ...(theme === 'dark' ? dark : light), ...block(tokens, `[data-palette='${palette}'][data-theme='${theme}']`) };
    VARIANTS[`${palette}-${theme}`] = { dark: theme === 'dark', t };
    return { palette, theme, t };
  }));
const SURFACES = ['--surface', '--surface-strong', '--panel', '--panel-sidebar', '--panel-inset', '--panel-editor'];
const planner = block(app, ':root');
const plannerDark = block(app, "[data-theme='dark']");

interface Row { label: string; variant: string; value: number; min: number }
const rows: Row[] = [];

function record(label: string, variant: string, fg: Rgb, bg: Rgb, min: number): void {
  rows.push({ label, variant, value: Math.round(ratio(fg, bg) * 100) / 100, min });
}

/** Text over an optional alpha tint, over each default surface. */
function onSurfaces(label: string, fg: (t: Record<string, string>, dark: boolean) => Rgb,
  tint?: { color: string; alpha: number }): void {
  for (const [variant, { dark: isDark, t }] of Object.entries(VARIANTS)) {
    for (const surface of SURFACES) {
      const base = hex(t[surface]!);
      const bg = tint ? blend(hex(tint.color), base, tint.alpha) : base;
      record(`${label} on ${surface}`, variant, fg(t, isDark), bg, 4.5);
    }
  }
}
const token = (name: string) => (t: Record<string, string>): Rgb => hex(t[name]!);
const mixWithText = (color: string, pct: number) => (t: Record<string, string>): Rgb =>
  blend(hex(color), hex(t['--text']!), pct);

// Status-bar text. Busy no longer uses --accent (it equalled the bar in light).
for (const [variant, { t }] of Object.entries(VARIANTS)) {
  const bar = hex(t['--statusbar-bg']!);
  record('statusbar error label', variant, hex('#ffc9c4'), bar, 4.5);
  record('statusbar busy label (statusbar-fg)', variant, hex(t['--statusbar-fg']!), bar, 4.5);
  record('statusbar error dot (non-text)', variant, hex('#ffa198'), bar, 3);
}

for (const kind of ['review', 'agent', 'session']) {
  for (const [variant, { dark: isDark, t }] of Object.entries(VARIANTS)) {
    const map = isDark ? plannerDark : planner;
    const fill = hex(planner[`--kind-${kind}`]!);
    record(`planner ${kind} white on fill`, variant, hex('#ffffff'), fill, 4.5);
    for (const surface of SURFACES) {
      const base = hex(t[surface]!);
      record(`planner ${kind} chip text on ${surface}`, variant, hex(map[`--kind-${kind}-text`]!),
        blend(fill, base, 0.14), 4.5);
    }
  }
}
onSurfaces('planner summary date (agent)', (_t, d) => hex((d ? plannerDark : planner)['--kind-agent-text']!),
  { color: planner['--kind-agent']!, alpha: 0.12 });
onSurfaces('automation mode long', mixWithText('#38bdf8', 0.45), { color: '#38bdf8', alpha: 0.14 });
onSurfaces('automation mode short', mixWithText('#a78bfa', 0.5), { color: '#a78bfa', alpha: 0.14 });
onSurfaces('rb-fs problem', mixWithText('#f0883e', 0.45), { color: '#f0883e', alpha: 0.1 });
onSurfaces('rb-fs recommendation', mixWithText('#3fb950', 0.45), { color: '#3fb950', alpha: 0.1 });
onSurfaces('rb-fs risk', mixWithText('#58a6ff', 0.45), { color: '#58a6ff', alpha: 0.1 });
const tokenMix = (name: string, pct: number) => (t: Record<string, string>): Rgb =>
  blend(hex(t[name]!), hex(t['--text']!), pct);
onSurfaces('metamodel low', tokenMix('--success', 0.75), { color: '#2ea043', alpha: 0.16 });
onSurfaces('metamodel medium', tokenMix('--warning', 0.75), { color: '#dbab0a', alpha: 0.18 });
onSurfaces('metamodel high/warn', tokenMix('--danger', 0.75), { color: '#f85149', alpha: 0.16 });
onSurfaces('provider badge copilot / diff hunk', mixWithText('#a371f7', 0.65));
onSurfaces('provider badge agency', mixWithText('#3bb4e8', 0.55));
onSurfaces('status text warning', token('--warning'));
onSurfaces('status text danger', token('--danger'));
onSurfaces('status text success', token('--success'));

for (const { palette, theme, t } of PALETTE_VARIANTS) {
  const variant = `${palette}-${theme}`;
  for (const surface of [...SURFACES, '--panel-titlebar', '--item-hover', '--item-active']) {
    for (const fg of ['--text', '--text-muted', '--text-faint']) {
      record(`${fg} on ${surface}`, variant, hex(t[fg]!), hex(t[surface]!), 4.5);
    }
  }
  record('activity icon on activity bar', variant, hex(t['--activity-fg']!), hex(t['--panel-activitybar']!), 4.5);
  for (const accent of ACCENT_KEYS) {
    record(`accent ${accent} link on --panel`, variant, hex(resolveAccent(accent, theme).color), hex(t['--panel']!), 4.5);
  }
}

describe('composed contrast of default palettes', () => {
  it('covers every default theme, appearance and IDE color scheme variant', () => {
    expect(new Set(rows.map((r) => r.variant)).size).toBe(6 + PALETTE_VARIANTS.length);
    expect(PALETTE_VARIANTS).toHaveLength((IDE_PALETTES.length - 1) * 2);
    if (process.env.CSS_RATIOS) console.table(rows.filter((r) => r.value < r.min + 0.6));
  });

  it('keeps every measured pair at its required ratio', () => {
    const failures = rows.filter((r) => r.value < r.min)
      .map((r) => `${r.variant}: ${r.label} = ${r.value} (<${r.min})`);
    expect(failures).toEqual([]);
  });
});

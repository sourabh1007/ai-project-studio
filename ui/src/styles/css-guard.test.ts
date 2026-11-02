import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const tokens = read(join(here, 'design-tokens.css'));
const app = read(join(here, 'app.css'));
const allCss = [tokens, app, read(join(here, '..', 'features', 'workspace', 'pr-import-status.css')),
  read(join(here, '..', 'features', 'active-sessions', 'active-sessions.css'))].join('\n');

/** Declarations of the first rule whose selector list is exactly `selector`. */
function block(css: string, selector: string): Record<string, string> {
  const start = `\n${css}`.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`missing block ${selector}`);
  css = `\n${css}`;
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

function channel(hex: string): number[] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
}
function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
function mix(fg: string, bg: string, pct: number): number[] {
  const f = channel(fg);
  const b = channel(bg);
  return f.map((v, i) => v * pct + b[i]! * (1 - pct));
}

describe('design tokens', () => {
  it('never references an undefined custom property without a fallback', () => {
    const defined = new Set([...allCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
    const runtime = new Set(['--explorer-width', '--history-width', '--feature-accent']);
    const missing = new Set<string>();
    for (const m of allCss.matchAll(/var\((--[\w-]+)\s*([,)])/g)) {
      if (m[2] === ')' && !defined.has(m[1]!) && !runtime.has(m[1]!)) missing.add(m[1]!);
    }
    expect([...missing]).toEqual([]);
  });

  it('aliases legacy names to canonical tokens', () => {
    const root = block(tokens, ':root');
    expect(root['--muted']).toBe('var(--text-muted)');
    expect(root['--surface-hover']).toBe('var(--item-hover)');
    expect(root['--editor-bg']).toBe('var(--panel-editor)');
    expect(root['--radius']).toBe('var(--radius-md)');
    for (const target of ['--text-muted', '--item-hover', '--panel-editor', '--radius-md']) {
      expect(tokens).toContain(`${target}:`);
    }
  });

  it.each([
    ["[data-appearance='futuristic'][data-theme='dark']"],
    ["[data-appearance='futuristic'][data-theme='light']"],
  ])('keeps control borders at 3:1 in %s', (selector) => {
    const t = block(tokens, selector);
    for (const surface of ['--surface', '--panel', '--panel-sidebar', '--bg']) {
      expect(ratio(channel(t['--border-strong']!), channel(t[surface]!))).toBeGreaterThanOrEqual(3);
    }
  });

  it.each([
    [':root, [data-theme=\'light\']', 'light'],
    ["[data-theme='dark']", 'dark'],
  ])('keeps semantic text tokens readable in %s', (_label, theme) => {
    const t = theme === 'light'
      ? { ...block(tokens, ':root,\n[data-theme=\'light\']') }
      : block(tokens, "[data-theme='dark']");
    for (const name of ['--success', '--warning', '--danger', '--accent', '--text-muted']) {
      expect(ratio(channel(t[name]!), channel(t['--surface']!))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps planner kind colours readable as fills and as tinted text', () => {
    const light = block(app, ':root');
    const dark = block(app, "[data-theme='dark']");
    for (const kind of ['review', 'agent', 'session']) {
      expect(ratio(channel('#ffffff'), channel(light[`--kind-${kind}`]!))).toBeGreaterThanOrEqual(4.5);
      const lightText = light[`--kind-${kind}-text`]!;
      const lightTint = mix(lightText, '#ffffff', 0.14);
      expect(ratio(channel(lightText), lightTint)).toBeGreaterThanOrEqual(4.5);
      const darkText = dark[`--kind-${kind}-text`]!;
      expect(ratio(channel(darkText), mix(darkText, '#252526', 0.14))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('app.css guards', () => {
  it('does not use fixed low-contrast status hues for text', () => {
    const banned = ['#fbbf24', '#7dd3fc', '#c4b5fd', '#34d399', '#f59e0b', '#f87171', '#3fb950', '#58a6ff',
      '#f85149', '#e5534b', '#b98900', '#2ea043'];
    const offenders = app.split('\n').filter((line) => /^\s*color:\s*#[0-9a-f]{6}\s*;/i.test(line)
      && banned.includes(line.match(/#[0-9a-f]{6}/i)![0].toLowerCase()));
    expect(offenders).toEqual([]);
  });

  it('animates indeterminate loading with transforms, not layout', () => {
    const travel = app.slice(app.indexOf('@keyframes top-loading-travel'), app.indexOf('@keyframes top-loading-travel') + 160);
    expect(travel).toContain('translateX');
    expect(travel).not.toMatch(/\b(left|width)\s*:/);
  });

  it('shows a non-progress striped fill when motion is reduced', () => {
    for (const mode of ['reduced', 'off']) {
      expect(app).toContain(`:root[data-motion='${mode}'] .top-loading-bar:not(.is-done):not(.is-error) .top-loading-bar-fill`);
      expect(app).toContain(`:root[data-motion='${mode}'] .update-banner-progress-indeterminate .update-banner-progress-bar`);
    }
    expect(app).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.top-loading-bar:not/);
    expect(app).toContain('repeating-linear-gradient');
  });

  it('keeps removed blur and transition-all out', () => {
    expect(app).not.toMatch(/\.rb-prompt-pop \{[^}]*backdrop-filter/);
    expect(app).not.toMatch(/\.planner-action \{[^}]*transition: all/);
  });

  it('provides keyboard focus for suggestion, mini/open and graph slots', () => {
    expect(app).toContain('.planner-suggest-item.is-active');
    expect(app).toContain('.planner-open:focus-visible');
    expect(app).toContain('.planner-mini:focus-visible');
    expect(app).toContain('.cg-filenode:focus-visible .cg-filenode-rect');
    expect(app).toContain('.new-task-textarea[readonly]');
    expect(app).toMatch(/\.session-prompt-input \{/);
  });

  it('lets planner controls and panels follow the radius preference', () => {
    expect(app).toMatch(/\.planner-hero-add,[\s\S]*?\{\s*border-radius: var\(--radius-md\);/);
    expect(app).toMatch(/\.planner-summary-modal,[\s\S]*?\{\s*border-radius: var\(--radius-lg\);/);
  });

  it('styles Modal-hosted planner and new-task dialogs with bounded scroll panes', () => {
    expect(app).toMatch(/\n\.new-task-modal-content \{[^}]*min-height: 0;/);
    expect(app).toMatch(/\.modal \.new-task-modal-log \{[^}]*max-height: min\(60vh/);
    expect(app).toMatch(/\.modal \.new-task-diff-body \{[^}]*max-height: min\(65vh/);
    expect(app).toMatch(/\.modal \.planner-summary-head \{[^}]*flex-wrap: wrap;/);
    expect(app).toContain('.planner-summary-scope-btn:focus-visible');
    expect(app).toContain('.planner-hero:has(.planner-hero-input:focus-visible)');
    // Legacy overlay classes stay: bug-bash-page still renders them.
    expect(app).toContain('.new-task-modal-overlay {');
  });

  it('defines planner kind tokens on :root so portaled dialogs and ErrorText resolve them', () => {
    expect(block(app, ':root')['--kind-review']).toBeDefined();
    expect(block(app, '.planner')['--kind-review']).toBeUndefined();
  });
});

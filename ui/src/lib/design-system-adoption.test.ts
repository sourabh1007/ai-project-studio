import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression lock for the StatusBadge consistency migration.
 *
 * Genuine run-state surfaces (repository-context status, metasession pool
 * warming/ready/shutting) were migrated off bespoke, per-feature status classes
 * onto the canonical `<StatusBadge>` primitive so the same state looks the same
 * everywhere and stays accessible (icon + colour + label, not colour alone).
 *
 * This test fails the build if any of those removed status classes are
 * reintroduced. It is deliberately narrow — it bans only classes that
 * previously encoded run-state and have a StatusBadge replacement, NOT
 * categorical tags (provider names, PR labels, price categories, sensitivity),
 * which are legitimately their own visual family.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

/** Bespoke run-state classes that must now go through <StatusBadge>. */
const BANNED_STATUS_CLASSES = [
  'metapool-badge',
  'repo-context-state',
  'repo-context-spinner',
];

/**
 * `ui.tsx` legitimately owns the canonical `btn btn-<variant>` markup because
 * that is exactly what the <Button> primitive renders. Every other file must
 * use <Button> rather than hand-rolling those classes.
 */
const BUTTON_PRIMITIVE_OWNER = join('components', 'ui.tsx');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) {
      continue;
    }
    out.push(full);
  }
  return out;
}

describe('StatusBadge adoption', () => {
  it.each(BANNED_STATUS_CLASSES)(
    'does not reintroduce the migrated status class %s',
    (banned) => {
      const offenders = sourceFiles(SRC).filter((file) =>
        readFileSync(file, 'utf8').includes(banned),
      );
      expect(offenders, `Use <StatusBadge> instead of "${banned}"`).toEqual([]);
    },
  );
});

describe('Button adoption', () => {
  it('does not hand-roll the canonical btn classes outside <Button>', () => {
    const offenders = sourceFiles(SRC).filter(
      (file) =>
        !file.endsWith(BUTTON_PRIMITIVE_OWNER) &&
        /\bbtn btn-(primary|secondary|ghost|danger)\b/.test(
          readFileSync(file, 'utf8'),
        ),
    );
    expect(
      offenders,
      'Use the <Button> component instead of raw "btn btn-<variant>" markup',
    ).toEqual([]);
  });
});

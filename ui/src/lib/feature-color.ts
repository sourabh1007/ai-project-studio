/**
 * Deterministic, stable color assignment for features. Each feature id maps to
 * one slot in a fixed palette so the same feature always renders in the same
 * hue across the Explorer tree and its editor tabs. The actual color values
 * live in the CSS design-token layer (`--feature-color-N`); this module only
 * resolves an id to a token reference, keeping concrete colors out of the code.
 */

/** Number of palette slots; must match the `--feature-color-N` CSS tokens. */
export const FEATURE_COLOR_COUNT = 8;

/** FNV-1a hash — small, stable and dependency-free. */
function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Palette slot (1-based) a feature id is assigned to. */
export function featureColorIndex(id: string): number {
  return (hashId(id) % FEATURE_COLOR_COUNT) + 1;
}

/** CSS color token reference for a feature id (e.g. `var(--feature-color-3)`). */
export function featureColor(id: string): string {
  return `var(--feature-color-${featureColorIndex(id)})`;
}

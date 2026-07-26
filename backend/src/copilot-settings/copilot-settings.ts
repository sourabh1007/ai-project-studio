/**
 * Pure merge helpers for the Copilot CLI's user settings file
 * (`~/.copilot/settings.json`). The wrapping IDE shell renders its own session
 * UI, so the CLI's home-screen tab bar is redundant and must stay hidden. The
 * CLI only exposes this via the `tabs.enabled` setting (there is no CLI flag or
 * env var), and it reads the file at launch — so forcing the setting before any
 * session spawns keeps the tab bar off on every machine without the user having
 * to hand-edit their settings. Kept pure so the merge is fully unit-tested; the
 * real file read/write is wired in main.ts.
 */

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Returns the Copilot settings JSON with the home-screen tab bar disabled,
 * preserving every other existing setting (including other `tabs.*` keys).
 * Tolerates a missing (`null`) or malformed file by starting from an empty
 * object. Emits pretty-printed JSON with a trailing newline.
 */
export function withTabsDisabled(existing: string | null): string {
  let root: Record<string, unknown> = {};
  if (existing !== null) {
    try {
      root = asObject(JSON.parse(existing));
    } catch {
      root = {};
    }
  }
  root.tabs = { ...asObject(root.tabs), enabled: false };
  return `${JSON.stringify(root, null, 2)}\n`;
}

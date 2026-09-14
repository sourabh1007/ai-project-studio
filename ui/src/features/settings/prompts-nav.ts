/**
 * Cross-view deep-linking to the Settings → Prompts & Commands tab.
 *
 * The review board lives deep inside the workspace view, while the settings tab
 * state lives in `App`/`SettingsView`. To jump from a perspective's prompt
 * preview straight to its editor we broadcast a window event (so `App` can
 * switch to the settings view) and stash the target anchor in `sessionStorage`
 * so the freshly-mounted `SettingsView` can open the right tab and scroll to the
 * exact entry — without threading props through the whole component tree.
 */

/** Window event that asks the app to open the Prompts & Commands settings tab. */
export const OPEN_PROMPT_SETTINGS_EVENT = 'cw:open-prompt-settings';

/** Detail payload carried by {@link OPEN_PROMPT_SETTINGS_EVENT}. */
export interface OpenPromptSettingsDetail {
  anchorId: string;
}

const ANCHOR_STORAGE_KEY = 'cw-prompt-settings-anchor';

/** Stable DOM id for a catalog entry, used as the scroll/deep-link anchor. */
export function promptAnchorId(namespace: string, key: string): string {
  return `prompt-entry-${namespace}-${key}`;
}

/** Navigate to the Prompts & Commands tab, scrolled to the given anchor id. */
export function openPromptSettings(anchorId: string): void {
  try {
    sessionStorage.setItem(ANCHOR_STORAGE_KEY, anchorId);
  } catch {
    // sessionStorage can be unavailable (private mode / hardened origin); the
    // event alone still opens the tab, just without auto-scroll.
  }
  window.dispatchEvent(
    new CustomEvent<OpenPromptSettingsDetail>(OPEN_PROMPT_SETTINGS_EVENT, {
      detail: { anchorId },
    }),
  );
}

/** Read and clear the pending deep-link anchor, if any. */
export function takePromptSettingsAnchor(): string | null {
  try {
    const value = sessionStorage.getItem(ANCHOR_STORAGE_KEY);
    if (value) sessionStorage.removeItem(ANCHOR_STORAGE_KEY);
    return value;
  } catch {
    return null;
  }
}

import type { ProviderSelectionInfo } from './api.js';
import type { Session } from './types.js';
import type { ShortcutBinding } from './keyboard-shortcuts.js';

export const PROVIDER_CHANGED = 'cw-provider-changed';
export const PROVIDER_PREFERENCES_CHANGED = 'cw-provider-preferences-changed';
export const CLI_SHORTCUT_CHANGED = 'cw-cli-shortcut-changed';
export const CLI_SHORTCUT_KEY = 'cw-cli-shortcut';
export type CliShortcut = 'l' | 'y' | 'off';
export const isCliShortcut = (value: unknown): value is CliShortcut =>
  value === 'l' || value === 'y' || value === 'off';

export function cliShortcutBinding(key: CliShortcut): ShortcutBinding[] {
  return key === 'off' ? [] : [{
    id: 'switch-cli', title: 'Choose active CLI', key, ctrlOrMeta: true, shift: true,
  }];
}

export function cliShortcutLabel(key: CliShortcut, platform: string): string {
  return key === 'off' ? 'Shortcut disabled' : `${/mac/i.test(platform) ? 'Cmd' : 'Ctrl'}+Shift+${key.toUpperCase()}`;
}

export function announceProvider(info: ProviderSelectionInfo): void {
  window.dispatchEvent(new CustomEvent(PROVIDER_CHANGED, { detail: info }));
}

export function compatibleSession(sessions: Session[], providerId: string): Session | undefined {
  return sessions.filter((session) =>
    session.provider === providerId && session.kind === 'dev' && session.scope !== 'internal' &&
    ((session.startedAt !== null && session.status !== 'created') || session.prompt.length === 0),
  ).sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt))[0];
}

export function ownsCliShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return false;
  if (event.target instanceof Element && event.target.closest('.xterm-helper-textarea')) return true;
  return !(event.target instanceof Element && event.target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm',
  ));
}

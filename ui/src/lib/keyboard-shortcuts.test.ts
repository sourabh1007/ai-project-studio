import { describe, expect, it } from 'vitest';

import {
  formatChord,
  type KeyEventLike,
  matchShortcut,
  type ShortcutBinding,
} from './keyboard-shortcuts.js';

const evt = (over: Partial<KeyEventLike>): KeyEventLike => ({
  key: 'k',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

const bindings: ShortcutBinding[] = [
  { id: 'palette', title: 'Command palette', key: 'k', ctrlOrMeta: true },
  { id: 'next', title: 'Next view', key: 'Tab', ctrlOrMeta: true },
  { id: 'prev', title: 'Previous view', key: 'Tab', ctrlOrMeta: true, shift: true },
  { id: 'settings', title: 'Settings', key: ',', ctrlOrMeta: true },
  { id: 'help', title: 'Shortcuts', key: '?' },
];

describe('matchShortcut', () => {
  it('matches a ctrl/meta chord on either Ctrl or Cmd', () => {
    expect(matchShortcut(evt({ ctrlKey: true }), bindings)?.id).toBe('palette');
    expect(matchShortcut(evt({ metaKey: true }), bindings)?.id).toBe('palette');
  });

  it('is case-insensitive on the key', () => {
    expect(matchShortcut(evt({ key: 'K', ctrlKey: true }), bindings)?.id).toBe(
      'palette',
    );
  });

  it('distinguishes bindings by the shift modifier', () => {
    expect(
      matchShortcut(evt({ key: 'Tab', ctrlKey: true }), bindings)?.id,
    ).toBe('next');
    expect(
      matchShortcut(
        evt({ key: 'Tab', ctrlKey: true, shiftKey: true }),
        bindings,
      )?.id,
    ).toBe('prev');
  });

  it('does not fire a plain chord when an extra modifier is held', () => {
    expect(matchShortcut(evt({ key: 'k', ctrlKey: true, shiftKey: true }), bindings)).toBeNull();
  });

  it('matches a modifier-free binding', () => {
    expect(matchShortcut(evt({ key: '?' }), bindings)?.id).toBe('help');
  });

  it('rejects a modifier-free binding when a modifier is held', () => {
    expect(matchShortcut(evt({ key: '?', altKey: true }), bindings)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(matchShortcut(evt({ key: 'z' }), bindings)).toBeNull();
  });
});

describe('formatChord', () => {
  it('formats modifiers and single-character keys', () => {
    expect(formatChord({ key: 'k', ctrlOrMeta: true })).toBe('Ctrl+K');
    expect(formatChord({ key: ',', ctrlOrMeta: true })).toBe('Ctrl+,');
  });

  it('preserves named keys and orders modifiers', () => {
    expect(formatChord({ key: 'Tab', ctrlOrMeta: true, shift: true })).toBe(
      'Ctrl+Shift+Tab',
    );
    expect(formatChord({ key: 'b', alt: true })).toBe('Alt+B');
  });
});

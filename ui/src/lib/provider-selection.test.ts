import { describe, expect, it } from 'vitest';
import { cliShortcutBinding, cliShortcutLabel, compatibleSession, isCliShortcut, ownsCliShortcut } from './provider-selection.js';
import type { Session } from './types.js';

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 's', featureId: 'f', provider: 'claude', name: null, requestedModel: '', resolvedModel: null,
  kind: 'dev', status: 'completed', prompt: 'previous prompt', usageFilePath: '', createdAt: '2026-01-01',
  startedAt: '2026-01-02', endedAt: '2026-01-03', exitCode: 0, ...overrides,
});
describe('provider selection helpers', () => {
  it('only reuses matching interactive sessions without submitting an old unstarted prompt', () => {
    const recent = session({ id: 'recent', startedAt: '2026-03-01' });
    expect(compatibleSession([
      session({ provider: 'copilot', startedAt: '2026-12-01' }),
      session({ scope: 'internal', startedAt: '2026-12-01' }),
      session({ kind: 'meta', startedAt: '2026-12-01' }),
      session({ startedAt: null, createdAt: '2026-12-01' }), session(), recent,
    ], 'claude')).toBe(recent);
    expect(compatibleSession([session({ startedAt: null, prompt: '' })], 'claude')).toBeDefined();
    expect(compatibleSession([], 'claude')).toBeUndefined();
    const olderUnstarted = session({ id: 'older-unstarted', startedAt: null, prompt: '', createdAt: '2026-02-01' });
    const newerUnstarted = session({ id: 'newer-unstarted', startedAt: null, prompt: '', createdAt: '2026-04-01' });
    expect(compatibleSession([olderUnstarted, newerUnstarted], 'claude')).toBe(newerUnstarted);
  });
  it('formats platform shortcuts and supports configured/disabled bindings', () => {
    expect(cliShortcutLabel('l', 'MacIntel')).toBe('Cmd+Shift+L');
    expect(cliShortcutLabel('y', 'Win32')).toBe('Ctrl+Shift+Y');
    expect(cliShortcutBinding('off')).toEqual([]);
    expect(cliShortcutLabel('off', 'Linux')).toBe('Shortcut disabled');
    expect(cliShortcutBinding('l')[0]).toMatchObject({ key: 'l', shift: true, ctrlOrMeta: true });
    expect(isCliShortcut('l')).toBe(true);
    expect(isCliShortcut('off')).toBe(true);
    expect(isCliShortcut('invalid')).toBe(false);
  });
  it('leaves IME, repeated keys, editable fields, terminal and prior handlers in control', () => {
    expect(ownsCliShortcut(new KeyboardEvent('keydown', { isComposing: true }))).toBe(false);
    expect(ownsCliShortcut(new KeyboardEvent('keydown', { repeat: true }))).toBe(false);
    const prevented = new KeyboardEvent('keydown', { cancelable: true });
    prevented.preventDefault();
    expect(ownsCliShortcut(prevented)).toBe(false);
    const target = document.createElement('textarea');
    const event = new KeyboardEvent('keydown');
    target.dispatchEvent(event);
    expect(ownsCliShortcut(event)).toBe(false);
    target.className = 'xterm-helper-textarea';
    const terminalEvent = new KeyboardEvent('keydown');
    target.dispatchEvent(terminalEvent);
    expect(ownsCliShortcut(terminalEvent)).toBe(true);
    expect(ownsCliShortcut(new KeyboardEvent('keydown'))).toBe(true);
  });
});

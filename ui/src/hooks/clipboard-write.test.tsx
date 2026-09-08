import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { copyText, CLIPBOARD_RESULT_EVENT } from './clipboard-write.js';
import { useGlobalClipboard } from './use-global-clipboard.js';
import type { ClipboardResult } from '../lib/clipboard.js';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  delete (window as unknown as { desktop?: unknown }).desktop;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function bridge(native: unknown) {
  (window as unknown as { desktop: unknown }).desktop = { copyText: native };
}
function Input() {
  const error = useGlobalClipboard();
  return <><input defaultValue="hello" /><span role="alert">{error}</span></>;
}

describe('clipboard DOM adapters', () => {
  it('reports only final native outcomes, without contents or an early success', async () => {
    let resolve!: (result: ClipboardResult) => void;
    bridge(() => new Promise<ClipboardResult>((done) => { resolve = done; }));
    const listener = vi.fn();
    window.addEventListener(CLIPBOARD_RESULT_EVENT, listener);
    const promise = copyText('private');
    expect(listener).not.toHaveBeenCalled();
    resolve({ ok: false, error: 'too-large', writeState: 'not-written' });
    await promise;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(listener.mock.calls[0][0].detail)).not.toContain('private');
    window.removeEventListener(CLIPBOARD_RESULT_EVENT, listener);
  });
  it('owns first shortcut and menu copy; cut remains an atomic browser action', async () => {
    const native = vi.fn(async () => ({ ok: true }));
    bridge(native);
    const { container } = render(<Input />);
    const field = container.querySelector('input')!;
    field.focus();
    field.setSelectionRange(0, 5);
    const key = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { field.dispatchEvent(key); });
    expect(key.defaultPrevented).toBe(true);
    expect(native.mock.calls).toEqual([['hello']]);
    const menu = new Event('copy', { bubbles: true, cancelable: true });
    await act(async () => { field.dispatchEvent(menu); });
    expect(menu.defaultPrevented).toBe(true);
    expect(native).toHaveBeenCalledTimes(2);
    const cut = new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(cut);
    expect(cut.defaultPrevented).toBe(false);
    expect(native).toHaveBeenCalledTimes(2);
  });
  it('shows native failure and never tries a second writer after rejected IPC', async () => {
    bridge(async () => { throw new Error('IPC lost'); });
    const browser = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText: browser } });
    const { container, getByRole } = render(<Input />);
    const field = container.querySelector('input')!;
    field.focus();
    field.setSelectionRange(0, 5);
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(getByRole('alert').textContent).toContain('write-unacknowledged');
    expect(browser).not.toHaveBeenCalled();
  });
  it.each(['focus', 'unmount', 'blur'] as const)('does not run deferred legacy fallback after %s', async (change) => {
    let reject!: (error: unknown) => void;
    vi.stubGlobal('navigator', { clipboard: { writeText: () => new Promise<void>((_, fail) => { reject = fail; }) } });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    const promise = copyText('x');
    if (change === 'unmount') field.remove();
    else if (change === 'blur') window.dispatchEvent(new Event('blur'));
    else {
      const other = document.createElement('input');
      document.body.appendChild(other);
      other.focus();
      field.focus();
    }
    reject(new DOMException('denied', 'NotAllowedError'));
    expect(await promise).toMatchObject({ ok: false, error: 'target-changed' });
    expect(exec).not.toHaveBeenCalled();
  });
  it('uses safe permission fallback once and restores the focused input', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new DOMException('', 'NotAllowedError'); } } });
    const { container } = render(<Input />);
    const field = container.querySelector('input')!;
    field.focus();
    field.setSelectionRange(1, 4);
    const exec = vi.fn(() => {
      document.activeElement!.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }));
      return true;
    });
    document.execCommand = exec;
    await act(async () => { expect(await copyText('x')).toEqual({ ok: true }); });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(1);
    expect(document.querySelector('textarea')).toBeNull();
  });
  it('reports browser ambiguity and legacy false/throw without false success', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('unknown'); } } });
    expect(await copyText('x')).toMatchObject({ ok: false, writeState: 'unknown' });
    vi.stubGlobal('navigator', {});
    document.execCommand = vi.fn(() => false);
    expect(await copyText('x')).toMatchObject({ ok: false, error: 'unavailable' });
    document.execCommand = vi.fn(() => { throw new Error('failed'); });
    expect(await copyText('x')).toMatchObject({ ok: false, error: 'legacy-write-failed' });
    expect(document.querySelector('textarea')).toBeNull();
  });
});

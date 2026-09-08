import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClipboardResult } from '../../lib/clipboard.js';
import { DiagnosticsSection } from './diagnostics-section.js';

vi.mock('../../hooks/use-connection-status.js', () => ({
  useConnectionStatus: () => ({ state: 'online' }),
}));
afterEach(() => {
  cleanup();
  delete (window as unknown as { desktop?: unknown }).desktop;
  vi.useRealTimers();
});

it('copies diagnostics through the acknowledged bridge and never shows premature success', async () => {
  vi.useFakeTimers();
  let finish!: (result: ClipboardResult) => void;
  const copyText = vi.fn(() => new Promise<ClipboardResult>((resolve) => { finish = resolve; }));
  (window as unknown as { desktop: unknown }).desktop = { copyText };
  render(<DiagnosticsSection version="0.10.3" logDirectory={null} />);
  act(() => { screen.getByRole('button', { name: 'Copy diagnostics' }).click(); });
  expect(copyText).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  await act(async () => { finish({ ok: false, error: 'too-large', writeState: 'not-written' }); });
  expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  act(() => { screen.getByRole('button', { name: 'Copy diagnostics' }).click(); });
  await act(async () => { finish({ ok: true }); });
  expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
});

it.each([false, 'reject'] as const)('reports a rejected diagnostics restart (%s) and permits retry', async (failure) => {
  const relaunch = vi.fn().mockImplementationOnce(() => failure === 'reject'
    ? Promise.reject(new Error('private detail')) : Promise.resolve(false))
    .mockResolvedValueOnce(true);
  render(<DiagnosticsSection version="0.10.3" logDirectory={null} bridge={{ relaunch }} />);
  await act(async () => { screen.getByRole('button', { name: 'Restart app' }).click(); });
  expect(screen.getByRole('alert')).toHaveTextContent('Restart not confirmed');
  expect(screen.queryByText('private detail')).toBeNull();
  await act(async () => { screen.getByRole('button', { name: 'Restart app' }).click(); });
  expect(relaunch).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

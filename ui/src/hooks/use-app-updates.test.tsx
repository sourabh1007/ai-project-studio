import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAppUpdates } from './use-app-updates.js';
import type { UpdateSnapshot } from '../lib/update-state.js';

afterEach(() => {
  cleanup();
  delete (window as unknown as { desktop?: unknown }).desktop;
});

it.each([false, 'reject'] as const)('surfaces install failure (%s), preserves the download and allows retry', async (failure) => {
  let onEvent!: (type: string, payload: UpdateSnapshot) => void;
  const install = vi.fn().mockImplementationOnce(() => failure === 'reject'
    ? Promise.reject(new Error('private IPC detail')) : Promise.resolve(false))
    .mockResolvedValueOnce(true);
  (window as unknown as { desktop: unknown }).desktop = { updates: {
    getState: async () => ({ status: 'downloaded', canAutoInstall: true, availableVersion: '1.0.0' }),
    install,
    onEvent: (callback: typeof onEvent) => { onEvent = callback; return () => {}; },
  } };
  const { result } = renderHook(useAppUpdates);
  await act(async () => {});
  await act(async () => { result.current.install(); });
  expect(result.current.state.error).toContain('Update not installed');
  expect(result.current.state.error).not.toContain('private IPC detail');
  expect(result.current.ui.canInstall).toBe(true);
  expect(result.current.ui.tone).toBe('danger');
  await act(async () => {
    result.current.install();
    onEvent('event', { status: 'downloaded', error: null });
  });
  expect(install).toHaveBeenCalledTimes(2);
  expect(result.current.state.error).toBeNull();
});

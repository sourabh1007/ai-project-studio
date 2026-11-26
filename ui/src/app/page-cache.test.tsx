import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PageCacheProvider, PageVisibility, usePageSnapshot } from './page-cache.js';
import { useAsync } from '../hooks/use-async.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('immediately restores navigation data, revalidates it, and retains it on a refresh failure', async () => {
  let reject!: (error: Error) => void;
  const load = vi.fn().mockResolvedValueOnce('Saved skills')
    .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  function Panel() {
    const state = useAsync<string>(load, [], 'skills');
    return <><p>{state.data ?? 'Initial loading'}</p><p>{state.loading ? 'Refreshing' : state.error ?? 'Ready'}</p></>;
  }
  const scope = {};
  const tree = (open: boolean) => <PageCacheProvider scope={scope}>{open && <Panel />}</PageCacheProvider>;
  const view = render(tree(true));
  await screen.findByText('Saved skills');
  view.rerender(tree(false));
  view.rerender(tree(true));
  expect(screen.getByText('Saved skills')).toBeVisible();
  expect(screen.getByText('Refreshing')).toBeVisible();
  expect(screen.queryByText('Initial loading')).not.toBeInTheDocument();
  await act(async () => reject(new Error('Offline; retry')));
  expect(screen.getByText('Offline; retry')).toBeVisible();
  expect(screen.getByText('Saved skills')).toBeVisible();
});

it('expires snapshots and isolates them by owner and API-client scope', () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const first = {};
  const { result, rerender } = renderHook(({ owner }) => usePageSnapshot<string>(owner), {
    initialProps: { owner: 'copilot' },
    wrapper: ({ children }) => <PageCacheProvider scope={first}>{children}</PageCacheProvider>,
  });
  act(() => result.current[1]('Copilot configuration'));
  rerender({ owner: 'agency' });
  expect(result.current[0]).toBeNull();
  act(() => result.current[1]('Agency configuration'));
  rerender({ owner: 'copilot' });
  expect(result.current[0]).toBe('Copilot configuration');
  now += 60_001;
  rerender({ owner: 'copilot' });
  expect(result.current[0]).toBeNull();

  const isolated = renderHook(() => usePageSnapshot<string>('agency'), {
    wrapper: ({ children }) => <PageCacheProvider scope={{}}>{children}</PageCacheProvider>,
  });
  expect(isolated.result.current[0]).toBeNull();
});

it('bounds cached navigation snapshots and evicts the least recently saved entry', () => {
  const scope = {};
  const { result, rerender } = renderHook(({ id }) => usePageSnapshot<string>(id), {
    initialProps: { id: 'item-0' },
    wrapper: ({ children }) => <PageCacheProvider scope={scope}>{children}</PageCacheProvider>,
  });
  for (let index = 0; index < 65; index++) {
    rerender({ id: `item-${index}` });
    act(() => result.current[1](`Snapshot ${index}`));
  }
  rerender({ id: 'item-0' });
  expect(result.current[0]).toBeNull();
  rerender({ id: 'item-64' });
  expect(result.current[0]).toBe('Snapshot 64');
});

it('pauses hidden-page reads and resumes once without clearing visible data', async () => {
  const loader = vi.fn().mockResolvedValue('Explorer snapshot');
  let visible = true;
  const { result, rerender } = renderHook(() => useAsync(loader, []), {
    wrapper: ({ children }) => <PageVisibility.Provider value={visible}>{children}</PageVisibility.Provider>,
  });
  await act(async () => {});
  expect(result.current.data).toBe('Explorer snapshot');
  visible = false;
  rerender();
  act(() => { result.current.reload(); result.current.reload(); });
  expect(loader).toHaveBeenCalledTimes(1);
  visible = true;
  rerender();
  await act(async () => {});
  expect(loader).toHaveBeenCalledTimes(2);
  expect(result.current.data).toBe('Explorer snapshot');
});

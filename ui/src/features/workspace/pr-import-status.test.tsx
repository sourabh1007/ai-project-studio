import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrImportStore, type PrImportApi, type PrImportEvent } from '../../lib/pr-import-store.js';
import { usePrImportEvents, usePrImports } from '../../hooks/use-pr-imports.js';
import { PR_IMPORT_STALL_MS, PrImportStatus, summarizeImports } from './pr-import-status.js';
import { ApiError } from '../../lib/api.js';

type Pending = { resolve: (v: { feature: { id: string }; alreadyImported: boolean }) => void; reject: (e: unknown) => void };

function harness(clock: () => number = Date.now) {
  const pending: Pending[] = [];
  const api = {
    createFeature: vi.fn(async () => ({ id: 'parent' })),
    createPrFeatureStreamed: vi.fn(
      () => new Promise((resolve, reject) => { pending.push({ resolve, reject } as Pending); }),
    ),
  } as unknown as PrImportApi;
  const store = new PrImportStore(clock);
  const add = (numbers: number[]) =>
    store.enqueue(api, {
      repo: { id: 'r', name: 'acme/app' },
      pulls: numbers.map((number) => ({ number, title: `Title ${number}` })),
      batchName: 'Bulk',
    });
  return { pending, api, store, add };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('summarizeImports', () => {
  it('describes every state', async () => {
    const { store, add, pending } = harness();
    await act(async () => { add([1, 2, 3]); });
    expect(summarizeImports(store.getSnapshot()).text).toBe('2 importing · 1 queued');
    expect(summarizeImports([]).text).toBe('');
    expect(pending).toHaveLength(2);
  });
});

describe('PrImportStatus', () => {
  it('allows every failed import to be dismissed when none succeeded', async () => {
    const { store, add, pending } = harness();
    render(<PrImportStatus store={store} />);
    await act(async () => { add([1, 2]); });
    await act(async () => {
      pending[0].reject(new ApiError(400, 'Rejected one'));
      pending[1].reject(new ApiError(400, 'Rejected two'));
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss PR #1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss PR #2' }));
    expect(screen.queryByRole('region', { name: 'Pull request imports' })).not.toBeInTheDocument();
  });
  it('renders nothing without imports', () => {
    const { store } = harness();
    const { container } = render(<PrImportStatus store={store} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows progress, supports cancel/retry/open/dismiss and a batch dashboard link', async () => {
    const { store, add, pending } = harness();
    const open = vi.fn();
    const openBatch = vi.fn();
    render(<PrImportStatus store={store} onOpen={open} onOpenBatch={openBatch} />);
    await act(async () => { add([1, 2, 3]); });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getAllByText('Starting checkout…')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel import of PR #3' }));
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);

    await act(async () => { pending[0].resolve({ feature: { id: 'f1' }, alreadyImported: false }); });
    await act(async () => { pending[1].reject(new ApiError(500, 'checkout exploded')); });
    expect(screen.getByText('checkout exploded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open review for PR #1' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ number: 1 }));
    fireEvent.click(screen.getByRole('button', { name: /Open acme\/app review dashboard \(1\/3\)/ }));
    expect(openBatch).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }), [
      expect.objectContaining({ number: 1 }),
    ]);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry PR #2' })); });
    expect(pending).toHaveLength(3);
    await act(async () => { pending[2].reject(new TypeError('offline')); });
    expect(screen.getByRole('button', { name: 'Check again PR #2' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '3 of 3 finished');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText('Title 1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss PR #2' }));
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('collapses and expands the list without losing the summary', async () => {
    const { store, add } = harness();
    render(<PrImportStatus store={store} />);
    await act(async () => { add([1]); });
    const toggle = screen.getByRole('button', { name: /PR imports/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Title 1')).not.toBeInTheDocument();
    expect(screen.getAllByText('1 importing').length).toBeGreaterThan(0);
    fireEvent.click(toggle);
    expect(screen.getByText('Title 1')).toBeInTheDocument();
  });

  it('flags a running import that has gone quiet without claiming failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { store, add } = harness();
    render(<PrImportStatus store={store} />);
    await act(async () => { add([1]); });
    expect(screen.queryByText(/no update for/)).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(PR_IMPORT_STALL_MS + 10_000); });
    expect(screen.getByText(/no update for 1m, still working on the server/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry|Check again/ })).not.toBeInTheDocument();
  });

  it('keeps showing a succeeded import whose batch has no dashboard', async () => {
    const { store, add, pending } = harness();
    render(<PrImportStatus store={store} onOpenBatch={vi.fn()} />);
    await act(async () => { add([1]); });
    await act(async () => { pending[0].resolve({ feature: { id: 'f' }, alreadyImported: true }); });
    expect(screen.getByText('Already imported')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dashboard/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open review/ })).not.toBeInTheDocument();
  });
});

describe('use-pr-imports hooks', () => {
  it('survive unmount: state persists and events replay to the next listener', async () => {
    const { store, add, pending } = harness();
    const first = renderHook(() => usePrImports(store));
    await act(async () => { add([9]); });
    expect(first.result.current).toHaveLength(1);
    first.unmount();
    await act(async () => { pending[0].resolve({ feature: { id: 'f9' }, alreadyImported: false }); });
    const seen: PrImportEvent[] = [];
    const second = renderHook(() => usePrImportEvents((event) => seen.push(event), store));
    expect(seen.map((e) => e.job.number)).toEqual([9]);
    second.unmount();
    const third = renderHook(() => usePrImports(store));
    expect(third.result.current[0].status).toBe('succeeded');
  });

  it('binds the api so restored imports can be retried', () => {
    const { api, store } = harness();
    const bind = vi.spyOn(store, 'bindApi');
    render(<PrImportStatus api={api} store={store} />);
    expect(bind).toHaveBeenCalledWith(api);
  });
});

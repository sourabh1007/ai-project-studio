import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import {
  PR_IMPORT_CONCURRENCY,
  PR_IMPORT_MAX_ACTIVE,
  PrImportStore,
  isFinishedImport,
  type PrImportApi,
  type PrImportEvent,
} from './pr-import-store.js';
import type { Feature } from './types.js';

type Streamed = PrImportApi['createPrFeatureStreamed'];
interface Call {
  number: number;
  parent: string | null | undefined;
  onStatus: (s: { phase: string; message: string }) => void;
  resolve: (v: { feature: Feature; alreadyImported: boolean }) => void;
  reject: (e: unknown) => void;
}

const feature = (id: string): Feature => ({ id, name: id }) as unknown as Feature;
const repo = { id: 'r1', name: 'acme/app' };

function setup() {
  const calls: Call[] = [];
  const createFeature = vi.fn(async () => feature('parent'));
  const api: PrImportApi = {
    createFeature: createFeature as unknown as PrImportApi['createFeature'],
    listFeatures: vi.fn(async () => []) as unknown as PrImportApi['listFeatures'],
    getFeature: vi.fn(async (id: string) => feature(id)) as unknown as PrImportApi['getFeature'],
    createPrFeatureStreamed: ((_repoId, number, onStatus, parent) =>
      new Promise((resolve, reject) => {
        calls.push({ number, parent, onStatus, resolve, reject });
      })) as Streamed,
  };
  let now = 1000;
  const store = new PrImportStore(() => (now += 1));
  const done = (n: number, alreadyImported = false) =>
    [...calls].reverse().find((c) => c.number === n)!.resolve({ feature: feature(`f${n}`), alreadyImported });
  const req = (numbers: number[], extra = {}) => ({
    repo,
    pulls: numbers.map((number) => ({ number, title: `PR ${number}` })),
    batchName: 'Bulk',
    ...extra,
  });
  const jobs = () => store.getSnapshot();
  const status = (n: number) => jobs().find((j) => j.number === n)?.status;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { calls, createFeature, api, store, done, req, jobs, status, flush };
}

describe('PrImportStore', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('runs a single import with live status and reports it once', async () => {
    const events: PrImportEvent[] = [];
    t.store.subscribeEvents((e) => events.push(e));
    const notify = vi.fn();
    t.store.subscribe(notify);
    const { accepted } = t.store.enqueue(t.api, t.req([7], { parentFeatureId: 'feat' }));
    expect(accepted).toHaveLength(1);
    expect(t.status(7)).toBe('running');
    expect(t.calls[0].parent).toBe('feat');
    t.calls[0].onStatus({ phase: 'fetching', message: 'Fetching…' });
    expect(t.jobs()[0].message).toBe('Fetching…');
    t.done(7);
    await t.flush();
    expect(t.jobs()[0]).toMatchObject({
      status: 'succeeded',
      alreadyImported: false,
      message: 'Imported · review queued',
    });
    expect(events).toHaveLength(1);
    expect(events[0].job.feature?.id).toBe('f7');
    expect(t.createFeature).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled();
    expect(isFinishedImport('succeeded')).toBe(true);
    expect(isFinishedImport('unknown')).toBe(false);
  });

  it('reports an existing import as already imported', async () => {
    t.store.enqueue(t.api, t.req([7]));
    t.done(7, true);
    await t.flush();
    expect(t.jobs()[0]).toMatchObject({ alreadyImported: true, message: 'Already imported' });
  });

  it('bounds concurrency and starts queued work as slots free', async () => {
    t.store.enqueue(t.api, t.req([1, 2, 3, 4]));
    await t.flush();
    expect(PR_IMPORT_CONCURRENCY).toBe(2);
    expect(t.calls.map((c) => c.number)).toEqual([1, 2]);
    expect(t.status(3)).toBe('queued');
    t.done(1);
    await t.flush();
    expect(t.calls.map((c) => c.number)).toEqual([1, 2, 3]);
    t.calls[1].reject(new ApiError(500, 'boom'));
    await t.flush();
    expect(t.calls.map((c) => c.number)).toEqual([1, 2, 3, 4]);
    expect(t.status(2)).toBe('failed');
  });

  it('creates one parent for a multi-PR batch and reuses it', async () => {
    t.store.enqueue(t.api, t.req([1, 2, 3], { parentFeatureId: 'top' }));
    await t.flush();
    expect(t.createFeature).toHaveBeenCalledTimes(1);
    expect(t.createFeature).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Bulk', repoId: 'r1', parentFeatureId: 'top' }),
      { operationKey: expect.stringMatching(/^pr-import-parent-/) },
    );
    expect(t.calls.every((c) => c.parent === 'parent')).toBe(true);
    const batchId = t.jobs()[0].batchId;
    expect(t.store.getBatch(batchId)?.parent?.id).toBe('parent');
    t.done(1);
    await t.flush();
    t.done(2);
    await t.flush();
    t.done(3);
    await t.flush();
    expect(t.createFeature).toHaveBeenCalledTimes(1);
  });

  it('fails the batch jobs, not the app, when the parent cannot be created and retries it', async () => {
    t.createFeature.mockRejectedValueOnce(new ApiError(400, 'invalid group'));
    t.store.enqueue(t.api, t.req([1, 2]));
    await t.flush();
    expect(t.jobs().map((j) => j.status)).toEqual(['failed', 'failed']);
    expect(t.jobs()[0].error).toContain('invalid group');
    expect(t.calls).toHaveLength(0);
    t.store.retry(t.jobs()[0].id);
    await t.flush();
    expect(t.createFeature).toHaveBeenCalledTimes(2);
    expect(t.calls[0].parent).toBe('parent');
  });

  it('skips duplicates, live and imported pull requests and caps the queue', async () => {
    t.store.enqueue(t.api, t.req([1]));
    t.done(1);
    await t.flush();
    t.store.enqueue(t.api, t.req([2]));
    const r = t.store.enqueue(t.api, t.req([1, 2, 3, 3]));
    expect(r.skipped).toEqual([
      { number: 1, reason: 'imported' },
      { number: 2, reason: 'in-progress' },
      { number: 3, reason: 'duplicate' },
    ]);
    expect(r.accepted).toHaveLength(1);
    const many = Array.from({ length: PR_IMPORT_MAX_ACTIVE + 2 }, (_, i) => 100 + i);
    const full = t.store.enqueue(t.api, t.req(many));
    expect(full.skipped.every((s) => s.reason === 'queue-full')).toBe(true);
    expect(full.skipped.length).toBeGreaterThan(0);
    expect(t.store.enqueue(t.api, t.req([1])).accepted).toEqual([]);
  });

  it('retries a definite failure manually and replaces the failed predecessor on re-enqueue', async () => {
    t.store.enqueue(t.api, t.req([5]));
    t.calls[0].reject(new ApiError(404, 'PR not found'));
    await t.flush();
    expect(t.jobs()[0]).toMatchObject({ status: 'failed', error: 'PR not found' });
    expect(t.calls).toHaveLength(1);
    const id = t.jobs()[0].id;
    t.store.retry(id);
    expect(t.jobs()[0]).toMatchObject({ status: 'running', attempt: 2, error: null });
    t.done(5);
    await t.flush();
    expect(t.status(5)).toBe('succeeded');

    t.store.enqueue(t.api, t.req([6]));
    t.calls[2].reject(new Error('plain'));
    await t.flush();
    t.store.reset();
    t.store.enqueue(t.api, t.req([6]));
    t.calls[3].reject(new ApiError(500, 'x'));
    await t.flush();
    const again = t.store.enqueue(t.api, t.req([6]));
    expect(again.accepted).toHaveLength(1);
    expect(t.jobs().filter((j) => j.number === 6)).toHaveLength(1);
  });

  it('marks a dropped stream unknown, never auto-retries, and recovers on request', async () => {
    t.store.enqueue(t.api, t.req([8]));
    t.calls[0].reject(new TypeError('network'));
    await t.flush();
    expect(t.jobs()[0]).toMatchObject({ status: 'unknown', message: 'Outcome unknown' });
    expect(t.jobs()[0].error).toContain('will not create a duplicate');
    expect(t.calls).toHaveLength(1);
    expect(t.store.enqueue(t.api, t.req([8])).skipped[0].reason).toBe('in-progress');

    t.store.retry(t.jobs()[0].id);
    expect(t.jobs()[0].status).toBe('running');
    t.calls[1].reject(new ApiError(0, 'did not complete'));
    await t.flush();
    expect(t.status(8)).toBe('unknown');

    t.store.retry(t.jobs()[0].id);
    t.done(8, true);
    await t.flush();
    expect(t.jobs()[0]).toMatchObject({ status: 'succeeded', alreadyImported: false });
  });

  it('clears the recovery flag when the check ends in a definite failure', async () => {
    t.store.enqueue(t.api, t.req([8]));
    t.calls[0].reject(new TypeError('network'));
    await t.flush();
    t.store.retry(t.jobs()[0].id);
    t.calls[1].reject(new ApiError(500, 'server'));
    await t.flush();
    t.store.retry(t.jobs()[0].id);
    t.done(8, true);
    await t.flush();
    expect(t.jobs()[0].alreadyImported).toBe(true);
  });

  it('cancels only queued imports and ignores invalid retries', async () => {
    t.store.enqueue(t.api, t.req([1, 2, 3]));
    await t.flush();
    t.store.cancel(t.jobs()[0].id);
    expect(t.status(1)).toBe('running');
    t.store.cancel(t.jobs()[2].id);
    expect(t.status(3)).toBe('cancelled');
    t.store.retry(t.jobs()[0].id);
    t.store.retry('missing');
    t.done(1);
    await t.flush();
    expect(t.calls.map((c) => c.number)).toEqual([1, 2]);
    expect(t.status(3)).toBe('cancelled');
  });

  it('dismisses finished imports only and clears finished ones', async () => {
    t.store.enqueue(t.api, t.req([1, 2, 3]));
    await t.flush();
    t.store.dismiss(t.jobs()[0].id);
    t.store.dismiss('missing');
    expect(t.jobs()).toHaveLength(3);
    t.store.cancel(t.jobs()[2].id);
    t.done(1);
    await t.flush();
    t.calls[1].reject(new TypeError('net'));
    await t.flush();
    const batchId = t.jobs()[0].batchId;
    t.store.dismiss(t.jobs()[0].id);
    expect(t.store.getBatch(batchId)).toBeDefined();
    t.store.clearFinished();
    expect(t.jobs().map((j) => j.status)).toEqual(['unknown']);
    t.store.clearFinished();
    t.store.dismiss(t.jobs()[0].id);
    expect(t.jobs()).toEqual([]);
    expect(t.store.getBatch(batchId)).toBeUndefined();
  });

  it('replays imports finished while nothing listened, exactly once', async () => {
    t.store.enqueue(t.api, t.req([1]));
    t.done(1);
    await t.flush();
    const first: PrImportEvent[] = [];
    const off = t.store.subscribeEvents((e) => first.push(e));
    expect(first).toHaveLength(1);
    off();
    const second: PrImportEvent[] = [];
    t.store.subscribeEvents((e) => second.push(e));
    expect(second).toHaveLength(0);
  });

  it('ignores results that arrive after a reset', async () => {
    const events: PrImportEvent[] = [];
    t.store.subscribeEvents((e) => events.push(e));
    t.store.enqueue(t.api, t.req([1, 2, 3]));
    await t.flush();
    t.store.reset();
    t.calls[0].onStatus({ phase: 'x', message: 'late' });
    t.done(1);
    t.calls[1].reject(new ApiError(500, 'late failure'));
    await t.flush();
    expect(t.jobs()).toEqual([]);
    expect(events).toEqual([]);
    expect(t.calls).toHaveLength(2);
    t.store.enqueue(t.api, t.req([9]));
    expect(t.calls.at(-1)!.number).toBe(9);
  });

  it('unsubscribes state listeners', () => {
    const fn = vi.fn();
    const off = t.store.subscribe(fn);
    off();
    t.store.enqueue(t.api, t.req([1]));
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps stale-attempt results from overwriting a newer attempt', async () => {
    t.store.enqueue(t.api, t.req([4]));
    t.calls[0].reject(new ApiError(500, 'first'));
    await t.flush();
    t.store.retry(t.jobs()[0].id);
    t.calls[0].onStatus({ phase: 'x', message: 'stale status' });
    expect(t.jobs()[0].message).toBe('Starting checkout…');
    t.calls[0].resolve({ feature: feature('stale'), alreadyImported: false });
    await t.flush();
    expect(t.status(4)).toBe('running');
    t.done(4);
    await t.flush();
    expect(t.status(4)).toBe('succeeded');
  });
});

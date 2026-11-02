import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import {
  PR_IMPORT_STORAGE_KEY,
  storageOf,
  PrImportStore,
  type PrImportApi,
  type PrImportStorage,
} from './pr-import-store.js';
import type { Feature } from './types.js';

const feat = (id: string, description = ''): Feature => ({ id, name: id, description }) as unknown as Feature;
const flush = () => new Promise((r) => setTimeout(r, 0));
const repo = { id: 'r1', name: 'acme/app' };

function memory(): PrImportStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function make(storage: PrImportStorage | null = null) {
  const streams: { number: number; resolve: (v: { feature: Feature; alreadyImported: boolean }) => void; reject: (e: unknown) => void }[] = [];
  const createFeature = vi.fn<(input: { description: string }) => Promise<Feature>>(async () => feat('grp'));
  const listFeatures = vi.fn<() => Promise<Feature[]>>(async () => []);
  const getFeature = vi.fn(async (id: string) => feat(id));
  const api = {
    createFeature,
    listFeatures,
    getFeature,
    createPrFeatureStreamed: (_r: string, number: number) =>
      new Promise((resolve, reject) => streams.push({ number, resolve, reject } as never)),
  } as unknown as PrImportApi;
  let n = 0;
  const store = new PrImportStore(() => 5, storage, () => `tok-${(n += 1)}`);
  const add = (numbers: number[]) =>
    store.enqueue(api, { repo, pulls: numbers.map((number) => ({ number, title: `T${number}` })), batchName: 'Bulk' });
  const statuses = () => store.getSnapshot().map((j) => j.status);
  return { store, api, createFeature, listFeatures, getFeature, streams, add, statuses };
}

describe('parent creation with a lost response', () => {
  it('marks the batch unknown and never recreates the group blindly', async () => {
    const h = make();
    h.createFeature.mockRejectedValueOnce(new TypeError('socket hang up'));
    h.add([1, 2]);
    await flush();
    expect(h.statuses()).toEqual(['unknown', 'unknown']);
    expect(h.store.getSnapshot()[0].error).toContain('will not be duplicated');
    expect(h.createFeature).toHaveBeenCalledTimes(1);
    expect(h.createFeature.mock.calls[0][0].description).toContain('Import reference: tok-1');
    expect(h.streams).toHaveLength(0);
  });

  it('adopts a group that was created before the response was lost', async () => {
    const h = make();
    h.createFeature.mockRejectedValueOnce(new ApiError(0, 'lost'));
    h.add([1, 2]);
    await flush();
    h.listFeatures.mockResolvedValueOnce([feat('other', 'unrelated'), feat('made', 'x\n\nImport reference: tok-1')]);
    h.store.retry(h.store.getSnapshot()[0].id);
    h.store.retry(h.store.getSnapshot()[1].id);
    await flush();
    expect(h.createFeature).toHaveBeenCalledTimes(1);
    expect(h.listFeatures).toHaveBeenCalledTimes(1);
    expect(h.streams).toHaveLength(2);
    expect(h.store.getBatch(h.store.getSnapshot()[0].batchId)?.parent?.id).toBe('made');
  });

  it('creates the group only after verifying it is absent', async () => {
    const h = make();
    h.createFeature.mockRejectedValueOnce(new TypeError('lost')).mockResolvedValueOnce(feat('fresh'));
    h.add([1, 2]);
    await flush();
    h.store.retry(h.store.getSnapshot()[0].id);
    await flush();
    expect(h.listFeatures).toHaveBeenCalledTimes(1);
    expect(h.createFeature).toHaveBeenCalledTimes(2);
    expect(h.streams).toHaveLength(1);
  });

  it('keeps the batch unresolved when verification itself fails', async () => {
    const h = make();
    h.createFeature.mockRejectedValueOnce(new TypeError('lost'));
    h.add([1, 2]);
    await flush();
    h.listFeatures.mockRejectedValueOnce(new ApiError(500, 'list failed'));
    h.store.retry(h.store.getSnapshot()[0].id);
    await flush();
    expect(h.statuses()[0]).toBe('unknown');
    expect(h.store.getSnapshot()[0].error).toContain('will not be duplicated');
    h.createFeature.mockResolvedValueOnce(feat('fresh'));
    h.store.retry(h.store.getSnapshot()[0].id);
    await flush();
    expect(h.listFeatures).toHaveBeenCalledTimes(2);
    expect(h.createFeature).toHaveBeenCalledTimes(2);
  });

  it('treats a server rejection as nothing created, so retry creates without a lookup', async () => {
    const h = make();
    h.createFeature.mockRejectedValueOnce(new ApiError(400, 'nope')).mockResolvedValueOnce(feat('fresh'));
    h.add([1, 2]);
    await flush();
    expect(h.statuses()).toEqual(['failed', 'failed']);
    h.store.retry(h.store.getSnapshot()[0].id);
    await flush();
    expect(h.listFeatures).not.toHaveBeenCalled();
    expect(h.createFeature).toHaveBeenCalledTimes(2);
  });

  it('does not create a duplicate review group after a gateway loses a committed response', async () => {
    const storage = memory();
    const first = make(storage);
    first.createFeature.mockRejectedValueOnce(new ApiError(502, 'gateway failed after commit'));
    first.add([1, 2]);
    await flush();
    expect(first.statuses()).toEqual(['unknown', 'unknown']);
    const firstKey = (first.createFeature.mock.calls[0] as unknown as [unknown, { operationKey: string }])[1]?.operationKey;
    expect(firstKey).toBeTruthy();
    const reloaded = make(storage);
    reloaded.store.bindApi(reloaded.api);
    reloaded.listFeatures.mockResolvedValueOnce([]);
    reloaded.store.retry(reloaded.store.getSnapshot()[0].id);
    await flush();
    const retryKey = (reloaded.createFeature.mock.calls[0] as unknown as [unknown, { operationKey: string }])[1]?.operationKey;
    expect(retryKey).toBe(firstKey);
  });

  it('does not start old checkouts when a pending group creation completes after reset', async () => {
    const h = make();
    let complete!: (parent: Feature) => void;
    h.createFeature.mockImplementationOnce(() => new Promise<Feature>((resolve) => { complete = resolve; }));
    h.add([1, 2]);
    await flush();
    h.store.reset();
    complete(feat('old-parent'));
    await flush();
    expect(h.streams).toHaveLength(0);
    expect(h.store.getSnapshot()).toEqual([]);
  });

  it('does not create an old group when a pending reconciliation finishes after reset', async () => {
    const h = make();
    h.createFeature.mockRejectedValueOnce(new TypeError('lost'));
    h.add([1, 2]);
    await flush();
    let complete!: (features: Feature[]) => void;
    h.listFeatures.mockImplementationOnce(() => new Promise<Feature[]>((resolve) => { complete = resolve; }));
    h.store.retry(h.store.getSnapshot()[0].id);
    await flush();
    h.store.reset();
    complete([]);
    await flush();
    expect(h.createFeature).toHaveBeenCalledTimes(1);
    expect(h.streams).toHaveLength(0);
  });

  it('preserves queue capacity when a subscriber resets during the running notification', async () => {
    const h = make();
    let reset = true;
    h.store.subscribe(() => {
      if (reset && h.store.getSnapshot().some((job) => job.status === 'running')) {
        reset = false;
        h.store.reset();
      }
    });
    h.add([1, 2]);
    await flush();
    expect(h.createFeature).not.toHaveBeenCalled();
    expect(h.streams).toHaveLength(0);
    h.add([3, 4, 5]);
    await flush();
    expect(h.streams).toHaveLength(2);
    expect(h.statuses()).toEqual(['running', 'running', 'queued']);
  });

  it('does not start checkout when reset falls between parent publication and its awaiting continuation', async () => {
    const h = make();
    let complete!: (parent: Feature) => void;
    h.createFeature.mockImplementationOnce(() => new Promise<Feature>((resolve) => { complete = resolve; }));
    h.add([1, 2]);
    complete(feat('published-parent'));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.store.getBatch(h.store.getSnapshot()[0].batchId)?.parent?.id).toBe('published-parent');
    h.store.reset();
    await flush();
    expect(h.streams).toHaveLength(0);
    expect(h.store.getSnapshot()).toEqual([]);
  });
});

describe('persistence and reload reconciliation', () => {
  it('persists only minimal metadata for live imports', async () => {
    const storage = memory();
    const h = make(storage);
    h.add([1]);
    h.streams[0].resolve({ feature: feat('f1', 'secret-ish description'), alreadyImported: false });
    await flush();
    expect(JSON.parse(storage.data.get(PR_IMPORT_STORAGE_KEY)!).jobs).toEqual([]);
    h.add([2]);
    const raw = storage.data.get(PR_IMPORT_STORAGE_KEY)!;
    expect(raw).toContain('"number":2');
    expect(raw).not.toContain('secret-ish');
    expect(raw).not.toContain('feature"');
  });

  it('restores running imports as unknown and never-started ones as retryable', async () => {
    const storage = memory();
    const first = make(storage);
    first.add([1, 2, 3]);
    await flush();
    const second = make(storage);
    expect(second.statuses()).toEqual(['unknown', 'unknown', 'failed']);
    expect(second.store.getSnapshot()[2].error).toContain('Not started');
    expect(second.store.getSnapshot()[0].error).toContain('without creating a duplicate');
    expect(second.streams).toHaveLength(0);
    expect(second.store.enqueue(second.api, { repo, pulls: [{ number: 1, title: 't' }], batchName: 'b' }).skipped[0].reason).toBe('in-progress');

    second.store.retry(second.store.getSnapshot()[0].id);
    expect(second.statuses()[0]).toBe('unknown');
    second.store.bindApi(second.api);
    second.store.retry(second.store.getSnapshot()[0].id);
    await flush();
    expect(second.getFeature).toHaveBeenCalledWith('grp');
    expect(second.streams).toHaveLength(1);
  });

  it('reconciles a group that was in flight at reload and recovers imports as ours', async () => {
    const storage = memory();
    const first = make(storage);
    first.createFeature.mockImplementation(() => new Promise(() => {}));
    first.add([1, 2]);
    await flush();
    const second = make(storage);
    second.store.bindApi(second.api);
    second.listFeatures.mockResolvedValue([feat('grp', 'Import reference: tok-1')]);
    second.store.retry(second.store.getSnapshot()[0].id);
    await flush();
    expect(second.createFeature).not.toHaveBeenCalled();
    expect(second.streams).toHaveLength(1);
    second.streams[0].resolve({ feature: feat('f1'), alreadyImported: true });
    await flush();
    expect(second.store.getSnapshot()[0]).toMatchObject({ status: 'succeeded', alreadyImported: false });
  });

  it('reuses a persisted parent id instead of creating or searching', async () => {
    const storage = memory();
    const first = make(storage);
    first.createFeature.mockResolvedValue(feat('grp'));
    first.add([1, 2]);
    await flush();
    const second = make(storage);
    second.store.bindApi(second.api);
    second.store.retry(second.store.getSnapshot()[0].id);
    await flush();
    expect(second.getFeature).toHaveBeenCalledWith('grp');
    expect(second.createFeature).not.toHaveBeenCalled();
    expect(second.listFeatures).not.toHaveBeenCalled();
  });

  it('ignores corrupt storage, bad entries, and storage write failures', async () => {
    const bad = memory();
    bad.data.set(PR_IMPORT_STORAGE_KEY, '{not json');
    expect(make(bad).statuses()).toEqual([]);
    const junk = memory();
    junk.data.set(PR_IMPORT_STORAGE_KEY, JSON.stringify({
      batches: [null, { id: 'b' }, { id: 'batch-9', repoId: 'r', repoName: 'n', name: 'x', token: 't' }],
      jobs: [null, { id: 'import-1' }, { id: 'import-12', key: 'r:1', repoId: 'r', repoName: 'n', title: 't', batchId: 'nope', number: 1 },
        { id: 'import-14', key: 'r:4', repoId: 'r', repoName: 'n', title: 't', batchId: 'batch-9', number: 4, status: 'running' }],
    }));
    const h = make(junk);
    expect(h.store.getSnapshot()).toHaveLength(1);
    expect(h.store.getSnapshot()[0]).toMatchObject({ batchSize: 1, attempt: 1, parentFeatureId: null, parentGroupId: null });
    h.add([5]);
    expect(new Set(h.store.getSnapshot().map((j) => j.id)).size).toBe(2);
    const full = memory();
    full.data.set(PR_IMPORT_STORAGE_KEY, JSON.stringify({
      batches: [{ id: 'batch-1', repoId: 'r', repoName: 'n', name: 'x', token: 't', parentId: 'p', uncertain: true }],
      jobs: [{ id: 'import-3', key: 'r:3', repoId: 'r', repoName: 'n', title: 't', batchId: 'batch-1', number: 3, status: 'running',
        batchSize: 2, attempt: 4, parentFeatureId: 'pf', parentGroupId: 'pg' },
      { id: 'job', key: 'r:5', repoId: 'r', repoName: 'n', title: 't', batchId: 'batch-1', number: 5, status: 'queued' }],
    }));
    expect(make(full).store.getSnapshot()[0]).toMatchObject({ batchSize: 2, attempt: 4, parentFeatureId: 'pf', parentGroupId: 'pg' });
    const none = make({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
    none.add([1]);
    expect(none.streams).toHaveLength(1);
    const empty = make({ getItem: () => null, setItem: () => {} });
    expect(empty.statuses()).toEqual([]);
  });

  it('uses the scope storage when present and none otherwise', () => {
    const s = memory();
    expect(storageOf({ localStorage: s })).toBe(s);
    expect(storageOf({})).toBeNull();
  });

  it.each(['null', '[]', '1', '"invalid"'])('does not crash startup on a malformed persisted root: %s', (raw) => {
    const storage = memory();
    storage.data.set(PR_IMPORT_STORAGE_KEY, raw);
    expect(() => make(storage)).not.toThrow();
  });
});

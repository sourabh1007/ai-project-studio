import { describe, expect, it, vi } from 'vitest';
import { createResourcesService, type ResourcesDeps } from './resources-service.js';
import { resourcesDefaults, resourcesConfigSchema } from './config.js';
import { resourcePressureDefaults } from '../resource-pressure/config.js';
import { evaluateResources } from '../resource-pressure/resource-pressure.js';
import { at, fixtureFs, root } from './resources-fixture.test.js';
import { resourceView } from './resource-view.js';

function setup() {
  const fs = fixtureFs();
  fs.add(root, 'directory');
  fs.add(at('logs'), 'directory');
  let now = 100;
  const deps: ResourcesDeps = {
    fs: fs.fs, config: resourcesDefaults, now: () => now, backendPid: 2,
    host: () => evaluateResources(undefined, now, resourcePressureDefaults),
    processes: vi.fn(async () => ({ measuredAt: now, logicalCpuCount: 4, processes: [{ pid: 2, parentPid: 1, startedAt: 1, name: 'node', role: 'backend', cpuTimeMs: 100, memoryBytes: 500 }] })),
    roots: vi.fn(async () => [{ category: 'app', path: root }]),
    logs: { directory: at('logs'), appDataRoots: [root], isManagedFile: () => true, olderThan: 100 },
  };
  return { deps, fs, setNow: (n: number) => { now = n; }, service: createResourcesService(deps) };
}
describe('resource service concurrency and state', () => {
  it('reports cancellation of a targeted scan, including cancellation before inventory', async () => {
    const { service, fs } = setup();
    vi.mocked(fs.fs.volume).mockImplementation(async () => {
      service.dispose();
      return { totalBytes: 1000, freeBytes: 500, availableBytes: 400 };
    });
    const result = await service.cleanup('logs');
    expect(result.status).toBe('partial');
    expect(result.errors.join(' ')).toContain('Storage scan cancelled');
    expect(resourceView(service.snapshot()).storage.categories.find((entry) => entry.id === 'logs')!.error)
      .toContain('Storage scan cancelled');
  });
  it('remeasures after a failed baseline without inventing remaining bytes during deletion', async () => {
    const { service, deps, fs } = setup();
    deps.logs.olderThan = Date.parse('2026-09-26T00:00:00Z');
    fs.add(at('logs', 'app-2026-09-25.log'), 'file', 100);
    vi.mocked(fs.fs.realPath).mockRejectedValueOnce(new Error('Baseline unavailable'));
    const unlink = vi.mocked(fs.fs.unlink).getMockImplementation()!;
    vi.mocked(fs.fs.unlink).mockImplementation(async (path) => {
      expect(service.snapshot().storage.categories.find((entry) => entry.id === 'logs')!.bytes).toBeNull();
      await unlink(path);
    });
    expect((await service.cleanup('logs')).status).toBe('completed');
    expect(service.snapshot().storage.categories.find((entry) => entry.id === 'logs')!.bytes).toBe(0);
  });
  it('retains partial remaining bytes and excludes nested categories from targeted log scans', async () => {
    const { service, deps, fs } = setup();
    deps.logs.olderThan = Date.parse('2026-09-26T00:00:00Z');
    fs.add(at('logs', 'app-2026-09-26.log'), 'file', 80);
    const nested = fs.add(at('logs', 'cache'), 'directory');
    fs.add(at('logs', 'cache', 'data'), 'file', 300);
    vi.mocked(deps.roots).mockResolvedValue([
      { category: 'logs', path: at('logs') }, { category: 'cache', path: nested },
    ]);
    service.refreshStorage();
    await vi.waitFor(() => expect(service.snapshot().storage.status).toBe('ready'));
    const inaccessible = fs.add(at('logs', 'unreadable'), 'file', 20);
    const stat = vi.mocked(fs.fs.stat).getMockImplementation()!;
    vi.mocked(fs.fs.stat).mockImplementation(async (path) => {
      if (path === inaccessible) throw new Error('Unreadable log');
      return stat(path);
    });
    const result = await service.cleanup('logs');
    expect(result.status).toBe('partial');
    const logs = resourceView(service.snapshot()).storage.categories.find((entry) => entry.id === 'logs')!;
    expect(logs.bytes).toBeNull();
    expect(logs.pathDetails![0]).toMatchObject({ bytes: 80, status: 'partial' });
    expect(logs.error).toContain('Unreadable log');
    expect(service.snapshot().storage.progress.scannedBytes).toBe(380);
  });
  it('updates category/path bytes during deletion and remeasures remaining logs before marking the job complete', async () => {
    const { service, deps, fs, setNow } = setup();
    deps.logs.olderThan = Date.parse('2026-09-26T00:00:00Z');
    const first = fs.add(at('logs', 'app-2026-09-24.log'), 'file', 100);
    const second = fs.add(at('logs', 'app-2026-09-25.log'), 'file', 200);
    const active = fs.add(at('logs', 'app-2026-09-26.log'), 'file', 30);
    fs.add(at('app-file'), 'file', 500);
    vi.mocked(deps.roots).mockResolvedValue([{ category: 'app', path: root }, { category: 'logs', path: at('logs') }]);
    service.refreshStorage();
    await vi.waitFor(() => expect(service.snapshot().storage.status).toBe('ready'));
    const unchanged = service.snapshot().storage.categories.find((entry) => entry.id === 'app');
    const initialTime = service.snapshot().storage.completedAt;
    let release!: () => void;
    vi.mocked(fs.fs.unlink).mockImplementation(async (path) => {
      if (path === second) await new Promise<void>((resolve) => { release = resolve; });
      fs.nodes.delete(path);
    });
    setNow(200);
    service.requestCleanup('logs');
    await vi.waitFor(() => expect(service.snapshot().cleanups[0]!.removedFiles).toBe(1));
    expect(fs.nodes.has(first)).toBe(false);
    let logs = resourceView(service.snapshot()).storage.categories.find((entry) => entry.id === 'logs')!;
    expect(logs.bytes).toBe(230);
    expect(logs.pathDetails![0]).toMatchObject({ bytes: 230, measuredAt: 200 });
    fs.nodes.get(active)!.size = 80;
    release();
    await vi.waitFor(() => expect(service.snapshot().cleanups[0]!.status).toBe('completed'));
    logs = resourceView(service.snapshot()).storage.categories.find((entry) => entry.id === 'logs')!;
    expect(logs.bytes).toBe(80);
    expect(logs.pathDetails![0]!.bytes).toBe(80);
    expect(service.snapshot().storage.categories.find((entry) => entry.id === 'app')).toEqual(unchanged);
    expect(service.snapshot().storage.progress.scannedBytes).toBe(580);
    expect(service.snapshot().storage.completedAt).toBe(initialTime);
    expect(deps.roots).toHaveBeenCalledTimes(1);
  });
  it('does not subtract failed deletions and exposes remaining-size refresh errors rather than stale success', async () => {
    const { service, deps, fs } = setup();
    deps.logs.olderThan = Date.parse('2026-09-26T00:00:00Z');
    fs.add(at('logs', 'app-2026-09-25.log'), 'file', 100);
    vi.mocked(fs.fs.unlink).mockRejectedValue(new Error('File locked'));
    let result = await service.cleanup('logs');
    expect(result.status).toBe('partial');
    expect(service.snapshot().storage.categories.find((entry) => entry.id === 'logs')!.bytes).toBe(100);
    vi.mocked(fs.fs.unlink).mockImplementation(async (path) => {
      fs.nodes.delete(path);
      vi.mocked(fs.fs.realPath).mockRejectedValue(new Error('Size access denied'));
    });
    result = await service.cleanup('logs');
    expect(result.status).toBe('partial');
    expect(result.errors.join(' ')).toContain('Size access denied');
    expect(resourceView(service.snapshot()).storage.categories.find((entry) => entry.id === 'logs')).toMatchObject({
      bytes: null, error: expect.stringContaining('Size access denied'),
    });
  });
  it('has a validated config trio and cached initial unavailable status', () => {
    expect(resourcesConfigSchema.parse(resourcesDefaults)).toEqual(resourcesDefaults);
    expect(resourcesConfigSchema.safeParse({ ...resourcesDefaults, sampleIntervalMs: 0 }).success).toBe(false);
    expect(setup().service.snapshot()).toMatchObject({ app: { status: 'unavailable', measuredAt: null }, storage: { status: 'idle', stale: true } });
  });
  it('coalesces process samples, reports stale values and collection errors independently of host health', async () => {
    const { service, deps, setNow } = setup();
    const pending = service.sample();
    expect(service.sample()).toBe(pending);
    expect(deps.processes).toHaveBeenCalledTimes(1);
    await pending;
    expect(service.snapshot().app.memoryBytes).toBe(500);
    setNow(40000);
    expect(service.snapshot().app.status).toBe('stale');
    vi.mocked(deps.processes).mockRejectedValue(new Error('OS process access denied'));
    await service.sample();
    expect(service.snapshot().app.errors).toEqual(['OS process access denied']);
    expect(service.snapshot().host.status).toBe('unknown');
  });
  it('coalesces disk scans and responds to cached reads and process sampling while inventory is blocked', async () => {
    const { service, deps } = setup();
    let release!: () => void;
    vi.mocked(deps.roots).mockImplementation(() => new Promise((resolve) => { release = () => resolve([{ category: 'app', path: root }]); }));
    expect(service.refreshStorage().accepted).toBe(true);
    expect(service.refreshStorage().accepted).toBe(false);
    await Promise.resolve();
    expect(service.snapshot().storage.status).toBe('scanning');
    await service.sample();
    expect(service.snapshot().app.processCount).toBe(1);
    expect((await service.cleanup('logs')).status).toBe('busy');
    release();
    await vi.waitFor(() => expect(service.snapshot().storage.status).toBe('ready'));
    expect(service.snapshot().storage.stale).toBe(false);
  });
  it('retains scan cursors across old global deadlines while reads and process samples remain usable', async () => {
    const { service, deps, fs, setNow } = setup();
    for (let n = 0; n < 200; n++) fs.add(at(`file${n}`));
    let elapsed = 0;
    const stat = fs.fs.stat;
    const original = vi.mocked(stat).getMockImplementation()!;
    vi.mocked(stat).mockImplementation(async (path) => {
      elapsed += 1000;
      setNow(elapsed);
      return original(path);
    });
    service.refreshStorage();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.snapshot().storage.status).toBe('scanning');
    const before = service.snapshot().storage.progress.visitedEntries;
    expect(service.refreshStorage().accepted).toBe(false);
    expect(service.snapshot().storage.progress.visitedEntries).toBe(before);
    await service.sample();
    expect(service.snapshot().app.processCount).toBe(1);
    await vi.waitFor(() => expect(service.snapshot().storage.status).toBe('ready'));
    expect(elapsed).toBeGreaterThan(deps.config.scanTimeoutMs);
    expect(service.snapshot().storage.categories.find((category) => category.id === 'app')?.bytes).toBe(2000);
  });
  it('preserves full-scan errors while refreshing logs and coalesces cleanup', async () => {
    const { service, deps } = setup();
    vi.mocked(deps.roots).mockRejectedValue('inventory error');
    service.refreshStorage();
    await vi.waitFor(() => expect(service.snapshot().storage.status).toBe('unavailable'));
    expect(service.snapshot().storage.errors).toEqual(['inventory error']);
    const cleanup = service.cleanup('logs');
    expect(service.refreshStorage().accepted).toBe(false);
    expect((await service.cleanup('logs')).status).toBe('busy');
    expect((await cleanup).status).toBe('completed');
    expect(service.snapshot().storage.errors).toEqual(['inventory error']);
    expect(service.snapshot().storage.categories.find((entry) => entry.id === 'logs')!.bytes).toBe(0);
    expect((await service.cleanup('cache')).status).toBe('unsupported');
  });
  it('aborts work on disposal and never commits a late process result', async () => {
    const { service, deps } = setup();
    let finish!: (value: Awaited<ReturnType<ResourcesDeps['processes']>>) => void;
    vi.mocked(deps.processes).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = service.sample();
    service.dispose();
    expect(vi.mocked(deps.processes).mock.calls[0]![0].aborted).toBe(true);
    finish({ measuredAt: 1, logicalCpuCount: 1, processes: [] });
    await pending;
    await service.sample();
    expect(deps.processes).toHaveBeenCalledTimes(1);
    expect(service.snapshot().app.measuredAt).toBeNull();
    expect(service.refreshStorage().accepted).toBe(false);
    expect((await service.cleanup('logs')).status).toBe('busy');
  });
  it('queues cleanup immediately behind a scan, coalesces duplicates, and publishes live job counts', async () => {
    const { service, deps, fs } = setup();
    deps.logs.olderThan = Date.parse('2026-09-26T00:00:00Z');
    fs.add(at('logs', 'app-2026-09-25.log'));
    fs.add(at('logs', 'app-2026-09-26.log'));
    fs.add(at('logs', 'foreign'));
    deps.logs.isManagedFile = (name) => name.startsWith('app-');
    let release!: () => void;
    vi.mocked(deps.roots).mockImplementation(() => new Promise((resolve) => { release = () => resolve([]); }));
    service.refreshStorage();
    await Promise.resolve();
    const job = service.requestCleanup('logs');
    expect(job.status).toBe('queued');
    expect(service.requestCleanup('logs').id).toBe(job.id);
    expect(service.requestCleanup('cache').status).toBe('failed');
    for (let n = 0; n < 12; n++) service.requestCleanup('cache');
    expect(service.snapshot().cleanups).toHaveLength(10);
    expect(service.snapshot().cleanups[0]!.id).toBe(job.id);
    expect(service.refreshStorage().accepted).toBe(false);
    expect(fs.fs.unlink).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(service.snapshot().cleanups[0]!.status).toBe('completed'));
    expect(service.snapshot().cleanups[0]).toMatchObject({ removedBytes: 10, removedFiles: 1, skippedFiles: 2, error: null });
  });
  it('keeps unsupported, busy, disposed and failed jobs explicit with a bounded history', async () => {
    const { service, deps, fs } = setup();
    for (let n = 0; n < 15; n++) expect(service.requestCleanup('cache')).toMatchObject({ status: 'failed', error: expect.stringContaining('Live desktop') });
    expect(service.snapshot().cleanups).toHaveLength(10);
    const direct = service.cleanup('logs');
    expect(service.requestCleanup('logs').status).toBe('failed');
    await direct;
    deps.logs.appDataRoots = [];
    expect(service.requestCleanup('logs').status).toBe('failed');
    deps.logs.appDataRoots = [root];
    fs.add(at('logs', 'app-1970-01-01.log'));
    vi.mocked(fs.fs.unlink).mockRejectedValue(new Error('locked'));
    service.requestCleanup('logs');
    await vi.waitFor(() => expect(service.snapshot().cleanups.at(-1)!.status).toBe('failed'));
    expect(service.snapshot().cleanups.at(-1)!.error).toContain('locked');
    service.dispose();
    expect(service.requestCleanup('logs').status).toBe('failed');
  });
  it('publishes running progress without blocking snapshot reads, catches unexpected executor failures', async () => {
    const { service, deps, fs } = setup();
    deps.logs.olderThan = Date.parse('2026-09-26T00:00:00Z');
    fs.add(at('logs', 'app-2026-09-24.log'));
    fs.add(at('logs', 'app-2026-09-25.log'));
    let release!: () => void;
    vi.mocked(fs.fs.unlink).mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    service.requestCleanup('logs');
    await vi.waitFor(() => expect(service.snapshot().cleanups[0]!.removedFiles).toBe(1));
    expect(service.snapshot().cleanups[0]!.status).toBe('running');
    release();
    await vi.waitFor(() => expect(service.snapshot().cleanups[0]!.status).toBe('completed'));
    vi.spyOn(service, 'cleanup').mockRejectedValue(new Error('executor unavailable'));
    service.requestCleanup('logs');
    await vi.waitFor(() => expect(service.snapshot().cleanups.at(-1)!.error).toBe('executor unavailable'));
  });
  it('keeps progress safe for a direct executor and a queued job disposed before execution', async () => {
    const { service, deps, fs } = setup();
    deps.logs.olderThan = Date.parse('2026-09-26T00:00:00Z');
    fs.add(at('logs', 'app-2026-09-25.log'));
    expect((await service.cleanup('logs')).deletedFiles).toBe(1);
    service.requestCleanup('logs');
    service.dispose();
    await vi.waitFor(() => expect(service.snapshot().cleanups[0]!.status).toBe('failed'));
  });
});

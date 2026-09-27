import { describe, expect, it, vi } from 'vitest';
import { parse } from 'node:path';
import { initialStorage, scanStorage, isWithin, assertRealPath, errorText, canonicalPath } from './storage-scanner.js';
import { at, fixtureFs, root } from './resources-fixture.test.js';
import { resourcesDefaults } from './config.js';
import type { StorageRoot } from './resources-contract.js';

describe('bounded storage scanning', () => {
  it('scans scoped paths, excludes overlapping categories, duplicate roots, hardlinks and junctions', async () => {
    const { fs, add, nodes } = fixtureFs();
    add(root, 'directory');
    add(at('app.dat'));
    add(at('alias.dat'), 'file', 10, `1:${at('app.dat')}`);
    nodes.get(at('app.dat'))!.linkCount = 2;
    nodes.get(at('alias.dat'))!.linkCount = 2;
    add(at('logs'), 'directory');
    add(at('logs', 'old.log'), 'file', 20);
    add(at('junction'), 'link');
    add(at('socket'), 'other');
    const roots: StorageRoot[] = [{ category: 'app', path: root }, { category: 'logs', path: at('logs') }, { category: 'app', path: root }];
    const state = initialStorage(true);
    await scanStorage({ fs, config: resourcesDefaults, now: () => 100, roots: async () => roots }, state, new AbortController().signal);
    expect(state.categories.find((c) => c.id === 'logs')?.bytes).toBe(20);
    expect(state.categories.find((c) => c.id === 'app')?.bytes).toBe(10);
    expect(state.progress.scannedBytes).toBe(30);
    expect(state.categories.find((c) => c.id === 'app')?.paths[1]?.status).toBe('excluded');
    expect(state.categories.find((c) => c.id === 'app')?.paths[1]?.errors).toEqual([]);
    expect(state.status).toBe('ready');
    expect(state.categories.find((c) => c.id === 'app')?.paths[0]?.excludedPaths).toEqual([at('junction')]);
    expect(fs.volume).toHaveBeenCalledTimes(1);
  });
  it('marks unavailable paths and volume failures, not fabricated zero; keeps valid empty sizes', async () => {
    const { fs, add } = fixtureFs();
    add(root, 'directory');
    vi.mocked(fs.volume).mockRejectedValue(new Error('volume denied'));
    const state = initialStorage(false);
    await scanStorage({
      fs, config: resourcesDefaults, now: () => 100,
      roots: async (_signal, reportError) => { reportError('Inventory incomplete'); return [{ category: 'app', path: root }, { category: 'provider', path: at('missing') }]; },
    }, state, new AbortController().signal);
    expect(state.volumes[0]).toMatchObject({ totalBytes: null, error: 'volume denied' });
    expect(state.categories.find((c) => c.id === 'app')?.bytes).toBe(0);
    expect(state.categories.find((c) => c.id === 'provider')?.bytes).toBeNull();
    expect(state.errors).toEqual(['Inventory incomplete']);
  });
  it('returns ready for entirely measured data and deduplicates separate filesystem volumes', async () => {
    const { fs, add } = fixtureFs();
    add(root, 'file', 5);
    add(at('other'), 'file', 8, '2:file');
    const state = initialStorage(false);
    await scanStorage({ fs, config: resourcesDefaults, now: () => 1, roots: async () => [{ category: 'app', path: root }, { category: 'provider', path: at('other') }] }, state, new AbortController().signal);
    expect(state.status).toBe('ready');
    expect(fs.volume).toHaveBeenCalledTimes(2);
  });
  it('resumes beyond entry/time slices and enforces cancellation, unsafe root and depth limits', async () => {
    const { fs, add } = fixtureFs();
    add(root, 'directory');
    add(at('data'));
    const roots = async (): Promise<StorageRoot[]> => [{ category: 'app', path: root }];
    const state = initialStorage(false);
    await scanStorage({ fs, roots, now: () => 1, config: { ...resourcesDefaults, maxScanEntries: 1 } }, state, new AbortController().signal);
    expect(state.categories.find((c) => c.id === 'app')?.paths[0]).toMatchObject({ status: 'ready', bytes: 10 });
    let clock = 0;
    const sliced = initialStorage(false);
    await scanStorage({ fs, roots, now: () => clock += 100, config: { ...resourcesDefaults, scanTimeoutMs: 1 } }, sliced, new AbortController().signal);
    expect(sliced.categories.find((c) => c.id === 'app')?.bytes).toBe(10);
    const abort = new AbortController(); abort.abort();
    await expect(scanStorage({ fs, roots, now: () => 1, config: resourcesDefaults }, initialStorage(false), abort.signal)).rejects.toThrow('cancelled');
    for (const path of [parse(root).root, root]) {
      const blocked = initialStorage(false);
      await scanStorage({ fs, config: resourcesDefaults, now: () => 1, forbiddenRoots: [root], roots: async () => [{ category: 'app', path }] }, blocked, new AbortController().signal);
      expect(blocked.categories.find((c) => c.id === 'app')?.paths[0]?.errors[0]).toContain('root refused');
    }
    let path = root;
    for (let i = 0; i < 131; i++) { path = resolveChild(path); add(path, 'directory'); }
    const deep = initialStorage(false);
    await scanStorage({ fs, config: resourcesDefaults, now: () => 1, roots }, deep, new AbortController().signal);
    expect(deep.status).toBe('partial');
  });
  it('retains measured partial bytes after bounded hardlink identity index and caps errors', async () => {
    const { fs, add, nodes } = fixtureFs();
    add(root, 'directory');
    add(at('file'));
    add(at('last'));
    nodes.get(at('file'))!.linkCount = 2;
    nodes.get(at('last'))!.linkCount = 2;
    const roots = async (): Promise<StorageRoot[]> => [{ category: 'app', path: root }];
    const partial = initialStorage(false);
    await scanStorage({ fs, config: { ...resourcesDefaults, maxScanEntries: 1 }, now: () => 1, roots }, partial, new AbortController().signal);
    expect(partial.categories.find((c) => c.id === 'app')?.paths[0]).toMatchObject({ status: 'partial', bytes: 10 });
    for (let i = 0; i < 25; i++) add(at(`link${i}`), 'link');
    const links = initialStorage(false);
    await scanStorage({ fs, config: resourcesDefaults, now: () => 1, roots }, links, new AbortController().signal);
    expect(links.categories.find((c) => c.id === 'app')?.paths[0]?.errors).toHaveLength(0);
    expect(links.categories.find((c) => c.id === 'app')?.paths[0]?.excludedPaths).toHaveLength(20);
    vi.mocked(fs.realPath).mockImplementation(async (path) => {
      if (path !== root) throw new Error('denied');
      return path;
    });
    const errors = initialStorage(false);
    for (let i = 0; i < 25; i++) add(at(`file${i}`), 'directory');
    await scanStorage({ fs, config: resourcesDefaults, now: () => 1, roots }, errors, new AbortController().signal);
    expect(errors.categories.find((c) => c.id === 'app')?.paths[0]?.errors).toHaveLength(20);
  });
  it('finishes later small roots while the first large root still advances without restarting', async () => {
    const { fs, add } = fixtureFs();
    const large = add(at('large'), 'directory');
    for (let i = 0; i < 300; i++) add(at('large', `f${i}`));
    add(at('runtime'), 'file', 7);
    add(at('provider'), 'file', 9);
    const state = initialStorage(false);
    let clock = 0;
    const progress: number[] = [];
    vi.mocked(fs.stat).mockImplementation(async (path) => {
      // Capture progress when the provider (later category) is reached.
      if (path === at('provider')) progress.push(state.progress.visitedEntries);
      const node = path === large ? { kind: 'directory' as const, size: 0 } : { kind: 'file' as const, size: path === at('runtime') ? 7 : path === at('provider') ? 9 : 10 };
      return { ...node, identity: `1:${path}`, modifiedAt: 1, linkCount: 1 };
    });
    await scanStorage({
      fs, config: { ...resourcesDefaults, maxScanEntries: 10, scanTimeoutMs: 1 },
      now: () => clock += 10,
      roots: async () => [{ category: 'worktrees', path: large }, { category: 'app', path: at('runtime') }, { category: 'provider', path: at('provider') }],
    }, state, new AbortController().signal);
    expect(progress[0]).toBeLessThan(20);
    expect(state.categories.find((c) => c.id === 'worktrees')?.bytes).toBe(3000);
    expect(state.categories.find((c) => c.id === 'app')?.bytes).toBe(7);
    expect(state.categories.find((c) => c.id === 'provider')?.bytes).toBe(9);
    expect(state.progress.visitedEntries).toBe(303);
    expect(state.status).toBe('ready');
    expect(clock).toBeGreaterThan(30000 / 10);
    for (let i = 0; i < 300; i++) expect(vi.mocked(fs.stat).mock.calls.filter(([path]) => path === at('large', `f${i}`))).toHaveLength(1);
  });
  it('distinguishes inventory deadlines, caps roots, and closes resumable iterators on cancellation', async () => {
    const { fs, add } = fixtureFs();
    const deadline = new AbortController();
    deadline.abort(new DOMException('deadline', 'TimeoutError'));
    await expect(scanStorage({ fs, config: resourcesDefaults, now: () => 0, roots: async () => [] }, initialStorage(false), deadline.signal)).rejects.toThrow('deadline exceeded');
    const many = Array.from({ length: 257 }, (_, i): StorageRoot => ({ category: 'app', path: add(at(`root${i}`)) }));
    const capped = initialStorage(false);
    await scanStorage({ fs, config: resourcesDefaults, now: () => 0, roots: async () => many }, capped, new AbortController().signal);
    expect(capped.categories.find((c) => c.id === 'app')?.paths[256]?.errors[0]).toContain('root limit');
    const abort = new AbortController();
    let closed = false;
    add(root, 'directory');
    vi.mocked(fs.entries).mockImplementation(async function* () {
      try { yield 'root0'; abort.abort(); yield 'root1'; }
      finally { closed = true; }
    });
    const cancelled = initialStorage(false);
    await expect(scanStorage({
      fs, config: { ...resourcesDefaults, maxScanEntries: 1 }, now: () => 0,
      roots: async () => [{ category: 'app', path: root }, { category: 'provider', path: at('root2') }],
    }, cancelled, abort.signal)).rejects.toThrow('cancelled');
    expect(closed).toBe(true);
    expect(cancelled.categories.find((c) => c.id === 'app')?.paths[0]?.status).toBe('partial');
  });
  it('explains inventory timeout separately from shutdown and closes untouched cursors', async () => {
    const { fs, add } = fixtureFs();
    const state = initialStorage(false);
    await scanStorage({
      fs, now: () => 0, config: { ...resourcesDefaults, scanTimeoutMs: 1 },
      roots: async (_signal, report) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        report('Git inventory did not finish');
        return [];
      },
    }, state, new AbortController().signal);
    expect(state.errors[0]).toContain('inventory deadline exceeded (1ms)');
    const cancelled = new AbortController();
    await expect(scanStorage({
      fs, now: () => 0, config: resourcesDefaults,
      roots: async (_signal, report) => { cancelled.abort(); report('stopping'); return []; },
    }, initialStorage(false), cancelled.signal)).rejects.toThrow('cancelled');
    const abort = new AbortController();
    add(root, 'directory');
    add(at('later'), 'directory');
    vi.mocked(fs.realPath).mockImplementation(async (path) => { abort.abort(); return path; });
    const pending = initialStorage(false);
    await expect(scanStorage({
      fs, now: () => 1, config: { ...resourcesDefaults, maxScanEntries: 1 },
      roots: async () => [{ category: 'app', path: root }, { category: 'provider', path: at('later') }],
    }, pending, abort.signal)).rejects.toThrow('cancelled');
    expect(pending.categories.find((c) => c.id === 'app')?.paths[0]?.status).toBe('unavailable');
    expect(pending.categories.find((c) => c.id === 'provider')?.paths[0]?.status).toBe('unavailable');
  });
  it('retains file bytes when an open directory iterator subsequently fails', async () => {
    const { fs, add } = fixtureFs();
    add(root, 'directory');
    add(at('data'));
    vi.mocked(fs.entries).mockImplementation(async function* () { yield 'data'; throw new Error('directory disappeared'); });
    const state = initialStorage(false);
    await scanStorage({
      fs, config: resourcesDefaults, now: () => 1, roots: async () => [{ category: 'app', path: root }],
    }, state, new AbortController().signal);
    expect(state.categories.find((c) => c.id === 'app')?.paths[0]).toMatchObject({ bytes: 10, status: 'partial', errors: ['directory disappeared'] });
  });
  it('rejects realpath escapes and nonabsolute paths', async () => {
    const { fs } = fixtureFs();
    expect(isWithin(root, root)).toBe(false);
    expect(isWithin(at('..'), root)).toBe(false);
    expect(isWithin(at('..', 'other'), root)).toBe(false);
    expect(isWithin(at('logs'), root)).toBe(true);
    if (process.platform === 'win32') expect(isWithin('Z:\\outside', root)).toBe(false);
    await expect(assertRealPath(fs, 'relative')).rejects.toThrow('refused');
    vi.mocked(fs.realPath).mockResolvedValue(at('escape'));
    await expect(assertRealPath(fs, root)).rejects.toThrow('refused');
    expect(errorText('oops')).toBe('oops');
  });
  it('preserves case on case-sensitive platforms', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try { expect(canonicalPath(at('MixedCase'))).toBe(at('MixedCase')); }
    finally { Object.defineProperty(process, 'platform', descriptor); }
  });
});
function resolveChild(path: string): string { return `${path}${process.platform === 'win32' ? '\\' : '/'}x`; }

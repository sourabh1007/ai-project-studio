import { describe, expect, it, vi } from 'vitest';
import { cleanupFiles, supportsLogCleanup, type LogCleanupPolicy } from './safe-cleanup.js';
import { createDailyLogPathStrategy } from '../logging/config.js';
import { at, fixtureFs, root } from './resources-fixture.test.js';

const today = Date.parse('2026-09-26T00:00:00Z');
function setup() {
  const fixture = fixtureFs();
  fixture.add(at('logs'), 'directory');
  const policy: LogCleanupPolicy = {
    directory: at('logs'), appDataRoots: [root],
    isManagedFile: createDailyLogPathStrategy(at('logs'), 'app').isManagedFile,
    olderThan: today,
  };
  return { ...fixture, policy, now: () => today, maxEntries: 100, timeoutMs: 1000 };
}
describe('safe resource cleanup', () => {
  it('deletes only inactive managed logs, preserves current/new/foreign files, directories and hardlinks', async () => {
    const deps = setup();
    deps.add(at('logs', 'app-2026-09-24.log'));
    deps.add(at('logs', 'app-2026-09-25.1.log'));
    deps.add(at('logs', 'app-2026-09-26.log'));
    deps.add(at('logs', 'app-2026-09-20.log'));
    deps.nodes.get(at('logs', 'app-2026-09-20.log'))!.modifiedAt = today;
    deps.add(at('logs', 'app-2026-09-21.log'), 'directory');
    deps.add(at('logs', 'app-2026-09-22.log'));
    deps.nodes.get(at('logs', 'app-2026-09-22.log'))!.linkCount = 2;
    deps.add(at('logs', 'app-2026-99-99.log'));
    deps.add(at('logs', 'workspace.db'));
    deps.add(at('logs', 'desktop-supervisor.log'));
    const result = await cleanupFiles(deps, 'logs', new AbortController().signal);
    expect(result).toMatchObject({ status: 'completed', deletedFiles: 2, freedBytes: 20, skippedFiles: 7 });
    expect(deps.fs.unlink).toHaveBeenCalledTimes(2);
  });
  it('refuses unsupported cache and logs outside dedicated application data roots', async () => {
    const deps = setup();
    expect(supportsLogCleanup({ ...deps.policy, directory: root })).toBe(false);
    expect((await cleanupFiles(deps, 'cache', new AbortController().signal)).status).toBe('unsupported');
    deps.policy.appDataRoots = [];
    expect((await cleanupFiles(deps, 'logs', new AbortController().signal)).status).toBe('unsupported');
  });
  it('rejects ancestor junction escapes without deleting anything', async () => {
    const deps = setup();
    vi.mocked(deps.fs.realPath).mockResolvedValue(at('outside'));
    expect((await cleanupFiles(deps, 'logs', new AbortController().signal)).status).toBe('failed');
    expect(deps.fs.unlink).not.toHaveBeenCalled();
  });
  it('rejects path traversal and symlink files and caps per-file errors', async () => {
    const deps = setup();
    deps.policy.isManagedFile = () => true;
    vi.mocked(deps.fs.entries).mockImplementation(async function* () { yield '..'; yield 'unmanaged'; });
    expect((await cleanupFiles(deps, 'logs', new AbortController().signal))).toMatchObject({ skippedFiles: 1, status: 'partial' });
    const links = setup();
    for (let i = 0; i < 25; i++) links.add(at('logs', `app-2026-08-${String(i + 1).padStart(2, '0')}.log`), 'link');
    vi.mocked(links.fs.realPath).mockImplementation(async (path) => path === links.policy.directory ? path : at('outside'));
    expect((await cleanupFiles(links, 'logs', new AbortController().signal)).errors).toHaveLength(20);
    const missingDate = setup();
    missingDate.add(at('logs', 'random'));
    missingDate.policy.isManagedFile = () => true;
    expect((await cleanupFiles(missingDate, 'logs', new AbortController().signal)).skippedFiles).toBe(1);
  });
  it.each(['identity', 'modifiedAt', 'size', 'kind', 'linkCount'] as const)('rechecks %s before unlinking', async (field) => {
    const deps = setup();
    const path = deps.add(at('logs', 'app-2026-09-24.log'));
    const original = { ...deps.nodes.get(path)! };
    vi.mocked(deps.fs.stat).mockResolvedValueOnce(original).mockResolvedValueOnce({
      ...original, [field]: field === 'identity' ? 'different' : field === 'kind' ? 'link' : 99,
    });
    expect((await cleanupFiles(deps, 'logs', new AbortController().signal)).status).toBe('partial');
    expect(deps.fs.unlink).not.toHaveBeenCalled();
  });
  it('has bounded work and visible cancellation/failures, including partial completion', async () => {
    for (const mode of ['cancel', 'timeout', 'entries']) {
      const deps = setup();
      deps.add(at('logs', 'app-2026-09-24.log'));
      const abort = new AbortController();
      if (mode === 'cancel') abort.abort();
      if (mode === 'entries') deps.maxEntries = 0;
      if (mode === 'timeout') { let n = 0; deps.now = () => n++ * 1000; }
      expect((await cleanupFiles(deps, 'logs', abort.signal)).status).toBe('failed');
    }
    const deps = setup();
    deps.add(at('logs', 'app-2026-09-24.log'));
    deps.add(at('logs', 'app-2026-09-25.log'));
    deps.maxEntries = 1;
    expect((await cleanupFiles(deps, 'logs', new AbortController().signal)).status).toBe('partial');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { createDatabase } from '../persistence/db/connection.js';
import { createPlannerRepo } from '../persistence/planner-repo.js';
import { createPlannerTrackingStore } from '../persistence/planner-tracking-repo.js';
import { createWorkTracker } from './work-tracker.js';
import { plannerTrackingConfigSchema, plannerTrackingDefaults } from './config.js';
import type { PlannerTask } from '../planner/planner-contract.js';
import type { WorkSnapshot } from './tracking-contract.js';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.useRealTimers(); });
const evidence = (kind: 'prompt' | 'response' | 'agent' | 'skill' | 'pr' = 'prompt', completed = false) => ({
  id: kind, kind, completed, label: kind, text: kind === 'pr' ? 'https://github.com/o/r/pull/42' : 'Fix the lock release',
  at: '2026-04-04T10:00:00Z', sessionId: 's',
});
const proposal = (patch = {}) => ({
  key: 'fix-lock-release', existingTaskId: null, title: 'Fix lock release', notes: 'Release the lock when initialization fails.',
  done: false, evidenceIds: ['prompt'], ...patch,
});
function setup() {
  const db = createDatabase({ databasePath: ':memory:' });
  databases.push(db);
  const planner = createPlannerRepo(db);
  const store = createPlannerTrackingStore(db, true);
  let timestamp = Date.parse('2026-04-04T10:00:00Z');
  let sequence = 0;
  const snapshot: WorkSnapshot = { featureId: 'f', repoId: null, name: 'Lock fix', evidence: [evidence()] };
  const source = {
    page: vi.fn((_after: string, _since: string) => ['f']),
    read: vi.fn(async (_featureId: string, _signal: AbortSignal) => snapshot as WorkSnapshot | null),
    exists: vi.fn((_featureId: string, _repoId: string | null) => true),
  };
  const meta = { run: vi.fn(async () => JSON.stringify({ tasks: [proposal()] })) };
  const deps = {
    source, store, planner, meta,
    workspace: vi.fn((featureId: string) => ({ name: `Workspace ${featureId}`, repositoryName: 'org/repo' }) as { name: string; repositoryName: string | null } | null),
    clock: { now: () => new Date(timestamp), isoNow: () => new Date(timestamp).toISOString() },
    ids: { next: () => `t${++sequence}` }, config: plannerTrackingDefaults,
  };
  const tracker = createWorkTracker(deps);
  const tick = async () => { tracker.notify('f'); await tracker.tick(new AbortController().signal); };
  return {
    db, planner, store, snapshot, source, meta, deps, tracker, tick,
    advance: () => { timestamp += 120000; },
    change: () => { snapshot.name += '!'; },
  };
}
function manualTask(patch: Partial<PlannerTask> = {}): PlannerTask {
  return {
    id: 'manual', title: 'Fix lock release', notes: 'My notes', priority: 'p0', status: 'open', kind: 'task',
    prUrl: '', date: '2026-04-01', repoId: null, launchKind: 'session', featureId: 'f', sessionId: 's',
    launchLabel: 'Working on lock', backloggedAt: '2026-04-02', createdAt: '', updatedAt: '', ...patch,
  };
}

describe('incremental Planner work tracking', () => {
  it('exposes bounded named queue entries, stable enqueue times and defensive status snapshots', async () => {
    const f = setup();
    f.source.page.mockReturnValue([]);
    f.tracker.notify('f');
    const queuedAt = f.deps.clock.isoNow();
    f.advance();
    f.tracker.notify('f');
    f.tracker.notify('deleted');
    f.deps.workspace.mockImplementation((id) => id === 'deleted' ? null : { name: 'Workspace f', repositoryName: null });
    const queued = f.tracker.status();
    expect(queued).toMatchObject({
      queued: 2, pollIntervalMs: 15000, currentJob: null, lastRun: null,
      jobs: [
        { featureId: 'f', workspaceName: 'Workspace f', repositoryName: null, queuedAt, phase: 'queued', retryAt: null },
        { featureId: 'deleted', workspaceName: 'Unavailable workspace', repositoryName: null },
      ],
    });
    queued.jobs[0].workspaceName = 'Changed outside tracker';
    expect(f.tracker.status().jobs[0].workspaceName).toBe('Workspace f');
    let read!: (value: WorkSnapshot) => void;
    f.source.read.mockImplementation(() => new Promise((resolve) => { read = resolve; }));
    let finish!: (value: string) => void;
    f.meta.run.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.tracker.tick(new AbortController().signal);
    expect(f.tracker.status().currentJob).toMatchObject({ featureId: 'f', phase: 'reading', startedAt: f.deps.clock.isoNow(), queuedAt });
    f.tracker.status().currentJob!.workspaceName = 'Not the real name';
    expect(f.tracker.status().currentJob!.workspaceName).toBe('Workspace f');
    read(f.snapshot);
    await vi.waitFor(() => expect(f.meta.run).toHaveBeenCalled());
    expect(f.tracker.status().currentJob).toMatchObject({ workspaceName: 'Lock fix', phase: 'analyzing', evidenceCount: 1, sessionCount: 1 });
    expect(f.tracker.status().jobs.map((job) => job.featureId)).toEqual(['deleted']);
    finish(JSON.stringify({ tasks: [proposal()] }));
    await pending;
    expect(f.tracker.status()).toMatchObject({ currentJob: null, lastRun: { outcome: 'updated', taskCount: 1, finishedAt: f.deps.clock.isoNow() } });
    f.tracker.status().lastRun!.job.workspaceName = 'Not the real name';
    expect(f.tracker.status().lastRun!.job.workspaceName).toBe('Lock fix');
  });
  it('reports retry eligibility and distinguishes failures, skipped checks and empty successful passes', async () => {
    const f = setup();
    f.meta.run.mockRejectedValueOnce(new Error('Unavailable'));
    await f.tick();
    const retryAt = new Date(f.deps.clock.now().getTime() + f.deps.config.retryMs).toISOString();
    expect(f.tracker.status().lastRun).toMatchObject({ outcome: 'failed', taskCount: null, job: { retryAt } });
    f.tracker.notify('f');
    expect(f.tracker.status().jobs[0]).toMatchObject({ phase: 'retry-wait', retryAt });
    await f.tracker.tick(new AbortController().signal);
    expect(f.tracker.status().lastRun).toMatchObject({ outcome: 'retry-wait', job: { retryAt } });
    f.advance();
    f.meta.run.mockResolvedValue('{"tasks":[]}');
    await f.tick();
    expect(f.tracker.status().lastRun).toMatchObject({ outcome: 'updated', taskCount: 0, job: { retryAt: null } });
    await f.tick();
    expect(f.tracker.status().lastRun).toMatchObject({ outcome: 'unchanged', taskCount: null });
    f.source.read.mockResolvedValueOnce(null);
    await f.tick();
    expect(f.tracker.status().lastRun?.outcome).toBe('unavailable');
    f.snapshot.evidence = [];
    await f.tick();
    expect(f.tracker.status().lastRun).toMatchObject({ outcome: 'no-evidence', job: { evidenceCount: 0, sessionCount: 0 } });
  });
  it('does not starve discovery when one session continuously emits work notifications', async () => {
    const f = setup();
    const features = Array.from({ length: 24 }, (_, i) => `f${i.toString().padStart(2, '0')}`);
    f.source.page.mockImplementation((after) => features.filter((id) => id > after).slice(0, 16));
    f.source.read.mockImplementation(async (featureId) => ({ ...f.snapshot, featureId }));
    f.meta.run.mockResolvedValue('{"tasks":[]}');
    for (let i = 0; i < 40; i++) {
      f.tracker.notify('hot');
      await f.tracker.tick(new AbortController().signal);
      expect(f.tracker.status().queued).toBeLessThanOrEqual(16);
    }
    const visited = new Set(f.source.read.mock.calls.map(([featureId]) => featureId));
    expect(features.every((id) => visited.has(id))).toBe(true);
    expect(visited.has('hot')).toBe(true);
  });
  it('reserves discovery turns even when sixteen active workspaces continuously refill the queue', async () => {
    const f = setup();
    const features = Array.from({ length: 24 }, (_, i) => `f${i.toString().padStart(2, '0')}`);
    f.source.page.mockImplementation((after) => features.filter((id) => id > after).slice(0, 16));
    f.source.read.mockImplementation(async (featureId) => ({ ...f.snapshot, featureId }));
    f.meta.run.mockResolvedValue('{"tasks":[]}');
    for (let i = 0; i < 100; i++) {
      for (let j = 0; j < 16; j++) f.tracker.notify(`hot-${j}`);
      await f.tracker.tick(new AbortController().signal);
      expect(f.tracker.status().queued).toBeLessThanOrEqual(16);
    }
    const visited = new Set(f.source.read.mock.calls.map(([featureId]) => featureId));
    expect(features.every((id) => visited.has(id))).toBe(true);
    expect([...visited].some((id) => id.startsWith('hot-'))).toBe(true);
  });
  it('keeps unrelated HTTP requests responsive while AI is pending and notifications arrive concurrently', async () => {
    const f = setup();
    let finish!: (value: string) => void;
    f.meta.run.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.tick();
    await vi.waitFor(() => expect(f.meta.run).toHaveBeenCalled());
    const app = express();
    app.get('/unrelated', (_req, res) => res.json({ responsive: true }));
    const server = createServer(app);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address() as { port: number };
    try {
      for (let i = 0; i < 100; i++) f.tracker.notify(`other-${i}`);
      const responses = await Promise.all(Array.from({ length: 8 }, async () =>
        (await fetch(`http://127.0.0.1:${address.port}/unrelated`)).json()));
      expect(responses).toEqual(Array.from({ length: 8 }, () => ({ responsive: true })));
      expect(f.tracker.status()).toMatchObject({ running: true, queued: 16 });
      expect(f.planner.list()).toEqual([]);
    } finally {
      finish('{"tasks":[]}');
      await pending;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it('reports discovery failures without inventing a source checkpoint', async () => {
    const f = setup();
    f.source.page.mockImplementation(() => { throw new Error('database unavailable'); });
    await f.tracker.tick(new AbortController().signal);
    expect(f.tracker.status().error).toContain('retry');
    expect(f.store.cursor('f')).toBeNull();
  });
  it('preserves the successful checkpoint and existing tasks when a subsequent refresh fails', async () => {
    const f = setup();
    await f.tick();
    const fingerprint = f.store.cursor('f')!.fingerprint;
    const before = f.planner.list();
    f.change();
    f.meta.run.mockRejectedValue(new Error('Provider unavailable'));
    await f.tick();
    expect(f.store.cursor('f')).toMatchObject({ fingerprint, retryAfter: expect.any(Number) });
    expect(f.planner.list()).toEqual(before);
    expect(f.tracker.status().error).toContain('retry');
  });
  it('rejects explicit matches to a different PR instead of merging unrelated work', async () => {
    const f = setup();
    f.planner.create(manualTask({ prUrl: 'https://github.com/different/repo/pull/42' }));
    f.snapshot.evidence.push(evidence('pr'));
    f.meta.run.mockResolvedValue(JSON.stringify({ tasks: [proposal({ existingTaskId: 'manual', evidenceIds: ['prompt', 'pr'] })] }));
    await f.tick();
    expect(f.store.provenance('manual')).toBeNull();
    expect(f.tracker.status().error).not.toBeNull();
  });
  it('protects a PR association changed manually while extraction was in flight', async () => {
    const f = setup();
    f.planner.create(manualTask({ prUrl: 'https://github.com/o/r/pull/42' }));
    f.snapshot.evidence.push(evidence('pr'));
    f.meta.run.mockImplementation(async () => {
      f.planner.update(manualTask({ prUrl: 'https://github.com/other/repo/pull/42' }));
      return JSON.stringify({ tasks: [proposal({ existingTaskId: 'manual', evidenceIds: ['prompt', 'pr'] })] });
    });
    await f.tick();
    expect(f.planner.get('manual')?.prUrl).toContain('/other/repo/');
    expect(f.store.provenance('manual')).toBeNull();
    expect(f.tracker.status().error).not.toBeNull();
  });
  it('uses response-only completion dates conservatively when the prompt timestamp is missing', async () => {
    const f = setup();
    f.snapshot.evidence = [evidence('response', true)];
    f.meta.run.mockResolvedValue(JSON.stringify({ tasks: [proposal({ done: true, evidenceIds: ['response'] })] }));
    await f.tick();
    expect(f.planner.list()[0].date).toBe('2026-04-04');
  });
  it('creates concrete work promptly, updates completion, retains evidence, and skips unchanged/replayed work', async () => {
    const f = setup();
    expect(plannerTrackingConfigSchema.parse(plannerTrackingDefaults)).toEqual(plannerTrackingDefaults);
    await f.tick();
    const first = f.planner.list()[0];
    expect(first).toMatchObject({ title: 'Fix lock release', status: 'open', automaticallyTracked: true });
    expect(f.store.provenance(first.id)?.evidence).toHaveLength(1);
    await f.tick();
    expect(f.meta.run).toHaveBeenCalledTimes(1);
    f.snapshot.evidence.push(evidence('response', true));
    f.meta.run.mockResolvedValue(JSON.stringify({ tasks: [proposal({ existingTaskId: first.id, done: true, evidenceIds: ['response'] })] }));
    await f.tick();
    expect(f.planner.list()).toHaveLength(1);
    expect(f.planner.get(first.id)?.status).toBe('done');
    expect(f.store.provenance(first.id)).toMatchObject({ completion: 'reported-complete', evidence: [evidence(), evidence('response', true)] });
    const restarted = createWorkTracker(f.deps);
    await restarted.tick(new AbortController().signal);
    expect(f.meta.run).toHaveBeenCalledTimes(2);
    expect(f.tracker.status()).toMatchObject({ enabled: true, running: false, error: null, lastUpdatedAt: expect.any(String) });
  });

  it('preserves edited fields permanently, dates, priority, backlog, and launch metadata', async () => {
    const f = setup();
    await f.tick();
    const first = f.planner.list()[0];
    f.planner.update({ ...first, title: 'My wording', notes: 'My details', status: 'done', date: '2020-01-01', priority: 'p1', backloggedAt: '2020-02-01' });
    f.change();
    f.meta.run.mockResolvedValue(JSON.stringify({ tasks: [proposal({ existingTaskId: first.id })] }));
    await f.tick();
    expect(f.planner.get(first.id)).toMatchObject({ title: 'My wording', notes: 'My details', status: 'done', date: '2020-01-01', priority: 'p1', backloggedAt: '2020-02-01' });
    // Returning to a formerly generated value does not silently unlock a field.
    f.planner.update({ ...f.planner.get(first.id)!, title: 'Fix lock release' });
    f.change();
    f.meta.run.mockResolvedValue(JSON.stringify({ tasks: [proposal({ existingTaskId: first.id, title: 'Reworded by AI' })] }));
    await f.tick();
    expect(f.planner.get(first.id)?.title).toBe('Fix lock release');
  });

  it('links existing manual/launched work without overwriting it', async () => {
    const f = setup();
    f.planner.create(manualTask());
    await f.tick();
    expect(f.planner.list()).toEqual([{ ...manualTask(), updatedAt: f.deps.clock.isoNow(), automaticallyTracked: true }]);
    expect(f.store.provenance('manual')).not.toBeNull();
  });

  it('keeps deletion tombstones across restart and accepts model matches to deleted work without resurrection', async () => {
    const f = setup();
    await f.tick();
    const id = f.planner.list()[0].id;
    f.planner.delete(id);
    f.change();
    await f.tick();
    expect(f.planner.list()).toEqual([]);
    f.change();
    f.meta.run.mockResolvedValue(JSON.stringify({ tasks: [proposal({ existingTaskId: id })] }));
    await createWorkTracker(f.deps).tick(new AbortController().signal);
    expect(f.planner.list()).toEqual([]);
  });

  it('splits independent deliverables and deduplicates equivalent proposed titles in one pass', async () => {
    const f = setup();
    f.meta.run.mockResolvedValue(JSON.stringify({ tasks: [proposal(), proposal({ key: 'add-failure-test', title: 'Test failure cleanup' })] }));
    await f.tick();
    expect(f.planner.list()).toHaveLength(2);
    f.change();
    f.meta.run.mockResolvedValue(JSON.stringify({ tasks: [proposal(), proposal({ key: 'alias', existingTaskId: 't1' })] }));
    await f.tick();
    expect(f.planner.list()).toHaveLength(2);
  });

  it('does not merge same-number PRs from different repositories', async () => {
    const f = setup();
    f.snapshot.evidence.push(evidence('pr'));
    f.meta.run.mockResolvedValue(JSON.stringify({ tasks: [proposal({ evidenceIds: ['prompt', 'pr'] })] }));
    await f.tick();
    f.snapshot.evidence[1] = { ...evidence('pr'), text: 'https://github.com/other/repo/pull/42' };
    await f.tick();
    expect(f.planner.list().map((task) => task.prUrl).sort()).toEqual([
      'https://github.com/o/r/pull/42', 'https://github.com/other/repo/pull/42',
    ]);
  });

  it.each([
    'not json',
    'x'.repeat(20001),
    JSON.stringify({ tasks: [proposal(), proposal()] }),
    JSON.stringify({ tasks: [proposal({ evidenceIds: ['invented'] })] }),
    JSON.stringify({ tasks: [proposal({ evidenceIds: ['skill'] })] }),
    JSON.stringify({ tasks: [proposal({ done: true })] }),
    JSON.stringify({ tasks: [proposal({ existingTaskId: 'foreign-task' })] }),
    JSON.stringify({ tasks: [proposal({ title: '' })] }),
  ])('rejects invalid/untrusted extraction atomically and backs off: %s', async (raw) => {
    const f = setup();
    f.snapshot.evidence.push(evidence('skill'));
    f.meta.run.mockResolvedValue(raw);
    await f.tick();
    expect(f.planner.list()).toEqual([]);
    expect(f.tracker.status().error).toContain('retry');
    await f.tick();
    expect(f.meta.run).toHaveBeenCalledTimes(1);
    f.advance();
    f.meta.run.mockResolvedValue('```json\n{"tasks":[]}\n```');
    await f.tick();
    expect(f.tracker.status().error).toBeNull();
  });

  it('captures truthful completed agent evidence and reuses a stable key even after a title changes', async () => {
    const f = setup();
    f.snapshot.evidence = [evidence('agent', true)];
    f.meta.run.mockResolvedValue(JSON.stringify({ tasks: [proposal({ done: true, evidenceIds: ['agent'] })] }));
    await f.tick();
    f.change();
    f.meta.run.mockResolvedValue(JSON.stringify({ tasks: [proposal({ title: 'Lock cleanup complete', done: true, evidenceIds: ['agent'] })] }));
    await f.tick();
    expect(f.planner.list()).toHaveLength(1);
    expect(f.planner.list()[0]).toMatchObject({ title: 'Lock cleanup complete', status: 'done' });
  });

  it('pauses durably, resumes, bounds the queue, honors already-aborted parents and stops', async () => {
    const f = setup();
    f.tracker.setEnabled(false);
    await f.tick();
    expect(f.meta.run).not.toHaveBeenCalled();
    expect(createWorkTracker(f.deps).status().enabled).toBe(false);
    f.tracker.setEnabled(true);
    const parent = new AbortController();
    parent.abort();
    await f.tracker.tick(parent.signal);
    expect(f.source.read).not.toHaveBeenCalled();
    for (let i = 0; i < 30; i++) f.tracker.notify(`f${i}`);
    expect(f.tracker.status().queued).toBe(16);
    f.tracker.stop();
    f.tracker.notify('ignored');
    await f.tick();
    expect(f.tracker.status().queued).toBe(0);
    expect(f.meta.run).not.toHaveBeenCalled();
  });

  it.each(['pause', 'stop', 'parent', 'deleted', 'moved'] as const)('fences in-flight results after %s', async (reason) => {
    const f = setup();
    let finish!: (value: string) => void;
    f.meta.run.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const parent = new AbortController();
    const pending = f.tracker.tick(parent.signal);
    await vi.waitFor(() => expect(f.meta.run).toHaveBeenCalled());
    await f.tracker.tick(parent.signal);
    expect(f.meta.run).toHaveBeenCalledTimes(1);
    if (reason === 'pause') f.tracker.setEnabled(false);
    if (reason === 'stop') f.tracker.stop();
    if (reason === 'parent') parent.abort();
    if (reason === 'deleted' || reason === 'moved') f.source.exists.mockReturnValue(false);
    finish(JSON.stringify({ tasks: [proposal()] }));
    await pending;
    expect(f.planner.list()).toEqual([]);
    expect(f.tracker.status().error).toBeNull();
    expect(f.tracker.status().lastRun?.outcome).toBe('cancelled');
  });

  it('reports timeout failures and retries without advancing the successful fingerprint', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.meta.run.mockImplementation((request?: unknown) => new Promise((_resolve, reject) => {
      (request as { signal: AbortSignal }).signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = f.tick();
    await vi.advanceTimersByTimeAsync(60001);
    await pending;
    expect(f.tracker.status().error).toContain('retry');
    expect(f.store.cursor('f')?.fingerprint).toBe('');
  });

  it('skips missing/empty sources and empty discovery pages without AI', async () => {
    const f = setup();
    f.source.page.mockReturnValue([]);
    await f.tracker.tick(new AbortController().signal);
    f.source.read.mockResolvedValue(null);
    await f.tick();
    f.snapshot.evidence = [];
    f.source.read.mockResolvedValue(f.snapshot);
    await f.tick();
    expect(f.meta.run).not.toHaveBeenCalled();
  });

  it('does not apply proposed matches moved to a different repository during analysis', async () => {
    const f = setup();
    f.planner.create(manualTask());
    f.meta.run.mockImplementation(async () => {
      f.planner.update(manualTask({ repoId: 'different-repo' }));
      return JSON.stringify({ tasks: [proposal({ existingTaskId: 'manual' })] });
    });
    await f.tick();
    expect(f.store.provenance('manual')).toBeNull();
  });

  it('rolls back both task writes and checkpoints on storage failure', async () => {
    const f = setup();
    vi.spyOn(f.store, 'save').mockImplementation(() => { throw new Error('disk full'); });
    await f.tick();
    expect(f.planner.list()).toEqual([]);
    expect(f.store.cursor('f')?.fingerprint).toBe('');
  });
});

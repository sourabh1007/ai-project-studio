import { describe, expect, it, vi } from 'vitest';
import type { NewTaskRun, NewTaskService } from '../new-task/new-task-contract.js';
import { mobileDefaults } from './config.js';
import { mobileHash } from './mobile-access.js';
import { createMobileService, type MobileServiceDeps } from './mobile-service.js';
import type { MobileChatRecord } from './mobile-contract.js';

const first = { id: 'chat', repoId: 'repo', problem: 'Improve the app' };
function harness(config: Partial<typeof mobileDefaults> = {}) {
  const store = new Map<string, MobileChatRecord>();
  let now = Date.parse('2026-01-01T00:00:00Z');
  let id = 0;
  let run: NewTaskRun | null = null;
  const base: NewTaskRun = {
    id: 'attachment', featureId: 'feature', problem: first.problem, context: '', status: 'planned',
    plan: 'Reviewed plan', branch: 'users/dev/improve', prNumber: null, prUrl: null,
    reviewFeatureId: null, error: null, agents: [], planLog: [], title: null, summary: null,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  };
  const task: NewTaskService = {
    get: () => run,
    saveInputs: vi.fn(() => { run = { ...base }; return run; }),
    plan: vi.fn(async () => run!),
    clarify: vi.fn(),
    refine: vi.fn(async () => ({ reply: 'Here is a revision', proposal: 'Revised plan', run: run! })),
    applyRefinedPlan: vi.fn((_id, plan) => { run = { ...run!, plan }; return run; }),
    implement: vi.fn(async (_id, sink) => {
      sink.activity({ phase: 'implementing', line: 'working' });
      sink.agent?.({ id: 'dev', parentId: null, role: 'developer', title: 'Developer', status: 'done',
        files: [], startedAt: null, durationMs: 1, inputTokens: null, outputTokens: null, credits: null });
      sink.done(run!, [{ path: 'file.ts', changeType: 'modified' }]);
    }),
    reset: vi.fn(),
    fileDiff: vi.fn(async () => ({ path: 'file.ts', diff: '+new', content: 'new' })),
  };
  const deps: MobileServiceDeps = {
    config: { ...mobileDefaults, ...config },
    repo: {
      get: (key) => structuredClone(store.get(key) ?? null),
      list: () => structuredClone([...store.values()]),
      save: (chat) => { store.set(chat.id, structuredClone(chat)); },
    },
    task,
    getRun: () => run,
    saveRun: (next) => { run = next; },
    createTask: vi.fn(() => ({ featureId: 'feature', attachmentId: 'attachment' })),
    repositories: () => [{ id: 'repo', name: 'owner/repo' }],
    revision: vi.fn(async () => ({ head: 'a'.repeat(40), branch: base.branch!, baseBranch: 'main', remoteUrl: 'https://github.com/owner/repo.git', files: [{ path: 'file.ts', changeType: 'modified' as const }] })),
    publish: vi.fn(async () => { run = { ...run!, status: 'pr-created', prUrl: 'https://github.com/owner/repo/pull/1' }; return run; }),
    createTerminal: vi.fn(async () => 'terminal'),
    endTerminal: vi.fn(async () => undefined),
    terminalRunning: () => true,
    own: async (operation) => operation(new AbortController().signal),
    now: () => new Date(now).toISOString(),
    id: () => `id-${++id}`,
    report: vi.fn(),
    importRepository: vi.fn(async () => ({ id: 'imported', name: 'owner/repo', remoteUrl: 'https://github.com/owner/repo.git', defaultBranch: 'main' })),
  };
  const service = createMobileService(deps);
  const planned = async () => { service.create(first); await service.waitForIdle(); return service.get(first.id); };
  const implemented = async () => {
    const chat = await planned();
    service.implement(first.id, chat.planHash!);
    await service.waitForIdle();
    return service.get(first.id);
  };
  return { service, deps, store, task, planned, implemented, base,
    setRun: (next: NewTaskRun | null) => { run = next; }, advance: (ms: number) => { now += ms; } };
}

describe('durable mobile approvals', () => {
  it('requires distinct plan and exact-revision publication approvals, deduplicating retries', async () => {
    const h = harness();
    expect(h.service.create(first).status).toBe('planning');
    expect(h.service.create(first).id).toBe(first.id);
    await h.service.waitForIdle();
    expect(h.service.bootstrap().chats[0].status).toBe('plan-ready');
    const planHash = h.service.get(first.id).planHash!;
    h.service.implement(first.id, planHash);
    h.service.implement(first.id, planHash);
    await h.service.waitForIdle();
    expect(h.task.implement).toHaveBeenCalledWith('attachment', expect.any(Object), expect.any(AbortSignal), { deferPublication: true });
    expect(h.deps.publish).not.toHaveBeenCalled();
    expect(h.service.get(first.id).status).toBe('review-changes');
    h.service.implement(first.id, planHash);
    expect(h.task.implement).toHaveBeenCalledTimes(1);
    const preview = await h.service.preview(first.id);
    const approval = preview.approval!;
    h.service.publish(first.id, approval.id);
    h.service.publish(first.id, approval.id);
    await h.service.waitForIdle();
    expect(h.service.get(first.id).status).toBe('pr-created');
    h.service.publish(first.id, approval.id);
    expect(h.deps.publish).toHaveBeenCalledTimes(1);
    expect(h.deps.publish).toHaveBeenCalledWith(expect.any(Object), approval, expect.any(AbortSignal));
    expect(await h.service.diff(first.id, 'file.ts')).toMatchObject({ diff: '+new' });
  });
  it('validates task identity, repository and bounded admission', async () => {
    const h = harness({ maxChats: 1 });
    expect(() => h.service.get('absent')).toThrow('not found');
    expect(() => h.service.create({ ...first, repoId: 'unknown' })).toThrow('GitHub');
    await h.planned();
    expect(() => h.service.create({ ...first, repoId: 'other' })).toThrow('another conversation');
    expect(() => h.service.create({ ...first, problem: 'other' })).toThrow('another conversation');
    expect(() => h.service.create({ ...first, id: 'second' })).toThrow('limit');
    const empty = h.store.get(first.id)!;
    h.setRun(null);
    expect(h.service.get(first.id).planHash).toBeNull();
    h.setRun({ ...h.base, plan: '' });
    expect(h.service.get(first.id).planHash).toBeNull();
    expect(h.service.terminalAllowed('unknown')).toBe(false);
    h.store.set(first.id, { ...empty, status: 'planning' });
    expect(h.service.get(first.id).status).toBe('interrupted');
    expect(h.service.get(first.id).error).toContain('Nothing was retried');
  });
  it('supports durable conversation and explicit acceptance without silently changing a plan', async () => {
    const h = harness();
    await h.planned();
    h.service.discuss(first.id, { id: 'turn', text: 'Please revise' });
    expect(() => h.service.discuss(first.id, { id: 'turn', text: 'Different text' })).toThrow('another message');
    const assistantId = h.store.get(first.id)!.messages.find((entry) => entry.role === 'assistant')!.id;
    expect(() => h.service.discuss(first.id, { id: assistantId, text: 'Forged reply' })).toThrow('another message');
    expect(() => h.service.discuss(first.id, { id: 'another', text: 'Wait' })).toThrow('progress');
    h.service.discuss(first.id, { id: 'turn', text: 'Please revise' });
    await h.service.waitForIdle();
    expect(h.service.get(first.id).proposal).toBe('Revised plan');
    expect(() => h.service.applyPlan(first.id, 'forged plan')).toThrow('changed');
    h.service.applyPlan(first.id, 'Revised plan');
    expect(h.service.get(first.id).planHash).toBe(mobileHash('Revised plan'));
    expect(() => h.service.applyPlan(first.id, 'Revised plan')).toThrow('changed');
    const chat = h.store.get(first.id)!;
    chat.messages = Array.from({ length: 180 }, (_, index) => ({ id: `m${index}`, role: 'user', text: 'x', at: '' }));
    h.store.set(first.id, chat);
    expect(() => h.service.discuss(first.id, { id: 'overflow', text: 'no' })).toThrow('full');
  });
  it('bounds repository imports and releases admission after failures', async () => {
    const h = harness({ maxJobs: 1 });
    let settle!: () => void;
    vi.mocked(h.deps.importRepository).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { settle = resolve; });
      return { id: 'repo', name: 'owner/repo', remoteUrl: 'https://github.com/owner/repo.git', defaultBranch: 'main' };
    });
    const pending = h.service.importRepository('owner/repo');
    await expect(h.service.importRepository('owner/repo')).rejects.toThrow('already running');
    await expect(h.service.importRepository('Owner/Repo')).rejects.toThrow('already running');
    await expect(h.service.importRepository('other/repo')).rejects.toThrow('limit');
    expect(() => h.service.create(first)).toThrow('limit');
    settle();
    expect(await pending).toMatchObject({ defaultBranch: 'main' });
    vi.mocked(h.deps.importRepository).mockRejectedValueOnce(new Error('Clone failed'));
    await expect(h.service.importRepository('owner/repo')).rejects.toThrow('Clone failed');
    await expect(h.service.importRepository('owner/repo')).resolves.toMatchObject({ id: 'imported' });
  });
  it('retries only an explicitly requested failed initial plan, never an existing implementation', async () => {
    const h = harness();
    await h.planned();
    expect(() => h.service.retryPlan(first.id)).toThrow('Only an interrupted');
    h.store.get(first.id)!.status = 'interrupted';
    expect(() => h.service.retryPlan(first.id)).toThrow('Only an interrupted');
    h.setRun(null);
    expect(() => h.service.retryPlan(first.id)).toThrow('Only an interrupted');
    h.setRun({ ...h.base, plan: null });
    h.store.get(first.id)!.files = [{ path: 'preserve', changeType: 'modified' }];
    expect(() => h.service.retryPlan(first.id)).toThrow('preserved');
    h.store.get(first.id)!.files = [];
    vi.mocked(h.task.plan).mockImplementationOnce(async () => { h.setRun(h.base); return h.base; });
    h.service.retryPlan(first.id);
    await h.service.waitForIdle();
    expect(h.service.get(first.id).status).toBe('plan-ready');
    for (const result of [{ ...h.base, plan: null }, { ...h.base, status: 'failed' as const }]) {
      h.setRun({ ...h.base, plan: null });
      h.store.get(first.id)!.status = 'failed';
      vi.mocked(h.task.plan).mockResolvedValueOnce(result);
      h.service.retryPlan(first.id);
      await h.service.waitForIdle();
      expect(h.service.get(first.id).error).toContain('complete plan');
    }
  });
  it('limits history size and retains system messages outside AI discussion history', async () => {
    const h = harness();
    await h.implemented();
    h.service.discuss(first.id, { id: 'followup', text: 'Explain' });
    await h.service.waitForIdle();
    const history = vi.mocked(h.task.refine).mock.calls[0][1];
    expect(history.every((entry) => entry.role !== ('system' as string))).toBe(true);
    const record = h.store.get(first.id)!;
    record.messages = [{ id: 'huge', role: 'user', text: 'x'.repeat(200001), at: '' }];
    expect(() => h.service.discuss(first.id, { id: 'too-much', text: 'no' })).toThrow('history limit');
  });
  it('bounds read operations and excludes concurrent mutation while reviewing a commit', async () => {
    const h = harness({ maxJobs: 1 });
    await h.implemented();
    let release!: () => void;
    const original = h.deps.revision;
    vi.mocked(h.deps.revision).mockImplementationOnce(async (record) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return original(record);
    });
    const reviewing = h.service.preview(first.id);
    expect(() => h.service.implement(first.id, 'changed')).toThrow('progress');
    await expect(h.service.diff(first.id, 'file.ts')).rejects.toThrow('busy');
    const other = { ...h.store.get(first.id)!, id: 'other' };
    h.store.set('other', other);
    expect(() => h.service.implement('other', 'changed')).toThrow('worker limit');
    await expect(h.service.diff('other', 'file.ts')).rejects.toThrow('busy');
    release();
    await reviewing;
    h.store.get(first.id)!.status = 'plan-ready';
    let finish!: () => void;
    vi.mocked(h.task.fileDiff).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { path: 'file.ts', diff: '', content: '' };
    });
    const diff = h.service.diff(first.id, 'file.ts');
    await expect(h.service.diff(first.id, 'file.ts')).rejects.toThrow('busy');
    finish();
    await diff;
    h.service.implement(first.id, mobileHash(h.base.plan!));
    await expect(h.service.diff(first.id, 'file.ts')).rejects.toThrow('busy');
    await h.service.waitForIdle();
  });
  it('replaces in-progress agent snapshots without losing other agents and uses a supplied PR title', async () => {
    const h = harness();
    await h.implemented();
    const current = h.service.get(first.id).run!;
    h.setRun({ ...current, title: 'Reviewed title', agents: [...current.agents, { ...current.agents[0], id: 'other' }] });
    h.store.get(first.id)!.status = 'plan-ready';
    h.service.implement(first.id, mobileHash(current.plan!));
    await h.service.waitForIdle();
    expect(h.service.get(first.id).run!.agents.map((agent) => agent.id)).toEqual(['other', 'dev']);
    expect((await h.service.preview(first.id)).approval!.title).toBe('Reviewed title');
  });
  it('rejects missing, changed or frozen plans', async () => {
    const h = harness();
    await h.planned();
    expect(() => h.service.implement(first.id, 'bad')).toThrow('plan changed');
    for (const patch of [{ plan: null }, { branch: null }, { status: 'pr-created' as const }]) {
      h.setRun({ ...h.base, ...patch });
      expect(() => h.service.implement(first.id, 'bad')).toThrow('unpublished plan');
    }
    h.setRun(null);
    expect(() => h.service.implement(first.id, 'bad')).toThrow('unpublished plan');
    h.setRun(h.base);
    h.store.get(first.id)!.status = 'pr-created';
    expect(() => h.service.implement(first.id, 'bad')).toThrow('plan changed');
  });
  it('requires terminal owner consent and exclusive worktree ownership until explicitly ended', async () => {
    const h = harness();
    const chat = await h.planned();
    await expect(h.service.terminal(first.id, false)).rejects.toThrow('consent');
    await h.service.terminal(first.id, true);
    await h.service.terminal(first.id, true);
    expect(h.deps.createTerminal).toHaveBeenCalledTimes(1);
    expect(h.service.get(first.id).terminalRunning).toBe(true);
    expect(h.service.terminalAllowed('terminal')).toBe(true);
    expect(() => h.service.implement(first.id, chat.planHash!)).toThrow('End the terminal');
    h.store.get(first.id)!.status = 'publishing';
    expect(h.service.terminalAllowed('terminal')).toBe(false);
    h.store.get(first.id)!.status = 'plan-ready';
    await h.service.closeTerminal(first.id);
    await h.service.closeTerminal(first.id);
    expect(h.deps.endTerminal).toHaveBeenCalledTimes(1);
    expect(h.service.terminalAllowed('terminal')).toBe(false);
  });
  it('bounds terminal setup, permits cancellation, and never reports an unfinished terminal as ended', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ jobTimeoutMs: 1000 });
      await h.planned();
      vi.mocked(h.deps.createTerminal).mockImplementationOnce(async (_chat, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Terminal setup expired')), { once: true });
      }));
      const pending = h.service.terminal(first.id, true);
      const rejected = expect(pending).rejects.toThrow('Terminal setup expired');
      await expect(h.service.closeTerminal(first.id)).rejects.toThrow('terminal setup');
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(h.service.get(first.id).terminalSessionId).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('bounds the durable approval audit without silently truncating owner approvals', async () => {
    const h = harness();
    await h.planned();
    const record = h.store.get(first.id)!;
    record.messages = Array.from({ length: 256 }, (_, index) => ({ id: `audit${index}`, role: 'system', text: 'Approval', at: '' }));
    expect(() => h.service.implement(first.id, mobileHash(h.base.plan!))).toThrow('audit limit');
    record.messages = [{ id: 'large', role: 'system', text: 'a'.repeat(400000), at: '' }];
    expect(() => h.service.implement(first.id, mobileHash(h.base.plan!))).toThrow('audit limit');
    expect(h.task.implement).not.toHaveBeenCalled();
  });
  it('rejects unreviewed, expired and mismatched publication approvals', async () => {
    const h = harness();
    await h.planned();
    await expect(h.service.preview(first.id)).rejects.toThrow('Complete an implementation');
    await h.implemented();
    expect(() => h.service.publish(first.id, 'absent')).toThrow('missing');
    const preview = await h.service.preview(first.id);
    expect(() => h.service.publish(first.id, 'wrong')).toThrow('missing');
    h.advance(mobileDefaults.approvalTtlMs);
    expect(() => h.service.publish(first.id, preview.approval!.id)).toThrow('expired');
    expect(h.deps.publish).not.toHaveBeenCalled();
  });
  it.each(['head', 'branch', 'baseBranch', 'remoteUrl', 'repoId'] as const)('invalidates a changed %s before publication', async (key) => {
    const h = harness();
    await h.implemented();
    const preview = await h.service.preview(first.id);
    if (key === 'repoId') h.store.get(first.id)!.approval!.repoId = 'changed';
    else vi.mocked(h.deps.revision).mockResolvedValueOnce({ ...preview.approval!, files: preview.files, [key]: 'changed' });
    h.service.publish(first.id, preview.approval!.id);
    await h.service.waitForIdle();
    expect(h.service.get(first.id).status).toBe('failed');
    expect(h.deps.publish).not.toHaveBeenCalled();
  });
  it('detects concurrent state changes during asynchronous revision review', async () => {
    const h = harness();
    await h.implemented();
    vi.mocked(h.deps.revision).mockImplementationOnce(async () => {
      h.store.get(first.id)!.version++;
      return { head: 'a'.repeat(40), branch: 'branch', baseBranch: 'main', remoteUrl: 'remote', files: [] };
    });
    await expect(h.service.preview(first.id)).rejects.toThrow('Conversation changed');
  });
  it('reports provider failures and rejects incomplete implementation results', async () => {
    const h = harness();
    vi.mocked(h.task.plan).mockResolvedValueOnce({ ...h.base, plan: null });
    await h.planned();
    expect(h.service.get(first.id).status).toBe('failed');
    h.setRun(h.base);
    vi.mocked(h.task.implement).mockImplementationOnce(async (_id, sink) => { sink.failed('Tests failed'); });
    h.service.implement(first.id, mobileHash(h.base.plan!));
    await h.service.waitForIdle();
    expect(h.service.get(first.id).error).toBe('Tests failed');
    vi.mocked(h.task.implement).mockImplementationOnce(async () => undefined);
    h.service.implement(first.id, mobileHash(h.base.plan!));
    await h.service.waitForIdle();
    expect(h.service.get(first.id).error).toContain('without a result');
    vi.mocked(h.task.implement).mockImplementationOnce(async (_id, sink) => {
      h.setRun(null);
      sink.agent?.({ id: 'gone', parentId: null, role: 'developer', title: 'Gone', status: 'done',
        files: [], startedAt: null, durationMs: null, inputTokens: null, outputTokens: null, credits: null });
      sink.done(h.base);
    });
    h.service.implement(first.id, mobileHash(h.base.plan!));
    await h.service.waitForIdle();
    expect(h.service.get(first.id).files).toEqual([]);
  });
  it('cancels and times out bounded work without replay; publication cancellation is rejected', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ maxJobs: 1, jobTimeoutMs: 1000 });
      vi.mocked(h.task.plan).mockImplementationOnce(async (_id, signal) => new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      }));
      h.service.create(first);
      expect(() => h.service.create({ ...first, id: 'second' })).toThrow('limit');
      h.service.cancel(first.id);
      await h.service.waitForIdle();
      expect(h.service.get(first.id).status).toBe('interrupted');
      h.service.cancel(first.id);
      const timed = harness({ jobTimeoutMs: 1000 });
      vi.mocked(timed.task.plan).mockImplementationOnce(async (_id, signal) => new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject('Deadline reached'), { once: true });
      }));
      timed.service.create(first);
      await vi.advanceTimersByTimeAsync(1000);
      await timed.service.waitForIdle();
      expect(timed.service.get(first.id).error).toBe('Deadline reached');
      const publishing = harness();
      await publishing.implemented();
      await publishing.service.preview(first.id);
      const approval = publishing.store.get(first.id)!.approval!;
      publishing.service.publish(first.id, approval.id);
      expect(() => publishing.service.cancel(first.id)).toThrow('may already');
      await publishing.service.waitForIdle();
    } finally { vi.useRealTimers(); }
  });
});

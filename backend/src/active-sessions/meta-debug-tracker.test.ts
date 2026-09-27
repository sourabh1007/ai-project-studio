import { describe, expect, it, vi } from 'vitest';
import type { MetaOperation, MetaOperationRepo } from '../meta/meta-operation-contract.js';
import { activeSessionsConfigSchema, activeSessionsDefaults, ACTIVE_SESSIONS_NAMESPACE } from './config.js';
import { createMetaDebugTracker, observeMetaOperations, observeMetaRunner } from './meta-debug-tracker.js';
import { redactDebugText } from './debug-redaction.js';

export function operation(overrides: Partial<MetaOperation> = {}): MetaOperation {
  return {
    operationId: 'op', featureId: 'feature', automationId: null, originSessionId: null,
    providerId: 'copilot', requestedModel: 'auto', resolvedModel: null, sessionId: 'cold',
    providerSessionId: null, sessionIds: ['cold'], transport: 'session', state: 'running',
    outcome: 'unknown', purpose: 'review', label: 'Review change', resultText: null,
    errorMessage: null, usageState: 'unknown', usage: null, createdAt: 't', updatedAt: 't',
    startedAt: 't', finishedAt: null, ...overrides,
  };
}

describe('bounded read-only metasession observation', () => {
  it('owns validated configuration and redacts credential formats', () => {
    expect(ACTIVE_SESSIONS_NAMESPACE).toBe('activeSessions');
    expect(activeSessionsConfigSchema.parse(activeSessionsDefaults)).toEqual(activeSessionsDefaults);
    expect(activeSessionsConfigSchema.safeParse({ ...activeSessionsDefaults, maxOperations: 0 }).success).toBe(false);
    const text = '\x1b[31m\x00ghp_abc github_pat_xyz sk-1234567890123456 eyJabc.abc.xyz Bearer token123 Basic abcd https://user:pass@example.com token="sensitive" password=hidden api_key: \'secret\'\n-----BEGIN PRIVATE KEY-----\nkeydata\n-----END PRIVATE KEY-----';
    const safe = redactDebugText(text);
    for (const secret of ['ghp_abc', 'github_pat_xyz', 'sk-1234567890123456', 'eyJabc', 'token123', 'abcd', 'user:pass', 'sensitive', 'hidden', "'secret'", 'keydata']) expect(safe).not.toContain(secret);
    expect(safe).toContain('[redacted]');
    expect(redactDebugText('ordinary tool finished')).toBe('ordinary tool finished');
  });

  it('retains bounded safe metadata, activity and output without prompts', () => {
    const tracker = createMetaDebugTracker({ ...activeSessionsDefaults, maxActivityLines: 2, maxTextCharacters: 5 });
    tracker.activity('missing', 'ignored');
    tracker.observe(operation());
    tracker.activity('op', '');
    tracker.activity('op', '🔧 running shell · curl -H password=secret');
    tracker.activity('op', 'token=secret');
    tracker.activity('op', 'third');
    tracker.observe(operation({ resultText: 'abcdefgh', errorMessage: 'Bearer auth', label: null, purpose: null }));
    expect(tracker.get('op')).toMatchObject({ output: 'defgh', error: 'Bearer [redacted]', activity: ['token=[redacted]', 'third'], truncated: true });
    expect(tracker.bySession('cold')).toBe(tracker.get('op'));
    expect(tracker.bySession('absent')).toBeUndefined();
    tracker.forget(() => false);
    expect(tracker.get('op')).toBeDefined();
    tracker.forget(() => true);
    expect(tracker.bySession('cold')).toBeUndefined();
  });

  it('evicts old observations without removing a reused session association', () => {
    const tracker = createMetaDebugTracker({ ...activeSessionsDefaults, maxOperations: 1 });
    tracker.observe(operation());
    tracker.observe(operation({ operationId: 'new' }));
    expect(tracker.get('op')).toBeUndefined();
    expect(tracker.bySession('cold')?.operationId).toBe('new');
    tracker.observe(operation({ operationId: 'third', sessionIds: ['third'], sessionId: 'third' }));
    expect(tracker.bySession('cold')).toBeUndefined();
  });

  it('preserves successful and failed repository write/delete semantics', () => {
    const tracker = createMetaDebugTracker(activeSessionsDefaults);
    const base: MetaOperationRepo = {
      create: vi.fn(), update: vi.fn(() => true), complete: vi.fn(() => true), get: vi.fn(() => null),
      listPage: vi.fn(() => ({ items: [], nextCursor: null })), listUnfinishedPage: vi.fn(() => ({ items: [], nextCursor: null })),
      deleteByFeature: vi.fn(), deleteBySession: vi.fn(), deleteByAutomation: vi.fn(),
    };
    base.get = vi.fn(function (this: MetaOperationRepo) {
      expect(this).toBe(base);
      return null;
    });
    const repo = observeMetaOperations(base, tracker);
    repo.create(operation());
    expect(tracker.get('op')).toBeDefined();
    expect(repo.update(operation({ label: 'updated' }))).toBe(true);
    expect(repo.complete(operation({ state: 'completed' }), null)).toBe(true);
    vi.mocked(base.update).mockReturnValue(false);
    vi.mocked(base.complete).mockReturnValue(false);
    expect(repo.update(operation({ label: 'not saved' }))).toBe(false);
    expect(repo.complete(operation({ label: 'not saved' }), null)).toBe(false);
    expect(tracker.get('op')?.label).toBe('Review change');
    repo.deleteBySession('missing');
    expect(tracker.get('op')).toBeDefined();
    repo.deleteBySession('cold');
    expect(tracker.get('op')).toBeUndefined();
    repo.create(operation({ originSessionId: 'parent' }));
    repo.deleteBySession('parent');
    expect(tracker.get('op')).toBeUndefined();
    repo.create(operation({ sessionId: null }));
    repo.deleteBySession('cold');
    expect(tracker.get('op')).toBeUndefined();
    repo.create(operation());
    repo.deleteByFeature('other');
    expect(tracker.get('op')).toBeDefined();
    repo.deleteByFeature('feature');
    expect(tracker.get('op')).toBeUndefined();
    expect(base.deleteByFeature).toHaveBeenCalledWith('feature');
    repo.create(operation({ automationId: 'automation' }));
    repo.deleteByAutomation('other');
    expect(tracker.get('op')).toBeDefined();
    repo.deleteByAutomation('automation');
    expect(tracker.get('op')).toBeUndefined();
    expect(repo.get('none')).toBeNull();
    const extended = { ...base, refreshUsage: vi.fn(() => 'refreshed') };
    expect(observeMetaOperations(extended, tracker).refreshUsage()).toBe('refreshed');
  });

  it('forwards existing callbacks, results and errors without a second run', async () => {
    const tracker = createMetaDebugTracker(activeSessionsDefaults);
    tracker.observe(operation());
    const runDetailed = vi.fn(async (request: Parameters<ReturnType<typeof observeMetaRunner>['runDetailed']>[0]) => {
      request.onActivity?.('reading');
      return { text: 'done', sessionId: 'cold' };
    });
    const run = vi.fn();
    const runner = observeMetaRunner({ runDetailed, run }, tracker);
    const onActivity = vi.fn();
    expect(await runner.runDetailed({ featureId: 'f', prompt: 'SECRET PROMPT', operationId: 'op', onActivity })).toEqual({ text: 'done', sessionId: 'cold' });
    expect(onActivity).toHaveBeenCalledWith('reading');
    expect(tracker.get('op')?.activity).toEqual(['reading']);
    expect(JSON.stringify(tracker.get('op'))).not.toContain('SECRET PROMPT');
    expect(await runner.run({ featureId: 'f', prompt: 'hidden' })).toBe('done');
    expect(run).not.toHaveBeenCalled();
    runDetailed.mockRejectedValueOnce(new Error('failed'));
    await expect(runner.run({ featureId: 'f', prompt: '' })).rejects.toThrow('failed');
  });
});

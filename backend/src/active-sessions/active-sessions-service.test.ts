import { describe, expect, it, vi } from 'vitest';
import type { MetaPoolsStatus } from '../meta/pooled-meta-runner.js';
import type { MetaSessionInfo } from '../meta/acp/acp-pool.js';
import { createActiveSessionsService } from './active-sessions-service.js';
import type { ActiveSessionRecord } from './active-sessions-contract.js';
import { activeSessionsDefaults } from './config.js';
import { createMetaDebugTracker } from './meta-debug-tracker.js';
import type { MetaOperation } from '../meta/meta-operation-contract.js';

const session = (overrides: Partial<ActiveSessionRecord> = {}): ActiveSessionRecord => ({
  id: 'user', featureId: 'f', name: 'My terminal', provider: 'copilot', requestedModel: 'auto',
  status: 'running', kind: 'dev', scope: 'feature', seq: 2, ...overrides,
});
const warm = (overrides: Partial<MetaSessionInfo> = {}): MetaSessionInfo => ({
  id: 's1', state: 'idle', served: 0, startedAt: 0, lastActiveAt: null, inputTokens: 0, outputTokens: 0, history: [], ...overrides,
});
function fixture() {
  const tracker = createMetaDebugTracker(activeSessionsDefaults);
  let instances: MetaSessionInfo[] = [];
  const sessions = vi.fn<() => ActiveSessionRecord[]>(() => []);
  const pools = (): MetaPoolsStatus => ({ enabled: true, model: 'auto', pool: {
    size: instances.length, suggestedSize: 1, live: instances.length, idle: 0, busy: 0, ready: true, served: 0, sessions: instances,
  } });
  const config = { ...activeSessionsDefaults, maxOperations: 1, maxTextCharacters: 256 };
  const service = createActiveSessionsService({
    config, now: () => 100, sessions, pools, tracker,
    context: (id) => id === 'f' ? { featureName: 'Feature', projectName: 'Project' } : { featureName: null, projectName: null },
  });
  const observe = (overrides: Partial<MetaOperation> = {}) => tracker.observe({
    operationId: 'op', featureId: 'f', automationId: null, originSessionId: null,
    providerId: 'copilot', requestedModel: 'auto', resolvedModel: null, sessionId: 'cold',
    providerSessionId: null, sessionIds: ['cold'], transport: 'session', state: 'running',
    outcome: 'unknown', purpose: 'review', label: 'Review change', resultText: null,
    errorMessage: null, usageState: 'unknown', usage: null, createdAt: 't', updatedAt: 't', startedAt: 't', finishedAt: null,
    ...overrides,
  });
  return { service, sessions, tracker, observe, setWarm: (next: MetaSessionInfo[]) => { instances = next; } };
}

describe('active instance inventory and live debug', () => {
  it('includes every running user/cold/warm instance, never duplicates pooled leases or finished sessions', () => {
    const f = fixture();
    f.observe({ transport: 'warm-acp', sessionIds: ['pooled'], sessionId: 'pooled' });
    f.setWarm([warm({ state: 'busy', live: { operationId: 'op', purpose: 'review', label: 'Live review', prompt: 'PROMPT SECRET', response: 'response', startedAt: 1 } }),
      warm({ id: 's2' }), warm({ id: 's3', state: 'warming' })]);
    f.sessions.mockReturnValue([session(), session({ id: 'pooled', kind: 'meta' }), session({ id: 'cold', kind: 'meta', name: null }), session({ id: 'finished', status: 'completed' })]);
    const result = f.service.snapshot();
    expect(result.entries).toHaveLength(5);
    expect(result.entries.map((entry) => entry.id)).toEqual(['warm:s1', 'warm:s2', 'warm:s3', 'session:user', 'session:cold']);
    expect(result.entries[0]).toMatchObject({ label: 'Live review', state: 'busy', projectName: 'Project', operationId: 'op' });
    expect(result.entries[1]).toMatchObject({ state: 'idle', purpose: null });
    expect(JSON.stringify(result)).not.toContain('PROMPT SECRET');
    expect(JSON.stringify(result)).not.toContain('response');
    expect(f.service.debug('warm:s1')).toMatchObject({ state: 'running', output: 'response' });
  });

  it('returns bounded redacted live output, preserved completion and clear empty/removed states', () => {
    const f = fixture();
    f.observe({ transport: 'warm-acp' });
    f.tracker.activity('op', '🔧 running read · secret arguments');
    f.setWarm([warm({ state: 'busy', live: { operationId: 'op', purpose: 'review', prompt: 'PROMPT', response: `${'x'.repeat(300)} token=SECRET`, startedAt: 1 } })]);
    const active = f.service.debug('warm:s1');
    expect(active.output.length).toBe(256);
    expect(active.output).not.toContain('SECRET');
    expect(active.activity).toEqual(['🔧 running read']);
    expect(active.truncated).toBe(true);
    f.observe({ state: 'failed', resultText: 'last answer', errorMessage: 'provider failed' });
    f.setWarm([warm()]);
    expect(f.service.debug('warm:s1')).toMatchObject({ state: 'failed', output: 'last answer', error: 'provider failed', entry: { state: 'idle' } });
    f.setWarm([]);
    expect(f.service.debug('session:cold')).toMatchObject({ entry: null, state: 'failed', output: 'last answer' });
    expect(f.service.debug('missing')).toMatchObject({ entry: null, state: 'unavailable', activity: [], output: '' });
    expect(f.service.debug('session:missing')).toMatchObject({ state: 'unavailable' });
    expect(f.service.debug('warm:missing')).toMatchObject({ state: 'unavailable' });
  });

  it('uses honest fallbacks for unassociated/legacy sessions and caps remembered warm mappings', () => {
    const f = fixture();
    f.observe({ transport: 'warm-acp', sessionId: 'orphan', sessionIds: ['orphan'], label: null, purpose: null, providerId: null, requestedModel: null });
    f.sessions.mockReturnValue([
      session({ name: null }), session({ id: 'fallback', name: null, seq: null }),
      session({ id: 'internal', scope: 'internal', name: null, featureId: '' }), session({ id: 'orphan', kind: 'meta' }),
    ]);
    f.setWarm([warm({ live: { operationId: 'op', purpose: 'review', prompt: '', response: '', startedAt: 1 }, state: 'busy' }),
      warm({ id: 'new', live: { operationId: 'unknown', purpose: 'general', prompt: '', response: '', startedAt: 1 }, state: 'busy' })]);
    const snapshot = f.service.snapshot();
    expect(snapshot.entries.map((entry) => entry.label)).toContain('Session #2');
    expect(snapshot.entries.map((entry) => entry.label)).toContain('Session fallback');
    expect(snapshot.entries.find((entry) => entry.id === 'session:internal')).toMatchObject({ label: 'IDE metasession', kind: 'meta', featureName: null });
    expect(snapshot.entries.some((entry) => entry.id === 'session:orphan')).toBe(false);
    f.setWarm([warm()]);
    expect(f.service.debug('warm:s1').state).toBe('idle');
    expect(f.service.debug('warm:s1').output).toBe('');
  });

  it('works with disabled warm capacity, associated cold work and null project names', () => {
    const f = fixture();
    f.observe();
    f.sessions.mockReturnValue([session({ id: 'cold', kind: 'meta', featureId: 'unknown' })]);
    expect(f.service.snapshot().entries[0]).toMatchObject({ label: 'Review change', purpose: 'review', projectName: null });
    expect(f.service.debug('session:cold').state).toBe('running');
    const service = createActiveSessionsService({ config: activeSessionsDefaults, now: () => 0, pools: () => ({ enabled: false }),
      tracker: f.tracker, sessions: () => [], context: () => ({ projectName: null, featureName: null }) });
    expect(service.snapshot()).toEqual({ sampledAt: 0, pollMs: 3000, entries: [] });
    expect(service.debug('warm:none').state).toBe('unavailable');
  });

  it('never describes a quarantined process as idle available capacity', () => {
    const f = fixture();
    const service = createActiveSessionsService({ config: activeSessionsDefaults, now: () => 0,
      pools: () => ({ enabled: true, pool: { size: 0, suggestedSize: 0, live: 1, idle: 0, busy: 0, ready: false, served: 0, sessions: [warm({ retiring: true })] } }),
      tracker: f.tracker, sessions: () => [], context: () => ({ projectName: null, featureName: null }) });
    expect(service.snapshot().entries[0]).toMatchObject({ state: 'stopping', model: null });
  });
});

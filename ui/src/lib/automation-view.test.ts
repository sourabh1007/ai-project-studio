import { describe, it, expect } from 'vitest';
import {
  isActiveStatus,
  statusLabel,
  modeLabel,
  subagentStatusLabel,
  groupAutomations,
  sortSubagents,
  describeCheck,
  intervalLabel,
  nextRunLabel,
  runCountLabel,
  originLabel,
  canPause,
  canResume,
  canCancel,
  needsAuth,
} from './automation-view.js';
import type { Automation, Subagent } from './types.js';

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Watch CI',
    mode: 'long',
    status: 'active',
    origin: { sessionId: null, featureId: null },
    check: { type: 'shell', command: 'echo hi' },
    condition: { type: 'exit-code', equals: 0 },
    action: { type: 'report', prompt: 'go' },
    intervalMs: 60000,
    maxRuns: null,
    runCount: 0,
    progress: null,
    plannedSteps: [],
    lastOccurrenceKey: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    lastCheckedAt: null,
    nextRunAt: null,
    failure: null,
    ...overrides,
  };
}

function subagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    id: 'g1',
    automationId: 'a1',
    origin: { sessionId: null, featureId: null },
    task: 'Analyze',
    status: 'running',
    progress: null,
    result: null,
    sessionId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('isActiveStatus', () => {
  it('treats active and paused as active', () => {
    expect(isActiveStatus('active')).toBe(true);
    expect(isActiveStatus('paused')).toBe(true);
    expect(isActiveStatus('needs-auth')).toBe(true);
  });
  it('treats terminal states as not active', () => {
    expect(isActiveStatus('completed')).toBe(false);
    expect(isActiveStatus('failed')).toBe(false);
    expect(isActiveStatus('cancelled')).toBe(false);
  });
});

describe('statusLabel', () => {
  it('labels every status', () => {
    expect(statusLabel('active')).toBe('Active');
    expect(statusLabel('paused')).toBe('Paused');
    expect(statusLabel('needs-auth')).toBe('Sign-in required');
    expect(statusLabel('completed')).toBe('Completed');
    expect(statusLabel('failed')).toBe('Failed');
    expect(statusLabel('cancelled')).toBe('Cancelled');
  });
});

describe('modeLabel', () => {
  it('labels both modes', () => {
    expect(modeLabel('short')).toBe('One-time monitor');
    expect(modeLabel('long')).toBe('Continuous monitor');
  });
});

describe('subagentStatusLabel', () => {
  it('labels every subagent status', () => {
    expect(subagentStatusLabel('queued')).toBe('Queued');
    expect(subagentStatusLabel('running')).toBe('Running');
    expect(subagentStatusLabel('done')).toBe('Done');
    expect(subagentStatusLabel('failed')).toBe('Failed');
  });
});

describe('groupAutomations', () => {
  it('splits active from finished and sorts each newest-first', () => {
    const a = automation({ id: 'a', status: 'active', updatedAt: '2024-01-02T00:00:00.000Z' });
    const b = automation({ id: 'b', status: 'paused', updatedAt: '2024-01-03T00:00:00.000Z' });
    const c = automation({ id: 'c', status: 'completed', updatedAt: '2024-01-01T00:00:00.000Z' });
    const d = automation({ id: 'd', status: 'failed', updatedAt: '2024-01-04T00:00:00.000Z' });
    const groups = groupAutomations([a, b, c, d]);
    expect(groups.active.map((x) => x.id)).toEqual(['b', 'a']);
    expect(groups.finished.map((x) => x.id)).toEqual(['d', 'c']);
  });
  it('handles an empty list', () => {
    expect(groupAutomations([])).toEqual({ active: [], finished: [] });
  });
});

describe('sortSubagents', () => {
  it('sorts newest-updated first', () => {
    const g1 = subagent({ id: 'g1', updatedAt: '2024-01-01T00:00:00.000Z' });
    const g2 = subagent({ id: 'g2', updatedAt: '2024-01-05T00:00:00.000Z' });
    expect(sortSubagents([g1, g2]).map((x) => x.id)).toEqual(['g2', 'g1']);
  });
});

describe('describeCheck', () => {
  it('describes shell with and without command', () => {
    expect(describeCheck({ type: 'shell', command: 'ls' })).toBe('Shell check');
    expect(describeCheck({ type: 'shell', command: 'powershell -c x' })).toBe(
      'Shell check · PowerShell',
    );
    expect(describeCheck({ type: 'shell', command: '' })).toBe('Shell check');
    expect(describeCheck({ type: 'shell' })).toBe('Shell check');
  });
  it('describes http with and without url', () => {
    expect(describeCheck({ type: 'http', url: 'http://x' })).toBe('http://x');
    expect(describeCheck({ type: 'http' })).toBe('HTTP endpoint');
  });

  describe('intervalLabel', () => {
    it('formats seconds, minutes, and hours', () => {
      expect(intervalLabel(1000)).toBe('Every 1 second');
      expect(intervalLabel(30_000)).toBe('Every 30 seconds');
      expect(intervalLabel(60_000)).toBe('Every 1 minute');
      expect(intervalLabel(120_000)).toBe('Every 2 minutes');
      expect(intervalLabel(3_600_000)).toBe('Every 1 hour');
      expect(intervalLabel(7_200_000)).toBe('Every 2 hours');
    });
  });
  it('describes ai with and without prompt', () => {
    expect(describeCheck({ type: 'ai', prompt: 'done?' })).toBe('done?');
    expect(describeCheck({ type: 'ai' })).toBe('AI check');
  });
  it('describes ci-pipeline with and without repo', () => {
    expect(describeCheck({ type: 'ci-pipeline', repo: 'o/r' })).toBe('CI · o/r');
    expect(describeCheck({ type: 'ci-pipeline' })).toBe('CI pipeline');
  });
  it('falls back to the raw type for unknown checks', () => {
    expect(
      describeCheck({ type: 'mystery' } as unknown as Automation['check']),
    ).toBe('mystery');
  });
});

describe('nextRunLabel', () => {
  const now = Date.parse('2024-01-01T00:00:00.000Z');
  it('returns null with no next run', () => {
    expect(nextRunLabel(automation({ nextRunAt: null }), now)).toBeNull();
  });
  it('returns null for an unparseable timestamp', () => {
    expect(nextRunLabel(automation({ nextRunAt: 'not-a-date' }), now)).toBeNull();
  });
  it('says due now when the next run has passed', () => {
    expect(
      nextRunLabel(automation({ nextRunAt: '2023-12-31T23:59:59.000Z' }), now),
    ).toBe('due now');
  });
  it('formats seconds, minutes, and hours', () => {
    expect(
      nextRunLabel(automation({ nextRunAt: '2024-01-01T00:00:30.000Z' }), now),
    ).toBe('in 30s');
    expect(
      nextRunLabel(automation({ nextRunAt: '2024-01-01T00:05:00.000Z' }), now),
    ).toBe('in 5m');
    expect(
      nextRunLabel(automation({ nextRunAt: '2024-01-01T02:00:00.000Z' }), now),
    ).toBe('in 2h');
  });
});

describe('runCountLabel', () => {
  it('shows a capped count', () => {
    expect(runCountLabel(automation({ runCount: 2, maxRuns: 5 }))).toBe(
      '2/5 triggers',
    );
  });
  it('shows singular and plural uncapped counts', () => {
    expect(runCountLabel(automation({ runCount: 1, maxRuns: null }))).toBe(
      '1 trigger',
    );
    expect(runCountLabel(automation({ runCount: 3, maxRuns: null }))).toBe(
      '3 triggers',
    );
  });
});

describe('originLabel', () => {
  it('prefers feature, then session, then manual', () => {
    expect(originLabel({ featureId: 'f1', sessionId: 's1' })).toBe('Feature f1');
    expect(originLabel({ featureId: null, sessionId: 's1' })).toBe('Session s1');
    expect(originLabel({ featureId: null, sessionId: null })).toBe(
      'Studio monitor',
    );
  });
});

describe('lifecycle guards', () => {
  it('canPause only while active', () => {
    expect(canPause('active')).toBe(true);
    expect(canPause('paused')).toBe(false);
  });
  it('canResume while paused or awaiting sign-in', () => {
    expect(canResume('paused')).toBe(true);
    expect(canResume('needs-auth')).toBe(true);
    expect(canResume('active')).toBe(false);
  });
  it('canCancel while non-terminal', () => {
    expect(canCancel('active')).toBe(true);
    expect(canCancel('paused')).toBe(true);
    expect(canCancel('completed')).toBe(false);
  });
  it('needsAuth only for the needs-auth status', () => {
    expect(needsAuth('needs-auth')).toBe(true);
    expect(needsAuth('active')).toBe(false);
    expect(needsAuth('paused')).toBe(false);
  });
});

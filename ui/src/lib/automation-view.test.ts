import { describe, it, expect } from 'vitest';
import {
  isActiveStatus,
  monitorMotion,
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
  progressPercent,
  formatDuration,
  etaLabel,
  activeStepLabel,
  intervalOptions,
  snapIntervalMs,
  runStatusLabel,
  runSummary,
} from './automation-view.js';
import type { Automation, AutomationRun, Subagent } from './types.js';

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
  it('segregates running, paused, attention, and finished newest-first', () => {
    const a = automation({ id: 'a', status: 'active', updatedAt: '2024-01-02T00:00:00.000Z' });
    const a2 = automation({ id: 'a2', status: 'active', updatedAt: '2024-01-06T00:00:00.000Z' });
    const b = automation({ id: 'b', status: 'paused', updatedAt: '2024-01-03T00:00:00.000Z' });
    const n = automation({ id: 'n', status: 'needs-auth', updatedAt: '2024-01-05T00:00:00.000Z' });
    const c = automation({ id: 'c', status: 'completed', updatedAt: '2024-01-01T00:00:00.000Z' });
    const d = automation({ id: 'd', status: 'failed', updatedAt: '2024-01-04T00:00:00.000Z' });
    const groups = groupAutomations([a, a2, b, n, c, d]);
    expect(groups.running.map((x) => x.id)).toEqual(['a2', 'a']);
    expect(groups.paused.map((x) => x.id)).toEqual(['b']);
    expect(groups.attention.map((x) => x.id)).toEqual(['n']);
    expect(groups.finished.map((x) => x.id)).toEqual(['d', 'c']);
  });
  it('handles an empty list', () => {
    expect(groupAutomations([])).toEqual({
      running: [],
      paused: [],
      attention: [],
      finished: [],
    });
  });
});

describe('monitorMotion', () => {
  it('maps status to a motion state', () => {
    expect(monitorMotion('active')).toBe('running');
    expect(monitorMotion('paused')).toBe('paused');
    expect(monitorMotion('needs-auth')).toBe('paused');
    expect(monitorMotion('completed')).toBe('stopped');
    expect(monitorMotion('failed')).toBe('stopped');
    expect(monitorMotion('cancelled')).toBe('stopped');
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

describe('progressPercent', () => {
  it('returns null for uncapped or non-positive caps', () => {
    expect(progressPercent(automation({ maxRuns: null, runCount: 3 }))).toBeNull();
    expect(progressPercent(automation({ maxRuns: 0, runCount: 3 }))).toBeNull();
  });
  it('computes a clamped percentage for capped monitors', () => {
    expect(progressPercent(automation({ maxRuns: 10, runCount: 0 }))).toBe(0);
    expect(progressPercent(automation({ maxRuns: 10, runCount: 5 }))).toBe(50);
    expect(progressPercent(automation({ maxRuns: 10, runCount: 10 }))).toBe(100);
    expect(progressPercent(automation({ maxRuns: 10, runCount: 20 }))).toBe(100);
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(90_000)).toBe('2m');
    expect(formatDuration(600_000)).toBe('10m');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
  });
});

describe('etaLabel', () => {
  it('returns null when uncapped, not active, or at the cap', () => {
    expect(etaLabel(automation({ maxRuns: null }))).toBeNull();
    expect(
      etaLabel(automation({ maxRuns: 10, runCount: 2, status: 'paused' })),
    ).toBeNull();
    expect(
      etaLabel(automation({ maxRuns: 10, runCount: 10, status: 'active' })),
    ).toBeNull();
  });
  it('estimates the remaining time for an active capped monitor', () => {
    expect(
      etaLabel(
        automation({
          maxRuns: 288,
          runCount: 284,
          intervalMs: 300_000,
          status: 'active',
        }),
      ),
    ).toBe('~20m left');
  });
});

describe('activeStepLabel', () => {
  it('returns the active step label or null', () => {
    expect(activeStepLabel(automation({ plannedSteps: [] }))).toBeNull();
    expect(
      activeStepLabel(
        automation({
          plannedSteps: [
            { id: 's1', label: 'Wait', status: 'done', detail: null },
            { id: 's2', label: 'Deploy', status: 'active', detail: null },
          ],
        }),
      ),
    ).toBe('Deploy');
  });
});

describe('interval picker helpers', () => {
  it('exposes ascending preset options', () => {
    expect(intervalOptions[0].ms).toBe(30_000);
    expect(intervalOptions.at(-1)?.ms).toBe(3_600_000);
  });
  it('snaps arbitrary intervals to the nearest preset', () => {
    expect(snapIntervalMs(10_000)).toBe(30_000);
    expect(snapIntervalMs(61_000)).toBe(60_000);
    expect(snapIntervalMs(280_000)).toBe(300_000);
    expect(snapIntervalMs(9_999_999)).toBe(3_600_000);
  });
});

describe('run log helpers', () => {
  function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
    return {
      id: 'r1',
      automationId: 'a1',
      startedAt: '2024-01-01T00:00:00.000Z',
      endedAt: '2024-01-01T00:00:01.000Z',
      triggered: false,
      status: 'ok',
      detail: null,
      sessionId: null,
      ...overrides,
    };
  }
  it('labels each run status', () => {
    expect(runStatusLabel('ok')).toBe('Succeeded');
    expect(runStatusLabel('failed')).toBe('Failed');
    expect(runStatusLabel('skipped')).toBe('Skipped');
  });
  it('summarizes triggered and checked runs with and without detail', () => {
    expect(runSummary(run({ triggered: true, detail: 'went green' }))).toBe(
      'Triggered · went green',
    );
    expect(runSummary(run({ triggered: false, detail: null }))).toBe('Checked');
  });
});

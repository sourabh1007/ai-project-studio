import { describe, it, expect } from 'vitest';

import { createNewTaskRunHub, type NewTaskStreamEvent } from './new-task-run-hub.js';
import type {
  NewTaskRun,
  NewTaskService,
} from './new-task-contract.js';

const RUN: NewTaskRun = {
  id: 'a1',
  featureId: 'f1',
  problem: 'P',
  context: 'C',
  plan: 'PLAN',
  status: 'planned',
  branch: 'b',
  prNumber: null,
  prUrl: null,
  reviewFeatureId: null,
  error: null,
  agents: [],
  createdAt: 't',
  updatedAt: 't',
};

/** A stub service exposing only the two methods the hub drives. */
function stubService(
  overrides: Partial<Pick<NewTaskService, 'plan' | 'implement'>>,
): NewTaskService {
  return {
    get: () => null,
    reset: () => null,
    saveInputs: () => RUN,
    plan: async () => RUN,
    implement: async () => undefined,
    ...overrides,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('new-task run hub', () => {
  it('buffers a run so a later attach replays every event', async () => {
    const hub = createNewTaskRunHub({
      service: stubService({
        plan: async (_id, _signal, sink) => {
          sink?.activity({ phase: 'planning', line: 'thinking' });
          sink?.done(RUN);
          return RUN;
        },
      }),
    });
    hub.startPlan('a1', { baseBranch: 'main' });

    const seen: NewTaskStreamEvent[] = [];
    hub.attach('a1', (event) => seen.push(event));
    expect(seen).toEqual([
      { type: 'activity', phase: 'planning', line: 'thinking' },
      { type: 'done', run: RUN, files: undefined },
    ]);
  });

  it('forwards live events to an attached listener and stops after detach', async () => {
    let sink: Parameters<NonNullable<NewTaskService['plan']>>[2];
    const hub = createNewTaskRunHub({
      service: stubService({
        plan: async (_id, _signal, s) => {
          sink = s;
          return RUN;
        },
      }),
    });
    hub.startPlan('a1');
    const seen: NewTaskStreamEvent[] = [];
    const detach = hub.attach('a1', (event) => seen.push(event));

    sink?.activity({ phase: 'planning', line: 'one' });
    expect(seen).toHaveLength(1);
    detach();
    sink?.activity({ phase: 'planning', line: 'two' });
    expect(seen).toHaveLength(1);
  });

  it('does not start a second pass while one is already running', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const hub = createNewTaskRunHub({
      service: stubService({
        plan: async () => {
          calls += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return RUN;
        },
      }),
    });
    hub.startPlan('a1');
    hub.startPlan('a1');
    expect(calls).toBe(1);
    release();
    await tick();
  });

  it('starts a fresh pass once the previous one has settled', async () => {
    let calls = 0;
    const hub = createNewTaskRunHub({
      service: stubService({
        plan: async () => {
          calls += 1;
          return RUN;
        },
      }),
    });
    hub.startPlan('a1');
    await tick();
    hub.startPlan('a1');
    await tick();
    expect(calls).toBe(2);
  });

  it('attaching to an unknown run yields nothing and a no-op detach', () => {
    const hub = createNewTaskRunHub({ service: stubService({}) });
    const seen: NewTaskStreamEvent[] = [];
    const detach = hub.attach('missing', (event) => seen.push(event));
    expect(seen).toEqual([]);
    expect(() => detach()).not.toThrow();
  });

  it('reports whether a run is live', () => {
    const hub = createNewTaskRunHub({ service: stubService({}) });
    expect(hub.isLive('a1')).toBe(false);
    hub.startPlan('a1');
    expect(hub.isLive('a1')).toBe(true);
    hub.cancel('a1');
    expect(hub.isLive('a1')).toBe(false);
  });

  it('reports a thrown Error as a failed event', async () => {
    const hub = createNewTaskRunHub({
      service: stubService({
        plan: async () => {
          throw new Error('boom');
        },
      }),
    });
    hub.startPlan('a1');
    await tick();
    const seen: NewTaskStreamEvent[] = [];
    hub.attach('a1', (event) => seen.push(event));
    expect(seen).toEqual([{ type: 'failed', error: 'boom' }]);
  });

  it('reports a thrown non-Error as a stringified failed event', async () => {
    const hub = createNewTaskRunHub({
      service: stubService({
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        implement: async () => {
          throw 'nope';
        },
      }),
    });
    hub.startImplement('a1');
    await tick();
    const seen: NewTaskStreamEvent[] = [];
    hub.attach('a1', (event) => seen.push(event));
    expect(seen).toEqual([{ type: 'failed', error: 'nope' }]);
  });

  it('forwards a sink.failed call reported without throwing', async () => {
    const hub = createNewTaskRunHub({
      service: stubService({
        plan: async (_id, _signal, sink) => {
          sink?.failed('validation failed');
          return RUN;
        },
      }),
    });
    hub.startPlan('a1');
    await tick();
    const seen: NewTaskStreamEvent[] = [];
    hub.attach('a1', (event) => seen.push(event));
    expect(seen).toEqual([{ type: 'failed', error: 'validation failed' }]);
  });

  it('streams an implementation pass with its file summary', async () => {
    const hub = createNewTaskRunHub({
      service: stubService({
        implement: async (_id, sink) => {
          sink.activity({ phase: 'implementing', line: 'go' });
          sink.done(RUN, [{ path: 'a.ts', changeType: 'modified' }]);
        },
      }),
    });
    hub.startImplement('a1');
    const seen: NewTaskStreamEvent[] = [];
    hub.attach('a1', (event) => seen.push(event));
    expect(seen).toContainEqual({
      type: 'done',
      run: RUN,
      files: [{ path: 'a.ts', changeType: 'modified' }],
    });
  });

  it('buffers and replays an agent event', async () => {
    const agent = {
      id: 'manager',
      parentId: null,
      role: 'manager' as const,
      title: 'Lead agent',
      files: [],
      status: 'running' as const,
      startedAt: 1000,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      credits: null,
    };
    const hub = createNewTaskRunHub({
      service: stubService({
        implement: async (_id, sink) => {
          sink.agent?.(agent);
          sink.done(RUN);
        },
      }),
    });
    hub.startImplement('a1');
    const seen: NewTaskStreamEvent[] = [];
    hub.attach('a1', (event) => seen.push(event));
    expect(seen).toContainEqual({ type: 'agent', agent });
  });

  it('cancels a live run: aborts its signal and emits a terminal cancelled event', async () => {
    let seenAbort = false;
    const hub = createNewTaskRunHub({
      service: stubService({
        plan: async (_id, signal, sink) => {
          signal?.addEventListener('abort', () => {
            seenAbort = true;
          });
          // Never settles on its own; only cancellation ends it.
          await new Promise<void>(() => {});
          void sink;
          return RUN;
        },
      }),
    });
    hub.startPlan('a1');
    const seen: NewTaskStreamEvent[] = [];
    hub.attach('a1', (event) => seen.push(event));

    const cancelled = hub.cancel('a1');
    expect(cancelled).toBe(true);
    expect(seenAbort).toBe(true);
    expect(seen).toEqual([{ type: 'cancelled' }]);
  });

  it('cancel is a no-op for an unknown or already-settled run', async () => {
    const hub = createNewTaskRunHub({
      service: stubService({
        plan: async () => RUN,
      }),
    });
    expect(hub.cancel('missing')).toBe(false);
    hub.startPlan('a1');
    await tick();
    // The pass has settled; cancelling again does nothing.
    expect(hub.cancel('a1')).toBe(false);
  });

  it('lets a fresh pass start after a cancellation', () => {
    let calls = 0;
    const hub = createNewTaskRunHub({
      service: stubService({
        plan: async () => {
          calls += 1;
          await new Promise<void>(() => {});
          return RUN;
        },
      }),
    });
    hub.startPlan('a1');
    hub.cancel('a1');
    hub.startPlan('a1');
    expect(calls).toBe(2);
  });
});

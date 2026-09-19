import { describe, it, expect } from 'vitest';

import {
  createBugBashRunHub,
  type BugBashStreamEvent,
} from './bug-bash-run-hub.js';
import type { BugBashRun, BugBashService } from './bug-bash-contract.js';

const RUN: BugBashRun = {
  id: 'a1',
  featureId: 'f1',
  featureInfo: 'a feature',
  setupInfo: 'setup',
  otherInfo: '',
  prerequisites: [],
  scenarios: [],
  report: null,
  status: 'generated',
  error: null,
  agents: [],
  createdAt: 't',
  updatedAt: 't',
};

/** A stub service exposing only the two methods the hub drives. */
function stubService(
  overrides: Partial<Pick<BugBashService, 'generate' | 'run'>>,
): BugBashService {
  return {
    get: () => null,
    reset: () => null,
    saveInputs: () => RUN,
    generatePrerequisites: async () => RUN,
    savePrerequisiteAnswers: () => RUN,
    generate: async () => RUN,
    run: async () => undefined,
    ...overrides,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('bug-bash run hub', () => {
  it('buffers a pass so a later attach replays every event', async () => {
    const hub = createBugBashRunHub({
      service: stubService({
        generate: async (_id, _signal, sink) => {
          sink?.activity({ phase: 'generating', line: 'thinking' });
          sink?.done(RUN);
          return RUN;
        },
      }),
    });
    hub.startGenerate('a1');

    const seen: BugBashStreamEvent[] = [];
    hub.attach('a1', (event) => seen.push(event));
    expect(seen).toEqual([
      { type: 'activity', phase: 'generating', line: 'thinking' },
      { type: 'done', run: RUN },
    ]);
  });

  it('forwards live events to an attached listener and stops after detach', async () => {
    let sink: Parameters<NonNullable<BugBashService['generate']>>[2];
    const hub = createBugBashRunHub({
      service: stubService({
        generate: async (_id, _signal, s) => {
          sink = s;
          return RUN;
        },
      }),
    });
    hub.startGenerate('a1');
    const seen: BugBashStreamEvent[] = [];
    const detach = hub.attach('a1', (event) => seen.push(event));

    sink?.activity({ phase: 'generating', line: 'one' });
    expect(seen).toHaveLength(1);
    detach();
    sink?.activity({ phase: 'generating', line: 'two' });
    expect(seen).toHaveLength(1);
  });

  it('does not start a second pass while one is already running', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const hub = createBugBashRunHub({
      service: stubService({
        generate: async () => {
          calls += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return RUN;
        },
      }),
    });
    hub.startGenerate('a1');
    hub.startGenerate('a1');
    expect(calls).toBe(1);
    release();
    await tick();
  });

  it('starts a fresh pass once the previous one has settled', async () => {
    let calls = 0;
    const hub = createBugBashRunHub({
      service: stubService({
        generate: async () => {
          calls += 1;
          return RUN;
        },
      }),
    });
    hub.startGenerate('a1');
    await tick();
    hub.startGenerate('a1');
    await tick();
    expect(calls).toBe(2);
  });

  it('attaching to an unknown pass yields nothing and a no-op detach', () => {
    const hub = createBugBashRunHub({ service: stubService({}) });
    const seen: BugBashStreamEvent[] = [];
    const detach = hub.attach('missing', (event) => seen.push(event));
    expect(seen).toEqual([]);
    expect(() => detach()).not.toThrow();
  });

  it('reports whether a pass is live', () => {
    const hub = createBugBashRunHub({ service: stubService({}) });
    expect(hub.isLive('a1')).toBe(false);
    hub.startGenerate('a1');
    expect(hub.isLive('a1')).toBe(true);
    hub.cancel('a1');
    expect(hub.isLive('a1')).toBe(false);
  });

  it('reports a thrown Error as a failed event', async () => {
    const hub = createBugBashRunHub({
      service: stubService({
        generate: async () => {
          throw new Error('boom');
        },
      }),
    });
    hub.startGenerate('a1');
    await tick();
    const seen: BugBashStreamEvent[] = [];
    hub.attach('a1', (event) => seen.push(event));
    expect(seen).toEqual([{ type: 'failed', error: 'boom' }]);
  });

  it('reports a thrown non-Error as a stringified failed event', async () => {
    const hub = createBugBashRunHub({
      service: stubService({
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        run: async () => {
          throw 'nope';
        },
      }),
    });
    hub.startRun('a1');
    await tick();
    const seen: BugBashStreamEvent[] = [];
    hub.attach('a1', (event) => seen.push(event));
    expect(seen).toEqual([{ type: 'failed', error: 'nope' }]);
  });

  it('forwards a sink.failed call reported without throwing', async () => {
    const hub = createBugBashRunHub({
      service: stubService({
        generate: async (_id, _signal, sink) => {
          sink?.failed('validation failed');
          return RUN;
        },
      }),
    });
    hub.startGenerate('a1');
    await tick();
    const seen: BugBashStreamEvent[] = [];
    hub.attach('a1', (event) => seen.push(event));
    expect(seen).toEqual([{ type: 'failed', error: 'validation failed' }]);
  });

  it('streams a run pass with agent and scenario events', async () => {
    const agent = {
      id: 'lead',
      parentId: null,
      role: 'lead' as const,
      title: 'Lead agent',
      scenarioIds: [],
      status: 'running' as const,
      startedAt: 1000,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      credits: null,
    };
    const hub = createBugBashRunHub({
      service: stubService({
        run: async (_id, sink) => {
          sink.agent?.(agent);
          sink.scenario?.({ id: 'scenario-1', status: 'running' });
          sink.scenario?.({ id: 'scenario-1', status: 'pass' });
          sink.done(RUN);
        },
      }),
    });
    hub.startRun('a1');
    const seen: BugBashStreamEvent[] = [];
    hub.attach('a1', (event) => seen.push(event));
    expect(seen).toContainEqual({ type: 'agent', agent });
    expect(seen).toContainEqual({
      type: 'scenario',
      progress: { id: 'scenario-1', status: 'running' },
    });
    expect(seen).toContainEqual({
      type: 'scenario',
      progress: { id: 'scenario-1', status: 'pass' },
    });
    expect(seen).toContainEqual({ type: 'done', run: RUN });
  });

  it('cancels a live pass: aborts its signal and emits a terminal cancelled event', async () => {
    let seenAbort = false;
    const hub = createBugBashRunHub({
      service: stubService({
        generate: async (_id, signal) => {
          signal?.addEventListener('abort', () => {
            seenAbort = true;
          });
          await new Promise<void>(() => {});
          return RUN;
        },
      }),
    });
    hub.startGenerate('a1');
    const seen: BugBashStreamEvent[] = [];
    hub.attach('a1', (event) => seen.push(event));

    const cancelled = hub.cancel('a1');
    expect(cancelled).toBe(true);
    expect(seenAbort).toBe(true);
    expect(seen).toEqual([{ type: 'cancelled' }]);
  });

  it('cancel is a no-op for an unknown or already-settled pass', async () => {
    const hub = createBugBashRunHub({
      service: stubService({ generate: async () => RUN }),
    });
    expect(hub.cancel('missing')).toBe(false);
    hub.startGenerate('a1');
    await tick();
    expect(hub.cancel('a1')).toBe(false);
  });

  it('lets a fresh pass start after a cancellation', () => {
    let calls = 0;
    const hub = createBugBashRunHub({
      service: stubService({
        generate: async () => {
          calls += 1;
          await new Promise<void>(() => {});
          return RUN;
        },
      }),
    });
    hub.startGenerate('a1');
    hub.cancel('a1');
    hub.startGenerate('a1');
    expect(calls).toBe(2);
  });
});

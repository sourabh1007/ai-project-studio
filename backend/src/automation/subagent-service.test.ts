import { describe, it, expect, beforeEach } from 'vitest';
import { createEventBus } from '../kernel/event-bus.js';
import { createClock } from '../kernel/clock.js';
import {
  createSubagentService,
  type SubagentEventMap,
  type SubagentService,
} from './subagent-service.js';
import type { Subagent, SubagentRepo } from './automation-contract.js';
import type { AiInvoker } from './automation-ports.js';

function fakeRepo(): SubagentRepo {
  const store = new Map<string, Subagent>();
  return {
    create(s) {
      store.set(s.id, s);
    },
    get(id) {
      return store.get(id) ?? null;
    },
    list() {
      return [...store.values()];
    },
    save(s) {
      store.set(s.id, s);
    },
    listByAutomation(id) {
      return [...store.values()].filter((s) => s.automationId === id);
    },
    deleteByAutomation(automationId) {
      for (const [id, subagent] of store.entries()) {
        if (subagent.automationId === automationId) {
          store.delete(id);
        }
      }
    },
    deleteByOriginFeature(featureId) {
      for (const [id, subagent] of store.entries()) {
        if (subagent.origin.featureId === featureId) {
          store.delete(id);
        }
      }
    },
    deleteByOriginSession(sessionId) {
      for (const [id, subagent] of store.entries()) {
        if (subagent.origin.sessionId === sessionId) {
          store.delete(id);
        }
      }
    },
  };
}

function counterIds() {
  let n = 0;
  return { next: () => `g${++n}` };
}

describe('subagent-service', () => {
  let repo: SubagentRepo;
  let bus: ReturnType<typeof createEventBus<SubagentEventMap>>;
  let events: Subagent[];
  let time: number;

  beforeEach(() => {
    repo = fakeRepo();
    bus = createEventBus<SubagentEventMap>();
    events = [];
    time = Date.UTC(2026, 0, 1);
    bus.on('subagent.updated', (s) => events.push(s));
  });

  function make(ai: AiInvoker): SubagentService {
    return createSubagentService({
      repo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus,
      ai,
      timeoutMs: 9_999,
    });
  }

  it('spawns a subagent, runs the AI task, and marks it done', async () => {
    let seenFeature = '';
    const controller = new AbortController();
    const service = make({
      run: async (input) => {
        seenFeature = input.featureId;
        expect(input.automationId).toBe('a1');
        expect(input.timeoutMs).toBe(9_999);
        expect(input.scope).toBe('internal');
        expect(input.signal).toBe(controller.signal);
        return { text: '  result text  ', sessionId: 'm1' };
      },
    });

    const { subagent, completion } = service.spawn({
      task: 'Analyze',
      prompt: 'go',
      origin: { sessionId: 's1', featureId: 'f1' },
      automationId: 'a1',
      signal: controller.signal,
    });
    expect(subagent.status).toBe('running');
    await completion;

    const done = service.get(subagent.id);
    expect(done.status).toBe('done');
    expect(done.result).toBe('result text');
    expect(done.sessionId).toBe('m1');
    expect(seenFeature).toBe('f1');
  });

  it('attributes to a stable automation key when there is no origin feature', async () => {
    let seenFeature = '';
    const service = make({
      run: async (input) => {
        seenFeature = input.featureId;
        return { text: 'ok', sessionId: 'm2' };
      },
    });
    const { completion } = service.spawn({
      task: 'x',
      prompt: 'y',
      origin: { sessionId: null, featureId: null },
      automationId: 'a5',
    });
    await completion;
    expect(seenFeature).toBe('automation:a5');
  });

  it('falls back to the subagent id when there is no automation id', async () => {
    let seenFeature = '';
    const service = make({
      run: async (input) => {
        seenFeature = input.featureId;
        return { text: 'ok', sessionId: 'm3' };
      },
    });
    const { subagent, completion } = service.spawn({
      task: 'x',
      prompt: 'y',
      origin: { sessionId: null, featureId: null },
      automationId: null,
    });
    await completion;
    expect(seenFeature).toBe(`automation:${subagent.id}`);
  });

  it('marks a subagent failed when the AI run rejects', async () => {
    const service = make({
      run: async () => {
        throw new Error('kaboom');
      },
    });
    const { subagent, completion } = service.spawn({
      task: 'x',
      prompt: 'y',
      origin: { sessionId: null, featureId: null },
      automationId: 'a1',
    });
    await completion;
    const failed = service.get(subagent.id);
    expect(failed.status).toBe('failed');
    expect(failed.result).toBe('kaboom');
  });

  it('uses a generic message for a non-Error rejection', async () => {
    const service = make({
      run: async () => {
        throw 'weird';
      },
    });
    const { subagent, completion } = service.spawn({
      task: 'x',
      prompt: 'y',
      origin: { sessionId: null, featureId: null },
      automationId: 'a1',
    });
    await completion;
    expect(service.get(subagent.id).result).toBe('Subagent failed');
  });

  it('persists failure and retains the full result when the done update fails', async () => {
    const save = repo.save;
    const failure = new Error('done update rejected');
    repo.save = (subagent) => {
      if (subagent.status === 'done') throw failure;
      save(subagent);
    };
    const text = 'full result '.repeat(200);
    const service = make({ run: async () => ({ text, sessionId: 'm1' }) });
    const { subagent, completion } = service.spawn({
      task: 'x', prompt: 'y',
      origin: { featureId: 'f1', sessionId: 's1' }, automationId: 'a1',
    });
    await expect(completion).rejects.toBe(failure);
    expect(service.get(subagent.id)).toMatchObject({
      status: 'failed', sessionId: 'm1', result: `${failure.message}\n\n${text}`,
    });
    expect(events.map((event) => event.status)).toEqual(['running', 'failed']);
  });

  it('retains both errors when persisting a failed run also fails', async () => {
    const failure = new Error('AI failed');
    const persistenceError = new Error('storage unavailable');
    repo.save = () => { throw persistenceError; };
    const service = make({ run: async () => { throw failure; } });
    const { completion } = service.spawn({
      task: 'x', prompt: 'y',
      origin: { featureId: 'f1', sessionId: 's1' }, automationId: 'a1',
    });
    await expect(completion).rejects.toMatchObject({
      errors: [failure, persistenceError],
    });
  });

  it('retains the completion-save error when the compensating update also fails', async () => {
    const completionError = new Error('done rejected');
    const failureError = new Error('failed rejected');
    repo.save = (subagent) => {
      throw subagent.status === 'done' ? completionError : failureError;
    };
    const service = make({ run: async () => ({ text: 'result', sessionId: 'm1' }) });
    const { completion } = service.spawn({
      task: 'x', prompt: 'y',
      origin: { featureId: 'f1', sessionId: 's1' }, automationId: 'a1',
    });
    await expect(completion).rejects.toMatchObject({
      errors: [completionError, failureError],
    });
  });

  it('registers, reads, lists, and updates a subagent', async () => {
    const service = make({ run: async () => ({ text: '', sessionId: 'm' }) });

    const reg = service.register({
      task: 'External',
      origin: { sessionId: 's1', featureId: 'f1' },
      automationId: 'a1',
    });
    expect(reg.status).toBe('queued');
    expect(service.get(reg.id)).toEqual(reg);
    expect(service.list()).toHaveLength(1);
    expect(service.listByAutomation('a1').map((s) => s.id)).toEqual([reg.id]);

    expect(service.updateProgress(reg.id, 'halfway').progress).toBe('halfway');
    expect(service.updateProgress(reg.id, 'halfway').status).toBe('running');
    expect(service.complete(reg.id, 'final').status).toBe('done');
    expect(service.fail(reg.id, 'bad').status).toBe('failed');
  });

  it('throws when reading a missing subagent', () => {
    const service = make({ run: async () => ({ text: '', sessionId: 'm' }) });
    expect(() => service.get('nope')).toThrow(/not found/);
  });

  it('suppresses late completion updates after the subagent record is deleted', async () => {
    let resolveRun!: (value: { text: string; sessionId: string }) => void;
    const service = make({
      run: () =>
        new Promise<{ text: string; sessionId: string }>((resolve) => {
          resolveRun = resolve;
        }),
    });
    const { subagent, completion } = service.spawn({
      task: 'x',
      prompt: 'y',
      origin: { sessionId: 's1', featureId: 'f1' },
      automationId: 'a1',
    });

    repo.deleteByAutomation('a1');
    resolveRun({ text: 'done', sessionId: 'm4' });
    await completion;

    expect(service.list()).toEqual([]);
    expect(events).toEqual([subagent]);
  });

  it('suppresses late failure updates after the subagent record is deleted', async () => {
    let rejectRun!: (reason?: unknown) => void;
    const service = make({
      run: () =>
        new Promise((_, reject) => {
          rejectRun = reject;
        }),
    });
    const { subagent, completion } = service.spawn({
      task: 'x',
      prompt: 'y',
      origin: { sessionId: 's1', featureId: 'f1' },
      automationId: 'a1',
    });

    repo.deleteByAutomation('a1');
    rejectRun(new Error('boom'));
    await completion;

    expect(service.list()).toEqual([]);
    expect(events).toEqual([subagent]);
  });
});

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
    });
  }

  it('spawns a subagent, runs the AI task, and marks it done', async () => {
    let seenFeature = '';
    const service = make({
      run: async (input) => {
        seenFeature = input.featureId;
        return { text: '  result text  ', sessionId: 'm1' };
      },
    });

    const { subagent, completion } = service.spawn({
      task: 'Analyze',
      prompt: 'go',
      origin: { sessionId: 's1', featureId: 'f1' },
      automationId: 'a1',
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
});

import { describe, it, expect } from 'vitest';
import { MetaSessionPool, type PooledClient } from './acp-pool.js';
import type { AcpTurnRequest, AcpTurnResult } from './acp-client.js';

interface FakeOptions {
  initFails?: boolean;
  run?: (request: AcpTurnRequest) => Promise<AcpTurnResult>;
}

class FakeClient implements PooledClient {
  alive = true;
  killed = 0;
  readonly turns: AcpTurnRequest[] = [];
  private readonly exitHandlers: (() => void)[] = [];

  constructor(private readonly options: FakeOptions = {}) {}

  initialize(): Promise<void> {
    return this.options.initFails
      ? Promise.reject(new Error('boot failed'))
      : Promise.resolve();
  }

  runTurn(request: AcpTurnRequest): Promise<AcpTurnResult> {
    this.turns.push(request);
    if (this.options.run) {
      return this.options.run(request);
    }
    return Promise.resolve({
      text: 'ok',
      sessionId: 's',
      stopReason: 'end_turn',
      usage: null,
    });
  }

  onExit(handler: () => void): void {
    this.exitHandlers.push(handler);
  }

  kill(): void {
    this.killed += 1;
  }

  exit(): void {
    this.alive = false;
    for (const handler of this.exitHandlers) {
      handler();
    }
  }
}

const flush = () => new Promise((r) => setImmediate(r));

function harness(options: FakeOptions = {}) {
  const created: FakeClient[] = [];
  const pool = new MetaSessionPool({
    size: 1,
    createClient: () => {
      const client = new FakeClient(options);
      created.push(client);
      return client;
    },
  });
  return { pool, created };
}

describe('MetaSessionPool', () => {
  it('warms to the configured size on start', async () => {
    const created: FakeClient[] = [];
    const pool = new MetaSessionPool({
      size: 3,
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c;
      },
    });
    await pool.start();
    expect(created).toHaveLength(3);
    expect(pool.idleCount).toBe(3);
  });

  it('leases an idle session and returns it on release', async () => {
    const { pool, created } = harness();
    await pool.start();
    const client = await pool.acquire();
    expect(client).toBe(created[0]);
    expect(pool.idleCount).toBe(0);
    pool.release(client);
    expect(pool.idleCount).toBe(1);
  });

  it('queues acquire when all sessions are busy and resolves on release', async () => {
    const { pool, created } = harness();
    await pool.start();
    const first = await pool.acquire();
    let served: PooledClient | null = null;
    const pending = pool.acquire().then((c) => {
      served = c;
    });
    await flush();
    expect(served).toBeNull();
    pool.release(first);
    await pending;
    expect(served).toBe(created[0]);
  });

  it('run leases, runs a turn, and releases', async () => {
    const { pool, created } = harness();
    await pool.start();
    const result = await pool.run({ prompt: 'hello' });
    expect(result.text).toBe('ok');
    expect(created[0].turns).toHaveLength(1);
    expect(created[0].turns[0]).toMatchObject({ prompt: 'hello' });
    expect(pool.idleCount).toBe(1);
  });

  it('releases the session even when the turn throws', async () => {
    const { pool } = harness({ run: () => Promise.reject(new Error('turn boom')) });
    await pool.start();
    await expect(pool.run({ prompt: 'x' })).rejects.toThrow('turn boom');
    expect(pool.idleCount).toBe(1);
  });

  it('replenishes when an idle session exits', async () => {
    const { pool, created } = harness();
    await pool.start();
    expect(created).toHaveLength(1);
    created[0].exit();
    await flush();
    expect(created).toHaveLength(2);
    expect(pool.idleCount).toBe(1);
  });

  it('serves a waiter with a replenished session after a leased one exits', async () => {
    const { pool, created } = harness();
    await pool.start();
    const leased = await pool.acquire();
    let served: PooledClient | null = null;
    const pending = pool.acquire().then((c) => {
      served = c;
    });
    await flush();
    expect(served).toBeNull();
    (leased as FakeClient).exit();
    await flush();
    await pending;
    expect(served).toBe(created[1]);
  });

  it('does not re-add a dead session on release', async () => {
    const { pool } = harness();
    await pool.start();
    const client = await pool.acquire();
    (client as FakeClient).alive = false;
    pool.release(client);
    expect(pool.idleCount).toBe(0);
  });

  it('rejects acquire and pending waiters when closed', async () => {
    const { pool, created } = harness();
    await pool.start();
    const busy = await pool.acquire();
    const waiter = pool.acquire();
    pool.close();
    expect(created[0].killed).toBe(0); // busy one is leased, not idle
    await expect(waiter).rejects.toThrow('MetaSessionPool is closed');
    await expect(pool.acquire()).rejects.toThrow('MetaSessionPool is closed');
    pool.release(busy);
    expect(pool.idleCount).toBe(0);
  });

  it('kills idle sessions on close', async () => {
    const { pool, created } = harness();
    await pool.start();
    pool.close();
    expect(created[0].killed).toBe(1);
  });

  it('surfaces initialization failures from start', async () => {
    const { pool } = harness({ initFails: true });
    await expect(pool.start()).rejects.toThrow('boot failed');
  });

  it('spawns nothing when start runs after close', async () => {
    const { pool, created } = harness();
    pool.close();
    await pool.start();
    expect(created).toHaveLength(0);
    expect(pool.idleCount).toBe(0);
  });

  it('reports readiness and warm-capacity stats', async () => {
    const pool = new MetaSessionPool({
      size: 2,
      now: () => 5000,
      createClient: () => new FakeClient(),
    });
    expect(pool.ready).toBe(false);
    expect(pool.stats()).toEqual({
      size: 2,
      live: 0,
      idle: 0,
      busy: 0,
      ready: false,
      served: 0,
      sessions: [],
    });
    await pool.start();
    expect(pool.ready).toBe(true);
    const leased = await pool.acquire();
    const stats = pool.stats();
    expect(stats).toMatchObject({
      size: 2,
      live: 2,
      idle: 1,
      busy: 1,
      ready: true,
      served: 0,
    });
    expect(stats.sessions).toEqual([
      {
        id: 's1',
        state: 'busy',
        served: 0,
        startedAt: 5000,
        lastActiveAt: 5000,
        inputTokens: 0,
        outputTokens: 0,
        history: [],
      },
      {
        id: 's2',
        state: 'idle',
        served: 0,
        startedAt: 5000,
        lastActiveAt: null,
        inputTokens: 0,
        outputTokens: 0,
        history: [],
      },
    ]);
    pool.release(leased);
    expect(pool.stats().sessions[0].state).toBe('idle');
    pool.close();
    expect(pool.ready).toBe(false);
  });

  it('exposes per-session served counts and warming state', async () => {
    let now = 100;
    const pool = new MetaSessionPool({
      size: 1,
      now: () => now,
      createClient: () => new FakeClient(),
    });
    await pool.start();
    now = 200;
    await pool.run({ prompt: 'one' });
    const [session] = pool.stats().sessions;
    expect(session).toEqual({
      id: 's1',
      state: 'idle',
      served: 1,
      startedAt: 100,
      lastActiveAt: 200,
      inputTokens: 0,
      outputTokens: 0,
      history: [
        {
          at: 200,
          purpose: 'general',
          prompt: 'one',
          inputTokens: 0,
          outputTokens: 0,
        },
      ],
    });
    pool.close();
  });

  it('shows a session as warming until it finishes booting', async () => {
    let resolveInit: () => void = () => undefined;
    const client = new FakeClient();
    client.initialize = () =>
      new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
    const pool = new MetaSessionPool({
      size: 1,
      now: () => 1,
      createClient: () => client,
    });
    const starting = pool.start();
    await flush();
    expect(pool.stats().sessions).toEqual([
      {
        id: 's1',
        state: 'warming',
        served: 0,
        startedAt: 1,
        lastActiveAt: null,
        inputTokens: 0,
        outputTokens: 0,
        history: [],
      },
    ]);
    resolveInit();
    await starting;
    expect(pool.stats().sessions[0].state).toBe('idle');
    pool.close();
  });

  it('drops a session that exits mid-turn without double-counting it', async () => {
    const first = new FakeClient({
      run: async () => {
        first.exit();
        return { text: 'ok', sessionId: 's', stopReason: 'end_turn', usage: null };
      },
    });
    const queue: FakeClient[] = [first, new FakeClient()];
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => queue.shift() ?? new FakeClient(),
    });
    await pool.start();
    const result = await pool.run({ prompt: 'x' });
    expect(result.text).toBe('ok');
    // Aggregate still counts the served turn, but the exited session is gone.
    expect(pool.stats().served).toBe(1);
    expect(pool.stats().sessions.every((s) => s.id !== 's1')).toBe(true);
    pool.close();
  });

  it('counts each successfully served warm turn', async () => {
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => new FakeClient(),
    });
    await pool.start();
    expect(pool.stats().served).toBe(0);
    await pool.run({ prompt: 'one' });
    await pool.run({ prompt: 'two' });
    expect(pool.stats().served).toBe(2);
    pool.close();
  });

  it('records per-turn token usage and a capped usage history', async () => {
    let now = 1000;
    let tokens = 10;
    const pool = new MetaSessionPool({
      size: 1,
      now: () => now,
      createClient: () =>
        new FakeClient({
          run: () =>
            Promise.resolve({
              text: 'ok',
              sessionId: 's',
              stopReason: 'end_turn',
              usage: { inputTokens: tokens, outputTokens: tokens * 2 },
            }),
        }),
    });
    await pool.start();
    now = 1100;
    tokens = 10;
    await pool.run(
      { prompt: 'a' },
      { purpose: 'pr-review', label: 'PR review · problem statement' },
    );
    now = 1200;
    tokens = 5;
    await pool.run({ prompt: 'b' });
    const [session] = pool.stats().sessions;
    expect(session.inputTokens).toBe(15);
    expect(session.outputTokens).toBe(30);
    expect(session.history).toEqual([
      {
        at: 1100,
        purpose: 'pr-review',
        label: 'PR review · problem statement',
        prompt: 'a',
        inputTokens: 10,
        outputTokens: 20,
      },
      {
        at: 1200,
        purpose: 'general',
        prompt: 'b',
        inputTokens: 5,
        outputTokens: 10,
      },
    ]);
    pool.close();
  });

  it('caps the history to the most recent turns', async () => {
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => new FakeClient(),
    });
    await pool.start();
    for (let i = 0; i < 30; i += 1) {
      await pool.run({ prompt: `turn-${i}` });
    }
    const [session] = pool.stats().sessions;
    expect(session.served).toBe(30);
    expect(session.history).toHaveLength(25);
    pool.close();
  });

  it('returns a defensive copy of a session history', async () => {
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => new FakeClient(),
    });
    await pool.start();
    await pool.run({ prompt: 'a' });
    const history = pool.stats().sessions[0].history;
    history.push({ at: 0, purpose: 'x', inputTokens: 9, outputTokens: 9 });
    expect(pool.stats().sessions[0].history).toHaveLength(1);
    pool.close();
  });

  it('exposes the in-flight conversation and clears it when the turn ends', async () => {
    let release: (result: AcpTurnResult) => void = () => undefined;
    const forwarded: string[] = [];
    const pool = new MetaSessionPool({
      size: 1,
      now: () => 42,
      createClient: () =>
        new FakeClient({
          run: (request) => {
            request.onActivity?.('Hello');
            request.onActivity?.(' world');
            return new Promise<AcpTurnResult>((resolve) => {
              release = resolve;
            });
          },
        }),
    });
    await pool.start();
    const turn = pool.run(
      { prompt: 'diagnose', onActivity: (text) => forwarded.push(text) },
      { purpose: 'self-recovery', label: 'Self-recovery diagnosis' },
    );
    await flush();
    const [busy] = pool.stats().sessions;
    expect(busy.state).toBe('busy');
    expect(busy.live).toEqual({
      purpose: 'self-recovery',
      label: 'Self-recovery diagnosis',
      prompt: 'diagnose',
      response: 'Hello world',
      startedAt: 42,
    });
    // The pool observes the raw chunks but still forwards them to the caller.
    expect(forwarded).toEqual(['Hello', ' world']);
    release({
      text: 'Hello world',
      sessionId: 's',
      stopReason: 'end_turn',
      usage: null,
    });
    await turn;
    const [idle] = pool.stats().sessions;
    expect(idle.live).toBeUndefined();
    expect(idle.history).toEqual([
      {
        at: 42,
        purpose: 'self-recovery',
        label: 'Self-recovery diagnosis',
        prompt: 'diagnose',
        response: 'Hello world',
        inputTokens: 0,
        outputTokens: 0,
      },
    ]);
    pool.close();
  });

  it('truncates long prompt and response previews in history', async () => {
    const bigPrompt = 'p'.repeat(2500);
    const bigChunk = 'r'.repeat(13000);
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () =>
        new FakeClient({
          run: (request) => {
            request.onActivity?.(bigChunk);
            return Promise.resolve({
              text: bigChunk,
              sessionId: 's',
              stopReason: 'end_turn',
              usage: null,
            });
          },
        }),
    });
    await pool.start();
    await pool.run({ prompt: bigPrompt });
    const [turn] = pool.stats().sessions[0].history;
    expect(turn.prompt).toBe(`${'p'.repeat(2000)}…`);
    expect(turn.response).toBe(`${'r'.repeat(12000)}…`);
    pool.close();
  });

  it('omits prompt and response previews when the turn carried neither', async () => {
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => new FakeClient(),
    });
    await pool.start();
    await pool.run({ prompt: '' });
    const [turn] = pool.stats().sessions[0].history;
    expect(turn.prompt).toBeUndefined();
    expect(turn.response).toBeUndefined();
    pool.close();
  });

  it('grows the pool live when resized up', async () => {
    const created: FakeClient[] = [];
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c;
      },
    });
    await pool.start();
    expect(pool.stats().size).toBe(1);
    pool.resize(3);
    await flush();
    const stats = pool.stats();
    expect(stats.size).toBe(3);
    expect(stats.live).toBe(3);
    expect(stats.idle).toBe(3);
    expect(created).toHaveLength(3);
    pool.close();
  });

  it('shrinks the pool live by retiring idle surplus highest-first', async () => {
    const created: FakeClient[] = [];
    const pool = new MetaSessionPool({
      size: 3,
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c;
      },
    });
    await pool.start();
    pool.resize(1);
    const stats = pool.stats();
    expect(stats.size).toBe(1);
    expect(stats.live).toBe(1);
    expect(stats.sessions.map((s) => s.id)).toEqual(['s1']);
    // The two highest-numbered idle sessions were killed.
    expect(created[1].killed).toBe(1);
    expect(created[2].killed).toBe(1);
    expect(created[0].killed).toBe(0);
    pool.close();
  });

  it('retires a busy surplus session only when it checks back in', async () => {
    const created: FakeClient[] = [];
    const resolvers: Array<() => void> = [];
    const pool = new MetaSessionPool({
      size: 2,
      createClient: () => {
        const c = new FakeClient({
          run: () =>
            new Promise((resolve) => {
              resolvers.push(() =>
                resolve({
                  text: 'ok',
                  sessionId: 's',
                  stopReason: 'end_turn',
                  usage: null,
                }),
              );
            }),
        });
        created.push(c);
        return c;
      },
    });
    await pool.start();
    // Lease both sessions so they are busy, then shrink to 1: no idle session
    // exists to retire, so live stays 2 until a busy one checks back in.
    const first = pool.run({ prompt: 'a' });
    const second = pool.run({ prompt: 'b' });
    await flush();
    pool.resize(1);
    expect(pool.stats().live).toBe(2);
    expect(created[0].killed).toBe(0);
    resolvers[0]();
    await first;
    // s1 was over target on check-in, so it retired instead of going idle.
    expect(created[0].killed).toBe(1);
    expect(pool.stats().live).toBe(1);
    resolvers[1]();
    await second;
    // s2 is now exactly at target, so it stays warm.
    expect(created[1].killed).toBe(0);
    expect(pool.stats().live).toBe(1);
    pool.close();
  });

  it('does not respawn after a shrink drops a session below the old size', async () => {
    const created: FakeClient[] = [];
    const pool = new MetaSessionPool({
      size: 2,
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c;
      },
    });
    await pool.start();
    pool.resize(1);
    // s2 was retired; simulate its process exit — no replacement should spawn.
    created[1].exit();
    await flush();
    expect(created).toHaveLength(2);
    expect(pool.stats().live).toBe(1);
    pool.close();
  });

  it('ignores a resize once the pool is closed', async () => {
    const created: FakeClient[] = [];
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c;
      },
    });
    await pool.start();
    pool.close();
    pool.resize(5);
    await flush();
    expect(created).toHaveLength(1);
  });
});

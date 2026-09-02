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
    expect(created[0].turns).toEqual([{ prompt: 'hello' }]);
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
    });
    await pool.start();
    expect(pool.ready).toBe(true);
    const leased = await pool.acquire();
    expect(pool.stats()).toEqual({
      size: 2,
      live: 2,
      idle: 1,
      busy: 1,
      ready: true,
      served: 0,
    });
    pool.release(leased);
    pool.close();
    expect(pool.ready).toBe(false);
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
});

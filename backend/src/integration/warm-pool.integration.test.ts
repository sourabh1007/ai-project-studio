import { afterEach, describe, expect, it } from 'vitest';
import type { AcpTurnRequest, AcpTurnResult } from '../meta/acp/acp-client.js';
import { createAcpMetaRunner } from '../meta/acp/acp-meta-runner.js';
import { MetaSessionPool, type PooledClient } from '../meta/acp/acp-pool.js';
import { createMetaPoolsRoutes } from '../api/meta-pools-controller.js';
import { metaPoolsStatus, createPooledMetaRunner } from '../meta/pooled-meta-runner.js';
import { PoolDemandTracker } from '../meta/pool-demand.js';

class DeterministicClient implements PooledClient {
  alive = true;
  reusable = true;
  readonly turns: AcpTurnRequest[] = [];
  private readonly exits: Array<() => void> = [];

  constructor(readonly id: string) {}

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  runTurn(request: AcpTurnRequest): Promise<AcpTurnResult> {
    this.turns.push(request);
    request.onActivity?.('warm response');
    return Promise.resolve({
      text: `warm:${request.prompt}`,
      sessionId: this.id,
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 4 },
    });
  }

  onExit(handler: () => void): void {
    this.exits.push(handler);
  }

  dispose(): void {
    if (!this.alive) return;
    this.alive = false;
    this.reusable = false;
    for (const exit of this.exits) exit();
  }
}

const request = (prompt: string, forceCold = false) => ({
  featureId: 'feature-1',
  prompt,
  model: 'auto',
  forceCold,
  scope: 'internal' as const,
});

describe('shared warm-pool integration', () => {
  let pool: MetaSessionPool | null = null;

  afterEach(() => {
    pool?.close();
    pool = null;
  });

  it('routes warm and force-cold turns, then exposes live resize status', async () => {
    const clients: DeterministicClient[] = [];
    pool = new MetaSessionPool({
      size: 1,
      createClient: () => {
        const client = new DeterministicClient(`warm-client-${clients.length + 1}`);
        clients.push(client);
        return client;
      },
    });
    await pool.start();

    let coldCalls = 0;
    const cold = {
      async runDetailed(input: ReturnType<typeof request>) {
        coldCalls += 1;
        return {
          text: `cold:${input.prompt}`,
          sessionId: 'cold-session',
          transport: 'session' as const,
        };
      },
      async run(input: ReturnType<typeof request>) {
        return (await this.runDetailed(input)).text;
      },
    };
    const warm = createAcpMetaRunner({
      pool,
      newSessionId: () => 'warm-session-1',
      providerId: 'copilot',
      defaultModel: () => 'auto',
    });
    const demand = new PoolDemandTracker({
      now: () => Date.parse('2026-09-10T06:30:00.000Z'),
      windowMs: 60_000,
      maxSize: 4,
    });
    const routed = createPooledMetaRunner({
      pool: {
        ready: () => pool!.ready,
        stats: () => pool!.stats(),
        runDetailed: (input) => warm.runDetailed(input),
      },
      fallback: cold,
      defaultTimeoutMs: 1000,
      demand,
    });

    await expect(routed.runDetailed(request('warm'))).resolves.toMatchObject({
      text: 'warm:warm',
      transport: 'warm-acp',
    });
    await expect(routed.runDetailed(request('cold', true))).resolves.toMatchObject({
      text: 'cold:cold',
      transport: 'session',
    });
    expect(clients[0]?.turns).toHaveLength(1);
    expect(coldCalls).toBe(1);
    expect(pool.stats()).toMatchObject({ size: 1, live: 1, idle: 1, served: 1 });

    const status = () =>
      metaPoolsStatus(
        true,
        { stats: () => pool!.stats() },
        demand,
        'auto',
      );
    const routes = createMetaPoolsRoutes({
      status,
      resize: (size) => {
        pool!.resize(size);
        return status();
      },
    });
    const current = await routes[0]!.handler({
      params: {},
      query: {},
      body: null,
    });
    expect(current.body).toMatchObject({
      enabled: true,
      model: 'auto',
      pool: { size: 1, ready: true, served: 1 },
    });

    const resized = await routes[1]!.handler({
      params: {},
      query: {},
      body: { size: 2 },
    });
    expect(resized.body).toMatchObject({
      enabled: true,
      pool: { size: 2 },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pool.stats()).toMatchObject({ size: 2, live: 2, idle: 2 });
  });
});

import { describe, it, expect } from 'vitest';
import { createModelCatalogService } from './model-catalog-service.js';
import type {
  MetaModelOption,
  ModelCatalogProbe,
} from './model-catalog-contract.js';

function option(id: string): MetaModelOption {
  return {
    id,
    name: id,
    description: '',
    usageLabel: null,
    usageMultiplier: null,
    priceCategory: null,
    enabled: true,
  };
}

function fakeProbe(fetches: Array<MetaModelOption[] | null>): {
  probe: ModelCatalogProbe;
  calls: () => number;
} {
  let i = 0;
  let calls = 0;
  return {
    calls: () => calls,
    probe: {
      fetch: async () => {
        calls += 1;
        return fetches[Math.min(i++, fetches.length - 1)];
      },
    },
  };
}

function clock(startMs: number) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('model-catalog-service', () => {
  it('fetches on first read and caches the catalog', async () => {
    const { probe, calls } = fakeProbe([[option('gpt-5.4')]]);
    const c = clock(0);
    const svc = createModelCatalogService({ probe, now: c.now, ttlMs: 1000 });

    const first = await svc.read();
    expect(first?.map((m) => m.id)).toEqual(['gpt-5.4']);

    const second = await svc.read();
    expect(second).toEqual(first);
    expect(calls()).toBe(1); // served from cache
  });

  it('returns the stale catalog immediately and refreshes in the background', async () => {
    const { probe, calls } = fakeProbe([
      [option('gpt-5.4')],
      [option('claude-opus-5')],
    ]);
    const c = clock(0);
    const svc = createModelCatalogService({ probe, now: c.now, ttlMs: 1000 });

    await svc.read();
    c.advance(2000); // expire the cache

    const stale = await svc.read();
    expect(stale?.map((m) => m.id)).toEqual(['gpt-5.4']); // old value right away
    await new Promise((r) => setImmediate(r)); // let background refresh settle
    expect(calls()).toBe(2);

    const refreshed = await svc.read();
    expect(refreshed?.map((m) => m.id)).toEqual(['claude-opus-5']);
  });

  it('single-flights overlapping fetches', async () => {
    const { probe, calls } = fakeProbe([[option('gpt-5.4')]]);
    const c = clock(0);
    const svc = createModelCatalogService({ probe, now: c.now, ttlMs: 1000 });

    const [a, b] = await Promise.all([svc.refresh(), svc.refresh()]);
    expect(a).toEqual(b);
    expect(calls()).toBe(1);
  });

  it('retains the cache when a later fetch fails', async () => {
    const { probe } = fakeProbe([[option('gpt-5.4')], null]);
    const c = clock(0);
    const svc = createModelCatalogService({ probe, now: c.now, ttlMs: 1000 });

    await svc.read();
    c.advance(2000);
    const result = await svc.refresh();
    expect(result?.map((m) => m.id)).toEqual(['gpt-5.4']);
  });

  it('retains the cache when a later fetch is empty', async () => {
    const { probe } = fakeProbe([[option('gpt-5.4')], []]);
    const c = clock(0);
    const svc = createModelCatalogService({ probe, now: c.now, ttlMs: 1000 });

    await svc.read();
    const result = await svc.refresh();
    expect(result?.map((m) => m.id)).toEqual(['gpt-5.4']);
  });

  it('re-probes a negative-cached empty catalog on later reads so a slow first spawn fills in', async () => {
    const { probe, calls } = fakeProbe([null, [option('gpt-5.4')]]);
    const c = clock(0);
    const svc = createModelCatalogService({ probe, now: c.now, ttlMs: 1000 });
    // First probe fails → negative-cache an empty list (served without hanging).
    expect(await svc.read()).toEqual([]);
    expect(calls()).toBe(1);
    // A later read returns [] immediately but kicks a background re-probe.
    expect(await svc.read()).toEqual([]);
    await new Promise((r) => setImmediate(r));
    expect(calls()).toBe(2);
    // Once the probe succeeds the catalog fills in on the next read.
    const filled = await svc.read();
    expect(filled?.map((m) => m.id)).toEqual(['gpt-5.4']);
  });

  it('negative-caches an empty list when the first fetch is empty', async () => {
    const { probe } = fakeProbe([[]]);
    const c = clock(0);
    const svc = createModelCatalogService({ probe, now: c.now, ttlMs: 1000 });
    expect(await svc.read()).toEqual([]);
  });
});

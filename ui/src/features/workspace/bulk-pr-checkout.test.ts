import { describe, expect, it, vi } from 'vitest';
import type { Feature } from '../../lib/types.js';
import { bulkReviewName, checkoutPulls } from './bulk-pr-checkout.js';

const pulls = [1, 2, 3].map((number) => ({ number, title: `Pull ${number}` }));
const feature = (number: number) => ({ id: `f${number}` }) as Feature;
type Checkout = { feature: Feature; alreadyImported: boolean };
const imported = (number: number, alreadyImported = false): Checkout => ({
  feature: feature(number),
  alreadyImported,
});
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('parallel bulk checkout', () => {
  it('notifies each imported PR immediately, even when another checkout fails later', async () => {
    const first = feature(1);
    let failSecond!: (error: Error) => void;
    const onImported = vi.fn();
    const report = vi.fn();
    const api = {
      createPrFeatureStreamed: vi.fn((_repo: string, number: number) => number === 1
        ? Promise.resolve({ feature: first, alreadyImported: false })
        : new Promise<Checkout>((_resolve, reject) => { failSecond = reject; })),
    };
    const pending = checkoutPulls(api, 'repo', 'parent', pulls.slice(0, 2), report, onImported);
    const rejected = expect(pending).rejects.toThrow('Fetch failed');
    await flush();
    expect(onImported).toHaveBeenCalledOnce();
    expect(onImported).toHaveBeenCalledWith({ feature: first, number: 1, title: 'Pull 1', alreadyImported: false });
    expect(report.mock.lastCall![0]).toContain('#1 — Imported · review queued');
    failSecond(new Error('Fetch failed'));
    await rejected;
    expect(onImported).toHaveBeenCalledOnce();
  });

  it('marks a reused review as already imported and skipped', async () => {
    const onImported = vi.fn();
    const report = vi.fn();
    const api = {
      createPrFeatureStreamed: vi.fn((_repo: string, number: number) =>
        Promise.resolve(imported(number, number === 1))),
    };
    const results = await checkoutPulls(api, 'repo', 'parent', pulls.slice(0, 2), report, onImported);
    expect(onImported).toHaveBeenCalledWith({ feature: feature(1), number: 1, title: 'Pull 1', alreadyImported: true });
    expect(report.mock.lastCall![0]).toContain('#1 — Already imported — skipped');
    expect(report.mock.lastCall![0]).toContain('#2 — Imported · review queued');
    expect(results[0]).toEqual({ number: 1, title: 'Pull 1', feature: feature(1), alreadyImported: true });
  });

  it('suffixes the bulk name with its local creation date', () => {
    expect(bulkReviewName(new Date(2026, 8, 25))).toMatch(/^Bulk PR Review — 25 Sept? 2026$/);
  });

  it('starts two together, streams individual progress, and preserves selection order', async () => {
    const finish = new Map<number, (result: Checkout) => void>();
    const report = vi.fn();
    const createPrFeatureStreamed = vi.fn((_repo: string, number: number, status: (s: { phase: string; message: string }) => void) => {
      status({ phase: 'favouriting', message: 'Favouriting branch' });
      return new Promise<Checkout>((resolve) => finish.set(number, resolve));
    });
    const pending = checkoutPulls({ createPrFeatureStreamed }, 'repo', 'parent', pulls, report);
    expect(createPrFeatureStreamed.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(report.mock.lastCall![0]).toContain('#1 — Favouriting branch');
    expect(report.mock.lastCall![0]).toContain('#2 — Favouriting branch');
    expect(report.mock.lastCall![0]).toContain('#3 — Queued');
    finish.get(2)!(imported(2));
    await flush();
    expect(createPrFeatureStreamed.mock.calls.map((call) => call[1])).toEqual([1, 2, 3]);
    expect(report.mock.lastCall![0]).toContain('1/3 finished');
    expect(report.mock.lastCall![0]).toContain('#2 — Ready');
    finish.get(3)!(imported(3));
    finish.get(1)!(imported(1));
    expect(await pending).toEqual(pulls.map((pull) => ({ ...pull, feature: feature(pull.number), alreadyImported: false })));
    expect(report.mock.lastCall![0]).toContain('3/3 finished');
    expect(createPrFeatureStreamed).toHaveBeenCalledWith('repo', 1, expect.any(Function), 'parent');
  });

  it('drains in-flight work and continues queued PRs before reporting failures', async () => {
    let release!: (result: Checkout) => void;
    const report = vi.fn();
    const createPrFeatureStreamed = vi.fn((_repo: string, number: number) => {
      if (number === 1) return Promise.reject(new Error('Fetch failed'));
      if (number === 3) return Promise.reject('No access');
      return new Promise<Checkout>((resolve) => { release = resolve; });
    });
    const outcome = checkoutPulls({ createPrFeatureStreamed }, 'repo', 'parent', pulls, report).catch((error: Error) => error);
    const settled = vi.fn();
    void outcome.then(settled);
    await flush();
    expect(createPrFeatureStreamed).toHaveBeenCalledTimes(3);
    expect(settled).not.toHaveBeenCalled();
    release(imported(2));
    const error = await outcome as Error;
    expect(error.message).toContain('#1: Fetch failed');
    expect(error.message).toContain('#3: No access');
    expect(error.message).toContain('Successful reviews are saved');
    expect(report.mock.lastCall![0]).toContain('#2 — Ready');
  });
});

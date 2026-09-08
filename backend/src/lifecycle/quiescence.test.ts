import { describe, expect, it } from 'vitest';
import { requireQuiescence } from './quiescence.js';

describe('deletion quiescence', () => {
  it('requests all owners immediately and waits for the last confirmation', async () => {
    let finish!: (confirmed: boolean) => void;
    const requested: number[] = [];
    let complete = false;
    const pending = requireQuiescence([
      () => { requested.push(1); return new Promise<boolean>((resolve) => { finish = resolve; }); },
      async () => { requested.push(2); return true; },
    ]).then(() => { complete = true; });
    expect(requested).toEqual([1, 2]);
    await Promise.resolve();
    expect(complete).toBe(false);
    finish(true);
    await pending;
    expect(complete).toBe(true);
  });

  it('rejects unconfirmed shutdown instead of authorizing purge', async () => {
    await expect(requireQuiescence([async () => true, async () => false]))
      .rejects.toMatchObject({ kind: 'conflict' });
  });

  it('continues requesting cancellation after synchronous failure and retains rejection causes', async () => {
    const first = new Error('first');
    const second = new Error('second');
    let requested = false;
    await expect(requireQuiescence([
      () => { throw first; },
      async () => { requested = true; throw second; },
    ])).rejects.toMatchObject({ errors: [first, second] });
    expect(requested).toBe(true);
    await expect(requireQuiescence([])).resolves.toBeUndefined();
  });
});

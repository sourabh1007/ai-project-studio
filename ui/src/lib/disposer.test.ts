import { describe, expect, it, vi } from 'vitest';
import { createDisposer } from './disposer.js';

describe('createDisposer', () => {
  it('starts empty', () => {
    expect(createDisposer().size).toBe(0);
  });

  it('runs teardowns in reverse (LIFO) order and clears the bag', () => {
    const disposer = createDisposer();
    const order: number[] = [];
    disposer.add(() => order.push(1));
    disposer.add(() => order.push(2));
    disposer.add(() => order.push(3));
    expect(disposer.size).toBe(3);

    disposer.dispose();
    expect(order).toEqual([3, 2, 1]);
    expect(disposer.size).toBe(0);
  });

  it('is a safe no-op when disposed again', () => {
    const disposer = createDisposer();
    const teardown = vi.fn();
    disposer.add(teardown);
    disposer.dispose();
    disposer.dispose();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('runs remaining teardowns even if one throws', () => {
    const disposer = createDisposer();
    const after = vi.fn();
    disposer.add(after);
    disposer.add(() => {
      throw new Error('boom');
    });
    expect(() => disposer.dispose()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('can be reused after disposal', () => {
    const disposer = createDisposer();
    const first = vi.fn();
    disposer.add(first);
    disposer.dispose();

    const second = vi.fn();
    disposer.add(second);
    expect(disposer.size).toBe(1);
    disposer.dispose();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });
});

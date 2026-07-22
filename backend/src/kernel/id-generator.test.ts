import { describe, it, expect } from 'vitest';
import { createIdGenerator } from './id-generator.js';

describe('id-generator', () => {
  it('defaults to a UUID source producing unique values', () => {
    const gen = createIdGenerator();
    const a = gen.next();
    const b = gen.next();
    expect(a).not.toBe(b);
    expect(a).toMatch(/[0-9a-f-]{36}/);
  });

  it('uses an injected source', () => {
    let n = 0;
    const gen = createIdGenerator(() => `id-${++n}`);
    expect(gen.next()).toBe('id-1');
    expect(gen.next()).toBe('id-2');
  });
});

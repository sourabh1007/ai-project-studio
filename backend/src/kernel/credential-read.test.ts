import { describe, expect, it } from 'vitest';
import { credentialFromRead } from './credential-read.js';
import { AppError } from './error-types.js';

describe('credential read outcomes', () => {
  it('distinguishes confirmed credentials, a confirmed absence and an unavailable check', () => {
    expect(credentialFromRead({ state: 'ready', token: 'fixture' })).toBe('fixture');
    expect(credentialFromRead({ state: 'signed-out' })).toBeNull();
    expect(credentialFromRead({ state: 'interaction-required' })).toBeNull();
    expect(() => credentialFromRead({ state: 'unavailable' })).toThrow(AppError);
  });
});

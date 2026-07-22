import { describe, it, expect } from 'vitest';
import { resolveSecrets } from './secret-resolver.js';
import { ConfigError } from '../kernel/error-types.js';

describe('secret-resolver', () => {
  const lookup = (name: string): string | undefined =>
    ({ TOKEN: 'abc', HOST: 'example.com' })[name];

  it('resolves references in nested objects and arrays', () => {
    const out = resolveSecrets(
      {
        auth: '${env:TOKEN}',
        urls: ['https://${env:HOST}/a', 'plain'],
        nested: { key: 'pre-${env:TOKEN}-post' },
        num: 42,
        flag: true,
        nothing: null,
      },
      lookup,
    );
    expect(out).toEqual({
      auth: 'abc',
      urls: ['https://example.com/a', 'plain'],
      nested: { key: 'pre-abc-post' },
      num: 42,
      flag: true,
      nothing: null,
    });
  });

  it('resolves multiple references within one string', () => {
    const out = resolveSecrets({ v: '${env:TOKEN}@${env:HOST}' }, lookup);
    expect(out).toEqual({ v: 'abc@example.com' });
  });

  it('throws on unresolved references', () => {
    expect(() => resolveSecrets({ v: '${env:MISSING}' }, lookup)).toThrow(
      ConfigError,
    );
  });

  it('leaves strings without references untouched', () => {
    expect(resolveSecrets({ v: 'hello' }, lookup)).toEqual({ v: 'hello' });
  });
});

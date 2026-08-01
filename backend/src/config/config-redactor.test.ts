import { describe, it, expect } from 'vitest';
import {
  REDACTED,
  collectSecretPaths,
  redactSecretPaths,
} from './config-redactor.js';

describe('config-redactor', () => {
  describe('collectSecretPaths', () => {
    it('collects dotted paths of values holding a secret reference', () => {
      const paths = collectSecretPaths({
        providers: { token: '${env:GH_TOKEN}', name: 'plain' },
        credit: { limit: 10 },
        nested: { deep: { secret: 'prefix-${env:KEY}-suffix' } },
      });
      expect(paths.sort()).toEqual(
        ['nested.deep.secret', 'providers.token'].sort(),
      );
    });

    it('ignores arrays, nulls and non-string scalars', () => {
      const paths = collectSecretPaths({
        list: ['${env:IGNORED}'],
        empty: null,
        count: 42,
        flag: true,
      });
      expect(paths).toEqual([]);
    });
  });

  describe('redactSecretPaths', () => {
    it('redacts the value at each path without mutating the input', () => {
      const config = {
        providers: { token: 'resolved-secret', name: 'plain' },
        nested: { deep: { secret: 'also-secret' } },
      };
      const result = redactSecretPaths(config, [
        'providers.token',
        'nested.deep.secret',
      ]);
      expect(result).toEqual({
        providers: { token: REDACTED, name: 'plain' },
        nested: { deep: { secret: REDACTED } },
      });
      expect(config.providers.token).toBe('resolved-secret');
    });

    it('ignores paths that do not resolve to a value', () => {
      const config = { providers: { name: 'plain' }, scalar: 'x' };
      const result = redactSecretPaths(config, [
        'providers.missing',
        'scalar.child',
        'absent.deep',
      ]);
      expect(result).toEqual(config);
    });

    it('is a no-op for an empty path list', () => {
      const config = { a: 1 };
      expect(redactSecretPaths(config, [])).toEqual(config);
    });
  });
});

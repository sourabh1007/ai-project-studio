import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createConfigSchemaRegistry } from './config-schema-registry.js';
import { ConfigError } from '../kernel/error-types.js';

describe('config-schema-registry', () => {
  it('registers modules and exposes namespaces + defaults', () => {
    const reg = createConfigSchemaRegistry();
    reg.register({
      namespace: 'alpha',
      schema: z.object({ n: z.number() }),
      defaults: { n: 1 },
    });
    reg.register({
      namespace: 'beta',
      schema: z.object({ s: z.string() }),
      defaults: { s: 'x' },
    });
    expect(reg.namespaces()).toEqual(['alpha', 'beta']);
    expect(reg.defaults()).toEqual({ alpha: { n: 1 }, beta: { s: 'x' } });
  });

  it('combinedSchema validates the merged shape and rejects unknown namespaces', () => {
    const reg = createConfigSchemaRegistry();
    reg.register({
      namespace: 'alpha',
      schema: z.object({ n: z.number() }),
      defaults: { n: 1 },
    });
    const schema = reg.combinedSchema();
    expect(schema.parse({ alpha: { n: 5 } })).toEqual({ alpha: { n: 5 } });
    expect(() => schema.parse({ alpha: { n: 5 }, ghost: {} })).toThrow();
  });

  it('throws on duplicate namespace registration', () => {
    const reg = createConfigSchemaRegistry();
    reg.register({ namespace: 'dup', schema: z.object({}), defaults: {} });
    expect(() =>
      reg.register({ namespace: 'dup', schema: z.object({}), defaults: {} }),
    ).toThrow(ConfigError);
  });

  it('exposes the schema and defaults for a single namespace', () => {
    const reg = createConfigSchemaRegistry();
    const schema = z.object({ n: z.number() });
    reg.register({ namespace: 'alpha', schema, defaults: { n: 1 } });
    expect(reg.schemaFor('alpha')).toBe(schema);
    expect(reg.defaultsFor('alpha')).toEqual({ n: 1 });
  });

  it('returns undefined for an unregistered namespace', () => {
    const reg = createConfigSchemaRegistry();
    expect(reg.schemaFor('ghost')).toBeUndefined();
    expect(reg.defaultsFor('ghost')).toBeUndefined();
  });
});

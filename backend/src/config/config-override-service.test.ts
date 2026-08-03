import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createConfigOverrideService } from './config-override-service.js';
import { createConfigSchemaRegistry } from './config-schema-registry.js';
import type {
  ConfigOverrideRecord,
  ConfigOverrideStore,
} from './config-override-store.js';
import { createClock } from '../kernel/clock.js';
import { NotFoundError, ValidationError } from '../kernel/error-types.js';

function inMemoryStore(): ConfigOverrideStore {
  const rows = new Map<string, ConfigOverrideRecord>();
  return {
    all: () => [...rows.values()],
    get: (namespace) => rows.get(namespace) ?? null,
    set: (record) => {
      rows.set(record.namespace, record);
    },
    delete: (namespace) => {
      rows.delete(namespace);
    },
  };
}

function setup(onChanged?: (namespace: string) => void) {
  const registry = createConfigSchemaRegistry();
  registry.register({
    namespace: 'demo',
    schema: z.object({
      enabled: z.boolean(),
      label: z.string(),
      nested: z.object({ a: z.number(), b: z.number() }),
    }),
    defaults: { enabled: true, label: 'default', nested: { a: 1, b: 2 } },
  });
  registry.register({
    namespace: 'scalar',
    schema: z.string(),
    defaults: 'hi',
  });
  const store = inMemoryStore();
  const service = createConfigOverrideService({
    store,
    registry,
    clock: createClock(() => 1000),
    onChanged,
  });
  return { service, store };
}

describe('config-override-service', () => {
  it('getOverride returns an empty object when nothing is stored', () => {
    const { service } = setup();
    expect(service.getOverride('demo')).toEqual({});
  });

  it('deep-merges a patch, validates, and persists the merged override', () => {
    const changed: string[] = [];
    const { service, store } = setup((ns) => changed.push(ns));
    service.update('demo', { nested: { a: 9 } });
    const result = service.update('demo', { label: 'custom' });
    expect(result).toEqual({
      namespace: 'demo',
      effective: {
        enabled: true,
        label: 'custom',
        nested: { a: 9, b: 2 },
      },
      override: { nested: { a: 9 }, label: 'custom' },
      requiresRestart: true,
    });
    expect(store.get('demo')?.updatedAt).toBe('1970-01-01T00:00:01.000Z');
    expect(service.getOverride('demo')).toEqual({
      nested: { a: 9 },
      label: 'custom',
    });
    expect(changed).toEqual(['demo', 'demo']);
  });

  it('throws ValidationError when the effective config is invalid', () => {
    const { service } = setup();
    expect(() => service.update('demo', { enabled: 'nope' })).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError when the patch is not an object', () => {
    const { service } = setup();
    expect(() =>
      service.update('demo', 'nope' as unknown as Record<string, unknown>),
    ).toThrow(ValidationError);
  });

  it('summarizes a root-level validation error as <root>', () => {
    const registry = createConfigSchemaRegistry();
    registry.register({
      namespace: 'root',
      schema: z
        .object({ x: z.number() })
        .refine(() => false, 'root is invalid'),
      defaults: { x: 1 },
    });
    const service = createConfigOverrideService({
      store: inMemoryStore(),
      registry,
      clock: createClock(() => 0),
    });
    expect(() => service.update('root', {})).toThrow(/<root>: root is invalid/);
  });

  it('rethrows a non-Zod error raised while validating', () => {
    const registry = createConfigSchemaRegistry();
    registry.register({
      namespace: 'boom',
      schema: {
        parse: () => {
          throw new Error('kaboom');
        },
      } as unknown as z.ZodType,
      defaults: {},
    });
    const service = createConfigOverrideService({
      store: inMemoryStore(),
      registry,
      clock: createClock(() => 0),
    });
    expect(() => service.update('boom', {})).toThrow('kaboom');
  });

  it('throws NotFoundError for an unknown namespace', () => {
    const { service } = setup();
    expect(() => service.update('ghost', {})).toThrow(NotFoundError);
  });

  it('throws ValidationError when a namespace default is not an object', () => {
    const { service } = setup();
    expect(() => service.update('scalar', {})).toThrow(ValidationError);
  });

  it('reset clears the override and returns defaults', () => {
    const changed: string[] = [];
    const { service, store } = setup((ns) => changed.push(ns));
    service.update('demo', { label: 'custom' });
    const result = service.reset('demo');
    expect(result).toEqual({
      namespace: 'demo',
      effective: { enabled: true, label: 'default', nested: { a: 1, b: 2 } },
      override: {},
      requiresRestart: true,
    });
    expect(store.get('demo')).toBeNull();
    expect(changed).toEqual(['demo', 'demo']);
  });
});

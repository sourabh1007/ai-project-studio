import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  describeZodType,
  describeNamespaces,
  type FieldMeta,
} from './config-schema-describe.js';
import { createConfigSchemaRegistry } from './config-schema-registry.js';

describe('describeZodType', () => {
  it('describes a plain string', () => {
    expect(describeZodType(z.string())).toEqual({ kind: 'string' });
  });

  it('captures string min/max length and description', () => {
    const meta = describeZodType(
      z.string().min(2).max(8).describe('a label'),
    );
    expect(meta).toEqual({
      kind: 'string',
      minLength: 2,
      maxLength: 8,
      description: 'a label',
    });
  });

  it('describes numbers with min, max and int', () => {
    expect(describeZodType(z.number().int().min(1).max(10))).toEqual({
      kind: 'number',
      int: true,
      min: 1,
      max: 10,
    });
  });

  it('ignores number checks it does not model (e.g. finite)', () => {
    expect(describeZodType(z.number().finite())).toEqual({ kind: 'number' });
  });

  it('describes booleans', () => {
    expect(describeZodType(z.boolean())).toEqual({ kind: 'boolean' });
  });

  it('describes a literal as a single-option enum', () => {
    expect(describeZodType(z.literal('auto'))).toEqual({
      kind: 'enum',
      options: ['auto'],
    });
  });

  it('describes a string enum', () => {
    expect(describeZodType(z.enum(['a', 'b', 'c']))).toEqual({
      kind: 'enum',
      options: ['a', 'b', 'c'],
    });
  });

  it('describes a native enum keeping only string values', () => {
    enum Mode {
      On = 'on',
      Off = 'off',
    }
    expect(describeZodType(z.nativeEnum(Mode))).toEqual({
      kind: 'enum',
      options: ['on', 'off'],
    });
  });

  it('describes a union of literals as an enum', () => {
    const schema = z.union([z.literal('x'), z.literal('y')]);
    expect(describeZodType(schema)).toEqual({
      kind: 'enum',
      options: ['x', 'y'],
    });
  });

  it('falls back to unknown for a non-literal union', () => {
    const schema = z.union([z.string(), z.number()]);
    expect(describeZodType(schema)).toEqual({ kind: 'unknown' });
  });

  it('describes arrays of scalars and of objects', () => {
    expect(describeZodType(z.array(z.string()))).toEqual({
      kind: 'array',
      element: { kind: 'string' },
    });
    const objArray = describeZodType(
      z.array(z.object({ id: z.number().int() })),
    );
    expect(objArray).toEqual({
      kind: 'array',
      element: {
        kind: 'object',
        fields: { id: { kind: 'number', int: true } },
      },
    });
  });

  it('describes nested objects', () => {
    const schema = z.object({
      name: z.string(),
      nested: z.object({ flag: z.boolean() }),
    });
    expect(describeZodType(schema)).toEqual({
      kind: 'object',
      fields: {
        name: { kind: 'string' },
        nested: { kind: 'object', fields: { flag: { kind: 'boolean' } } },
      },
    });
  });

  it('unwraps optional carrying the flag and description', () => {
    const meta = describeZodType(z.string().optional());
    expect(meta).toEqual({ kind: 'string', optional: true });
  });

  it('unwraps nullable', () => {
    expect(describeZodType(z.number().nullable())).toEqual({
      kind: 'number',
      nullable: true,
    });
  });

  it('unwraps default capturing the default value', () => {
    expect(describeZodType(z.string().default('hi'))).toEqual({
      kind: 'string',
      default: 'hi',
    });
  });

  it('unwraps effects (superRefine / transform wrappers)', () => {
    const schema = z
      .array(z.number())
      .superRefine((_value, _ctx) => undefined);
    expect(describeZodType(schema)).toEqual({
      kind: 'array',
      element: { kind: 'number' },
    });
  });

  it('carries a description through a wrapper type', () => {
    const meta = describeZodType(z.string().optional().describe('opt field'));
    expect(meta.description).toBe('opt field');
    expect(meta.optional).toBe(true);
  });

  it('returns unknown for unsupported schema types', () => {
    expect(describeZodType(z.date())).toEqual({ kind: 'unknown' });
  });
});

describe('describeNamespaces', () => {
  it('maps every registered namespace to its field metadata', () => {
    const registry = createConfigSchemaRegistry();
    registry.register({
      namespace: 'demo',
      schema: z.object({ enabled: z.boolean() }),
      defaults: { enabled: true },
    });
    const described = describeNamespaces(registry);
    const expected: Record<string, FieldMeta> = {
      demo: {
        kind: 'object',
        fields: { enabled: { kind: 'boolean' } },
      },
    };
    expect(described).toEqual(expected);
  });
});

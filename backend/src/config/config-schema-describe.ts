import type { ZodType, ZodTypeAny } from 'zod';
import type { ConfigSchemaRegistry } from './config-schema-registry.js';

/**
 * Structural metadata for a single configuration setting, derived by
 * introspecting its zod schema. The Settings UI consumes this to render the
 * right control for each field (text box, number with bounds, toggle, enum
 * dropdown, nested group, editable list) without hardcoding any knowledge of a
 * module's settings — new modules become editable automatically.
 *
 * The shape is intentionally plain/JSON-serializable so it can cross the HTTP
 * boundary unchanged.
 */
export type FieldKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'array'
  | 'object'
  | 'unknown';

export interface FieldMeta {
  kind: FieldKind;
  /** True when the value may be omitted (ZodOptional). */
  optional?: boolean;
  /** True when the value may be null (ZodNullable). */
  nullable?: boolean;
  /** Human-readable help text from `.describe()`, when the schema provides it. */
  description?: string;
  /** The schema-level default value (ZodDefault), when present. */
  default?: unknown;
  /** number: inclusive lower bound. */
  min?: number;
  /** number: inclusive upper bound. */
  max?: number;
  /** number: whether only integers are allowed. */
  int?: boolean;
  /** string: minimum length. */
  minLength?: number;
  /** string: maximum length. */
  maxLength?: number;
  /** enum: the allowed values. */
  options?: string[];
  /** array: metadata for the element type. */
  element?: FieldMeta;
  /** object: metadata for each property. */
  fields?: Record<string, FieldMeta>;
}

interface ZodDef {
  typeName?: string;
  description?: string;
  innerType?: ZodTypeAny;
  schema?: ZodTypeAny;
  type?: ZodTypeAny;
  defaultValue?: () => unknown;
  values?: unknown;
  value?: unknown;
  options?: unknown;
  shape?: () => Record<string, ZodTypeAny>;
  checks?: Array<{ kind: string; value?: number }>;
}

function defOf(schema: ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function applyNumberChecks(def: ZodDef, meta: FieldMeta): void {
  for (const check of def.checks!) {
    if (check.kind === 'min' && typeof check.value === 'number') {
      meta.min = check.value;
    } else if (check.kind === 'max' && typeof check.value === 'number') {
      meta.max = check.value;
    } else if (check.kind === 'int') {
      meta.int = true;
    }
  }
}

function applyStringChecks(def: ZodDef, meta: FieldMeta): void {
  for (const check of def.checks!) {
    if (check.kind === 'min' && typeof check.value === 'number') {
      meta.minLength = check.value;
    } else if (check.kind === 'max' && typeof check.value === 'number') {
      meta.maxLength = check.value;
    }
  }
}

function literalOptions(options: ZodTypeAny[]): string[] | undefined {
  const values: string[] = [];
  for (const option of options) {
    const def = defOf(option);
    if (def.typeName !== 'ZodLiteral') {
      // A non-literal member means this isn't a plain enum-like union.
      return undefined;
    }
    values.push(String(def.value));
  }
  return values;
}

/**
 * Recursively introspects a zod (v3) schema into JSON-serializable
 * {@link FieldMeta}. Wrapper types (optional/nullable/default/effects) are
 * unwrapped, carrying their flag/default/description onto the underlying field.
 */
export function describeZodType(schema: ZodType): FieldMeta {
  const def = defOf(schema as ZodTypeAny);
  const description =
    def.description ?? (schema as { description?: string }).description;

  switch (def.typeName) {
    case 'ZodOptional': {
      const inner = describeZodType(def.innerType as ZodTypeAny);
      return { ...inner, optional: true, ...withDescription(description) };
    }
    case 'ZodNullable': {
      const inner = describeZodType(def.innerType as ZodTypeAny);
      return { ...inner, nullable: true, ...withDescription(description) };
    }
    case 'ZodDefault': {
      const inner = describeZodType(def.innerType as ZodTypeAny);
      return {
        ...inner,
        default: def.defaultValue?.(),
        ...withDescription(description),
      };
    }
    case 'ZodEffects': {
      const inner = describeZodType(def.schema as ZodTypeAny);
      return { ...inner, ...withDescription(description) };
    }
    case 'ZodString': {
      const meta: FieldMeta = { kind: 'string' };
      applyStringChecks(def, meta);
      return { ...meta, ...withDescription(description) };
    }
    case 'ZodNumber': {
      const meta: FieldMeta = { kind: 'number' };
      applyNumberChecks(def, meta);
      return { ...meta, ...withDescription(description) };
    }
    case 'ZodBoolean':
      return { kind: 'boolean', ...withDescription(description) };
    case 'ZodLiteral':
      return {
        kind: 'enum',
        options: [String(def.value)],
        ...withDescription(description),
      };
    case 'ZodEnum':
      return {
        kind: 'enum',
        options: def.values as string[],
        ...withDescription(description),
      };
    case 'ZodNativeEnum':
      return {
        kind: 'enum',
        options: Object.values(def.values as Record<string, unknown>)
          .filter((v) => typeof v === 'string')
          .map((v) => String(v)),
        ...withDescription(description),
      };
    case 'ZodUnion': {
      const options = literalOptions(def.options as ZodTypeAny[]);
      if (options) {
        return { kind: 'enum', options, ...withDescription(description) };
      }
      return { kind: 'unknown', ...withDescription(description) };
    }
    case 'ZodArray':
      return {
        kind: 'array',
        element: describeZodType(def.type as ZodTypeAny),
        ...withDescription(description),
      };
    case 'ZodObject': {
      const shape = def.shape!();
      const fields: Record<string, FieldMeta> = {};
      for (const [key, value] of Object.entries(shape)) {
        fields[key] = describeZodType(value);
      }
      return { kind: 'object', fields, ...withDescription(description) };
    }
    default:
      return { kind: 'unknown', ...withDescription(description) };
  }
}

function withDescription(
  description: string | undefined,
): { description?: string } {
  return description ? { description } : {};
}

/** Metadata for every registered namespace, keyed by namespace name. */
export function describeNamespaces(
  registry: ConfigSchemaRegistry,
): Record<string, FieldMeta> {
  const out: Record<string, FieldMeta> = {};
  for (const namespace of registry.namespaces()) {
    // A registered namespace always has a schema, so the lookup is non-null.
    out[namespace] = describeZodType(registry.schemaFor(namespace)!);
  }
  return out;
}

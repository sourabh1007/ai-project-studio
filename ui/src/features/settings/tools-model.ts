import type { CommandCatalogEntry, ConfigResponse, ConfigValue, FieldMeta } from '../../lib/types.js';

export function toolFields(entries: readonly CommandCatalogEntry[]): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.config) continue;
    fields.set(entry.config.namespace, [...new Set([...(fields.get(entry.config.namespace) ?? []), ...entry.config.keys])]);
  }
  return fields;
}

export function projectToolValues(values: Record<string, ConfigValue>, paths: readonly string[]): Record<string, ConfigValue> {
  const projected: Record<string, ConfigValue> = {};
  for (const path of paths) {
    let value: unknown = values;
    for (const segment of path.split('.')) {
      value = value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined;
    }
    if (value !== undefined) projected[path] = value as ConfigValue;
  }
  return projected;
}

export function projectToolConfig(data: ConfigResponse, fields: ReadonlyMap<string, readonly string[]>): ConfigResponse {
  const current = { ...data.current };
  const schema = { ...data.schema };
  const overrides = { ...data.overrides };
  for (const [namespace, paths] of fields) {
    current[namespace] = projectToolValues(data.current[namespace] ?? {}, paths);
    overrides[namespace] = projectToolValues(data.overrides[namespace] ?? {}, paths);
    const meta: Record<string, FieldMeta> = {};
    for (const path of paths) {
      let field = data.schema?.[namespace];
      for (const segment of path.split('.')) field = field?.fields?.[segment];
      if (field) meta[path] = field;
    }
    schema[namespace] = { kind: 'object', fields: meta };
  }
  return { ...data, current, schema, overrides };
}

/** Dotted catalog references are expanded back into the owning module patch. */
export function setToolPatch(patch: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let target = patch;
  for (const segment of segments.slice(0, -1)) {
    target[segment] ??= {};
    target = target[segment] as Record<string, unknown>;
  }
  target[segments.at(-1)!] = value;
}

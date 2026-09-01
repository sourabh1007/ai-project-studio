import type { ConfigValue, FieldMeta } from './types.js';

/**
 * Settings model helpers. All logic that decides how a config value is edited
 * (which control, how raw input is parsed/validated, how namespaces group into
 * tabs) lives here as pure functions so it is fully unit-tested, independent of
 * the React presentation in `settings-view.tsx`.
 */

/** The editor control used for a single setting. */
export type ControlKind =
  | 'boolean'
  | 'number'
  | 'enum'
  | 'text'
  | 'multiline'
  | 'json';

/** Long or multi-line strings (e.g. prompt templates) get a textarea editor. */
export function isMultiline(value: string): boolean {
  return value.includes('\n') || value.length > 60;
}

/**
 * Decides the control for a setting, preferring the schema metadata and falling
 * back to the runtime value's type when a field has no metadata (older backend
 * or a value the schema can't describe).
 */
export function controlKindFor(
  meta: FieldMeta | undefined,
  value: ConfigValue,
): ControlKind {
  if (meta) {
    switch (meta.kind) {
      case 'boolean':
        return 'boolean';
      case 'number':
        return 'number';
      case 'enum':
        return 'enum';
      case 'string':
        return typeof value === 'string' && isMultiline(value)
          ? 'multiline'
          : 'text';
      case 'array':
      case 'object':
      case 'unknown':
        return 'json';
    }
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'string') {
    return isMultiline(value) ? 'multiline' : 'text';
  }
  return 'json';
}

/** The initial editor state for a value given its control. */
export function seedValue(
  value: ConfigValue,
  control: ControlKind,
): string | boolean {
  if (control === 'boolean') {
    return value as boolean;
  }
  if (control === 'json') {
    return JSON.stringify(value, null, 2);
  }
  if (control === 'enum' || control === 'text' || control === 'multiline') {
    return value == null ? '' : String(value);
  }
  return String(value);
}

/**
 * Parses an editor input back to its typed value, enforcing the schema's
 * constraints (enum membership, numeric bounds, integer-only). Throws an Error
 * with a user-facing message on malformed or out-of-range input.
 */
export function parseInput(
  raw: string | boolean,
  control: ControlKind,
  meta?: FieldMeta,
): unknown {
  if (control === 'boolean') {
    return raw as boolean;
  }
  if (control === 'number') {
    const n = Number(raw);
    if (raw === '' || Number.isNaN(n)) {
      throw new Error('Enter a valid number.');
    }
    if (meta?.int && !Number.isInteger(n)) {
      throw new Error('Enter a whole number.');
    }
    if (meta?.min != null && n < meta.min) {
      throw new Error(`Must be at least ${meta.min}.`);
    }
    if (meta?.max != null && n > meta.max) {
      throw new Error(`Must be at most ${meta.max}.`);
    }
    return n;
  }
  if (control === 'json') {
    return JSON.parse(raw as string);
  }
  if (control === 'enum') {
    const value = raw as string;
    if (meta?.options && !meta.options.includes(value)) {
      throw new Error('Choose one of the allowed values.');
    }
    return value;
  }
  return raw as string;
}

/** True when the draft input, once parsed, equals the original value. */
export function sameValue(
  raw: string | boolean,
  original: ConfigValue,
  control: ControlKind,
  meta?: FieldMeta,
): boolean {
  try {
    return JSON.stringify(parseInput(raw, control, meta)) ===
      JSON.stringify(original);
  } catch {
    return false;
  }
}

/** A single editable setting within a namespace. */
export interface SettingField {
  key: string;
  control: ControlKind;
  meta?: FieldMeta;
  value: ConfigValue;
}

/** Builds the ordered editable fields for one namespace. */
export function buildFields(
  values: Record<string, ConfigValue>,
  fieldsMeta: Record<string, FieldMeta> | undefined,
): SettingField[] {
  return Object.entries(values).map(([key, value]) => {
    const meta = fieldsMeta?.[key];
    return { key, value, meta, control: controlKindFor(meta, value) };
  });
}

/** True when a namespace/key pair matches a lowercased search term. */
export function matchesQuery(
  namespace: string,
  key: string,
  term: string,
): boolean {
  if (!term) {
    return true;
  }
  return `${namespace}.${key}`.toLowerCase().includes(term);
}

/** A named group of related config namespaces, rendered as one tab. */
export interface ConfigTab {
  id: string;
  label: string;
  namespaces: string[];
}

interface CategoryDef {
  id: string;
  label: string;
  members: string[];
}

// Curated grouping so related modules sit under one tab. Any namespace not
// listed falls into "Other", so new modules still appear without a code change.
const CATEGORY_DEFS: CategoryDef[] = [
  {
    id: 'ai',
    label: 'AI & Automation',
    members: [
      'meta',
      'providers',
      'provider',
      'summarizer',
      'pr-review',
      'review-board',
      'skills',
      'automation',
      'self-recovery',
      'copilot-history',
      'session-import',
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    members: [
      'session',
      'feature-tree',
      'feature-tasks',
      'repository-context',
      'context-store',
      'repo-insights',
    ],
  },
  {
    id: 'usage',
    label: 'Usage & Cost',
    members: ['usage', 'ide-usage', 'aggregation', 'credit'],
  },
  {
    id: 'system',
    label: 'System',
    members: ['logging', 'persistence', 'terminal', 'mcp', 'api', 'auth-warmer'],
  },
];

const OTHER_CATEGORY = { id: 'other', label: 'Other' };

/** Groups the given namespaces into ordered, non-empty tabs. */
export function buildConfigTabs(namespaces: string[]): ConfigTab[] {
  const remaining = new Set(namespaces);
  const tabs: ConfigTab[] = [];
  for (const category of CATEGORY_DEFS) {
    const members = category.members.filter((ns) => remaining.has(ns));
    for (const ns of members) {
      remaining.delete(ns);
    }
    if (members.length > 0) {
      tabs.push({ id: category.id, label: category.label, namespaces: members });
    }
  }
  const leftover = namespaces.filter((ns) => remaining.has(ns));
  if (leftover.length > 0) {
    tabs.push({
      id: OTHER_CATEGORY.id,
      label: OTHER_CATEGORY.label,
      namespaces: leftover,
    });
  }
  return tabs;
}

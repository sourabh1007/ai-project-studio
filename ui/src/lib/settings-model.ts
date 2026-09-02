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

/**
 * Tokens that read better fully upper-cased in a humanized label than
 * title-cased (e.g. `providerId` → "Provider ID", not "Provider Id").
 */
const LABEL_ACRONYMS = new Set([
  'id',
  'url',
  'uri',
  'api',
  'ui',
  'ip',
  'ttl',
  'mcp',
  'json',
  'http',
  'https',
  'sql',
  'pr',
  'cli',
  'uuid',
  'db',
  'sdk',
  'os',
  'css',
  'html',
  'acp',
  'ide',
  'ai',
  'sse',
  'ws',
]);

/**
 * Turns a raw config key (`providerId`, `response_text_keys`, `timeoutMs`)
 * into a readable Title Case label ("Provider ID", "Response Text Keys",
 * "Timeout (ms)"). camelCase, snake_case and kebab-case boundaries all split;
 * known acronyms upper-case and a trailing `ms` renders as the unit "(ms)".
 */
export function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) {
    return key;
  }
  return words
    .map((word) => {
      const lower = word.toLowerCase();
      if (lower === 'ms') {
        return '(ms)';
      }
      if (LABEL_ACRONYMS.has(lower)) {
        return lower.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function formatDefault(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/**
 * Generates fallback help text for a field with no schema description, derived
 * from its control, constraints and default, so every setting shows guidance
 * even before a module adds an explicit `.describe()`.
 */
function generatedHelp(field: SettingField): string {
  const meta = field.meta;
  const parts: string[] = [];
  switch (field.control) {
    case 'boolean':
      parts.push('On/off toggle.');
      break;
    case 'number':
      parts.push(meta?.int ? 'Whole number.' : 'Numeric value.');
      if (meta?.min != null && meta?.max != null) {
        parts.push(`Between ${meta.min} and ${meta.max}.`);
      } else if (meta?.min != null) {
        parts.push(`At least ${meta.min}.`);
      } else if (meta?.max != null) {
        parts.push(`At most ${meta.max}.`);
      }
      break;
    case 'enum':
      parts.push(
        meta?.options && meta.options.length > 0
          ? `One of: ${meta.options.join(', ')}.`
          : 'Choose a value.',
      );
      break;
    case 'text':
    case 'multiline':
      parts.push('Text value.');
      if (meta?.minLength != null && meta?.maxLength != null) {
        parts.push(`${meta.minLength}–${meta.maxLength} characters.`);
      } else if (meta?.minLength != null) {
        parts.push(`At least ${meta.minLength} characters.`);
      } else if (meta?.maxLength != null) {
        parts.push(`Up to ${meta.maxLength} characters.`);
      }
      break;
    default:
      parts.push(
        meta?.kind === 'array'
          ? 'Editable list (JSON).'
          : 'Structured value (JSON).',
      );
      break;
  }
  if (meta?.default !== undefined) {
    parts.push(`Default: ${formatDefault(meta.default)}.`);
  }
  if (meta?.optional) {
    parts.push('Optional.');
  }
  if (meta?.nullable) {
    parts.push('May be null.');
  }
  return parts.join(' ');
}

/**
 * Help text for a field: the schema's own `.describe()` when present, otherwise
 * a generated summary of the field's type, constraints and default — so there
 * is always guidance under every label.
 */
export function fieldHelp(field: SettingField): string {
  if (field.meta?.description) {
    return field.meta.description;
  }
  return generatedHelp(field);
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

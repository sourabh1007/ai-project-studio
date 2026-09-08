import {
  buildFields,
  sameValue,
  seedValue,
  type SettingField,
} from '../../lib/settings-model.js';
import type {
  ConfigUpdateResult,
  ConfigValue,
  FieldMeta,
} from '../../lib/types.js';

export interface NamespaceDraftState {
  values: Record<string, string | boolean>;
  baseValues: Record<string, ConfigValue>;
  conflicts: string[];
}

export type SettingsDraftStore = Record<string, NamespaceDraftState>;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function isDraftValue(value: unknown): value is string | boolean {
  return typeof value === 'string' || typeof value === 'boolean';
}

function isNamespaceDraftState(value: unknown): value is NamespaceDraftState {
  if (!isObject(value)) {
    return false;
  }
  const values = value.values;
  const baseValues = value.baseValues;
  const conflicts = value.conflicts;
  return (
    isObject(values) &&
    Object.values(values).every((entry) => isDraftValue(entry)) &&
    isObject(baseValues) &&
    Array.isArray(conflicts) &&
    conflicts.every((entry) => typeof entry === 'string')
  );
}

export function isSettingsDraftStore(value: unknown): value is SettingsDraftStore {
  return (
    isObject(value) &&
    Object.values(value).every((entry) => isNamespaceDraftState(entry))
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createNamespaceDraftState(
  fields: readonly SettingField[],
): NamespaceDraftState {
  return {
    values: Object.fromEntries(
      fields.map((field) => [field.key, seedValue(field.value, field.control)]),
    ),
    baseValues: Object.fromEntries(
      fields.map((field) => [field.key, field.value]),
    ),
    conflicts: [],
  };
}

export function reconcileNamespaceDraftState(
  existing: NamespaceDraftState | undefined,
  fields: readonly SettingField[],
): NamespaceDraftState {
  if (!existing) {
    return createNamespaceDraftState(fields);
  }

  const values: Record<string, string | boolean> = {};
  const baseValues: Record<string, ConfigValue> = {};
  const conflicts: string[] = [];

  for (const field of fields) {
    const serverValue = field.value;
    const previousBase = existing.baseValues[field.key];
    const hasPreviousBase = Object.prototype.hasOwnProperty.call(
      existing.baseValues,
      field.key,
    );
    const currentValue =
      existing.values[field.key] ?? seedValue(serverValue, field.control);
    const wasDirty =
      hasPreviousBase &&
      !sameValue(currentValue, previousBase, field.control, field.meta);
    const serverChanged =
      hasPreviousBase && !sameJsonValue(previousBase, serverValue);

    values[field.key] = wasDirty
      ? currentValue
      : seedValue(serverValue, field.control);
    baseValues[field.key] = serverValue;

    if (
      wasDirty &&
      serverChanged &&
      !sameValue(currentValue, serverValue, field.control, field.meta)
    ) {
      conflicts.push(field.key);
    }
  }

  return { values, baseValues, conflicts };
}

export function reconcileSettingsDraftStore(
  existing: SettingsDraftStore,
  namespaces: Record<string, Record<string, ConfigValue>>,
  schema: Record<string, FieldMeta> | undefined,
): SettingsDraftStore {
  return Object.fromEntries(
    Object.entries(namespaces).map(([namespace, values]) => {
      const fields = buildFields(values, schema?.[namespace]?.fields);
      return [
        namespace,
        reconcileNamespaceDraftState(existing[namespace], fields),
      ];
    }),
  );
}

export function updateNamespaceDraftValue(
  state: NamespaceDraftState,
  key: string,
  value: string | boolean,
): NamespaceDraftState {
  return { ...state, values: { ...state.values, [key]: value } };
}

export function discardNamespaceDraftConflicts(
  state: NamespaceDraftState,
  fields: readonly SettingField[],
  keys: readonly string[] = state.conflicts,
): NamespaceDraftState {
  if (keys.length === 0) {
    return state;
  }
  const discard = new Set(keys);
  return reconcileNamespaceDraftState(
    {
      ...state,
      values: {
        ...state.values,
        ...Object.fromEntries(
          fields
            .filter((field) => discard.has(field.key))
            .map((field) => [
              field.key,
              seedValue(field.value, field.control),
            ]),
        ),
      },
      conflicts: [],
    },
    fields,
  );
}

export function applyConfigUpdateToDraftStore(
  store: SettingsDraftStore,
  result: ConfigUpdateResult,
  schema: Record<string, FieldMeta> | undefined,
): SettingsDraftStore {
  const fields = buildFields(result.effective, schema?.[result.namespace]?.fields);
  return {
    ...store,
    [result.namespace]: createNamespaceDraftState(fields),
  };
}

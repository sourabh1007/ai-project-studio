/**
 * The AI provider + model every new metasession runs with. Held as a small
 * mutable, in-memory store so the IDE can change which model powers its AI
 * features (summaries, PR review, monitors, …) at runtime — the cold
 * {@link createMetaRunner} reads it fresh on every run, so a change takes effect
 * for all *new* metasessions immediately, with no IDE restart.
 */
export interface MetaSettingsValue {
  /** Provider id the metasession launcher targets (e.g. `agency`, `copilot`). */
  providerId: string;
  /** Requested model; `auto` lets the provider CLI pick its default. */
  model: string;
}

export interface MetaSettings {
  /** Current settings (a copy — callers cannot mutate the store in place). */
  get(): MetaSettingsValue;
  /**
   * Merges a partial patch onto the current settings and returns the result.
   * Listeners registered via {@link onChange} fire only when a value actually
   * changed.
   */
  set(patch: Partial<MetaSettingsValue>): MetaSettingsValue;
  /** Registers a listener invoked with the new settings after a real change. */
  onChange(listener: (value: MetaSettingsValue) => void): void;
}

/** Creates a runtime meta-settings store seeded from the persisted config. */
export function createMetaSettings(initial: MetaSettingsValue): MetaSettings {
  let current: MetaSettingsValue = { ...initial };
  const listeners: Array<(value: MetaSettingsValue) => void> = [];
  return {
    get: () => ({ ...current }),
    set(patch) {
      const next: MetaSettingsValue = {
        providerId: patch.providerId ?? current.providerId,
        model: patch.model ?? current.model,
      };
      const changed =
        next.providerId !== current.providerId || next.model !== current.model;
      current = next;
      if (changed) {
        for (const listener of listeners) {
          listener({ ...current });
        }
      }
      return { ...current };
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

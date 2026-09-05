/** Read-side contracts for the AI model catalog offered to metasessions. */

/**
 * One selectable model as advertised by the Agency/Copilot CLI over ACP
 * (`session/new` → `models.availableModels`). Carries the CLI's own pricing
 * hints so the IDE can show what a model costs before it is picked:
 *
 * - `usageMultiplier` / `usageLabel`: the premium-request multiplier the CLI
 *   applies (`"15x"` → `15`). `null` when the CLI omits it (e.g. `auto`).
 * - `priceCategory`: the CLI's coarse cost bucket (`low` / `medium` / `high`).
 * - `enabled`: whether the account may actually use the model.
 */
export interface MetaModelOption {
  /** Model id used when launching a session (e.g. `gpt-5.4`). */
  id: string;
  /** Human-friendly display name (e.g. `GPT-5.4`). */
  name: string;
  /** Longer description, when the CLI supplies one. */
  description: string;
  /** Premium-request multiplier as a number (`"15x"` → `15`), else `null`. */
  usageMultiplier: number | null;
  /** Raw multiplier label as reported by the CLI (`"15x"`), else `null`. */
  usageLabel: string | null;
  /** Coarse price bucket (`low` / `medium` / `high`), when reported. */
  priceCategory: string | null;
  /** Whether the account may use this model. */
  enabled: boolean;
}

/**
 * Port that yields the model catalog. The real implementation drives a
 * short-lived `copilot --acp` session (see acp-model-catalog-probe.ts); the
 * parser and service depend only on this port so they stay fully unit-testable.
 * Resolves to `null` when the catalog could not be fetched (CLI unavailable or
 * timed out) so the service can retain any prior snapshot.
 */
export interface ModelCatalogProbe {
  fetch(): Promise<MetaModelOption[] | null>;
}

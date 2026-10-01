/**
 * Pure selection of the default AI provider. The IDE registers every enabled
 * provider; this decides which one is the *default* for new sessions, driven by
 * the network environment, which providers are installed, and an optional
 * user-persisted override. Provider-agnostic: unknown/future provider ids fall
 * through to the first enabled provider.
 */

/** Canonical provider ids whose default ordering depends on the network. */
export const COPILOT_PROVIDER_ID = 'copilot';
export const AGENCY_PROVIDER_ID = 'agency';

export interface DefaultProviderInput {
  /** True when running on the Microsoft corporate network. */
  microsoftNetwork: boolean;
  /** Enabled provider ids, in registration order. Must be non-empty. */
  enabled: string[];
  /** Provider ids whose CLI is currently installed/available. */
  installed: ReadonlySet<string>;
  /** User's explicitly chosen default provider id, if any. */
  override?: string | null;
}

/**
 * Picks the default provider id. Precedence:
 *  1. A user override, when it names an enabled provider.
 *  2. The network-preferred provider that is both enabled *and* installed.
 *  3. The network-preferred provider that is enabled (even if not yet installed,
 *     so the first-run gate can install it).
 *  4. The first enabled provider (covers providers outside the known pair).
 *
 * Network preference: Microsoft network prefers Agency then Copilot; otherwise
 * Copilot then Agency.
 */
export function selectDefaultProvider(input: DefaultProviderInput): string {
  const { microsoftNetwork, enabled, installed, override } = input;
  if (enabled.length === 0) {
    throw new Error('selectDefaultProvider requires at least one enabled provider');
  }
  if (override && enabled.includes(override)) {
    return override;
  }
  const preference = microsoftNetwork
    ? [AGENCY_PROVIDER_ID, COPILOT_PROVIDER_ID]
    : [COPILOT_PROVIDER_ID, AGENCY_PROVIDER_ID];

  for (const id of preference) {
    if (enabled.includes(id) && installed.has(id)) {
      return id;
    }
  }
  for (const id of preference) {
    if (enabled.includes(id)) {
      return id;
    }
  }
  return enabled[0];
}

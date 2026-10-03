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

/**
 * Provider ids that require a Microsoft identity to be exposed at all. Agency
 * is an internal Microsoft tool, so it must leave no trace for users who are
 * not signed in with a Microsoft identity (Azure DevOps). Copilot and any
 * other provider are always exposed.
 */
export const MICROSOFT_ONLY_PROVIDER_IDS: ReadonlySet<string> = new Set([
  AGENCY_PROVIDER_ID,
]);

/**
 * Whether a provider may be shown/used given the current Microsoft-identity
 * state. Microsoft-only providers (Agency) are exposed only when signed in.
 */
export function isProviderExposed(id: string, microsoftSignedIn: boolean): boolean {
  return microsoftSignedIn || !MICROSOFT_ONLY_PROVIDER_IDS.has(id);
}

export interface DefaultProviderInput {
  /** True when running on the Microsoft corporate network. */
  microsoftNetwork: boolean;
  /** Enabled provider ids, in registration order. Must be non-empty. */
  enabled: string[];
  /** Provider ids whose CLI is currently installed/available. */
  installed: ReadonlySet<string>;
  /** User's explicitly chosen default provider id, if any. */
  override?: string | null;
  /**
   * True when signed in with a Microsoft identity (Azure DevOps). Gates whether
   * Microsoft-only providers (Agency) are eligible. Defaults to `true` so
   * callers that don't yet distinguish identity keep the pre-gating behaviour.
   */
  microsoftSignedIn?: boolean;
}

/**
 * Picks the default provider id. Precedence:
 *  1. A user override, when it names an enabled provider.
 *  2. The network-preferred provider that is both enabled *and* installed.
 *  3. The network-preferred provider that is enabled (even if not yet installed,
 *     so the first-run gate can install it).
 *  4. The first enabled provider (covers providers outside the known pair).
 *
 * Network preference: Microsoft's Agency is preferred when the user is signed
 * in with a Microsoft identity (so Agency is exposed) *or* the host is on the
 * Microsoft network; otherwise Copilot is preferred. Because Agency is only ever
 * exposed to a signed-in Microsoft identity, this means: whenever Agency is
 * available it becomes the default, and a signed-out user always gets Copilot.
 */
export function selectDefaultProvider(input: DefaultProviderInput): string {
  const { microsoftNetwork, enabled, installed, override, microsoftSignedIn = true } = input;
  if (enabled.length === 0) {
    throw new Error('selectDefaultProvider requires at least one enabled provider');
  }
  const exposed = enabled.filter((id) => isProviderExposed(id, microsoftSignedIn));
  if (exposed.length === 0) {
    throw new Error('selectDefaultProvider requires at least one exposed provider');
  }
  if (override && exposed.includes(override)) {
    return override;
  }
  const preferMicrosoft = microsoftNetwork || microsoftSignedIn;
  const preference = preferMicrosoft
    ? [AGENCY_PROVIDER_ID, COPILOT_PROVIDER_ID]
    : [COPILOT_PROVIDER_ID, AGENCY_PROVIDER_ID];

  for (const id of preference) {
    if (exposed.includes(id) && installed.has(id)) {
      return id;
    }
  }
  for (const id of preference) {
    if (exposed.includes(id)) {
      return id;
    }
  }
  return exposed[0];
}

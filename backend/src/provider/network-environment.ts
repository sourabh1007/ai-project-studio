/**
 * Pure heuristics for deciding whether the app is running on the Microsoft
 * corporate network. The result selects the *default* AI provider: Microsoft
 * network defaults to the Agency CLI, everything else defaults to the GitHub
 * Copilot CLI. All IO (the reachability probe) is injected so the decision
 * logic stays fully unit-testable.
 */

/** Env vars (any OS) that may carry an explicit operator override. */
export const MS_NETWORK_OVERRIDE_VARS = [
  'AI_STUDIO_MS_NETWORK',
  'CW_MS_NETWORK',
] as const;

/**
 * Reads an explicit operator override from the environment. Returns `true`/
 * `false` when set to a recognised truthy/falsy value, or `null` when no
 * override is present (so the heuristics decide).
 */
export function explicitNetworkOverride(
  env: Record<string, string | undefined>,
): boolean | null {
  for (const name of MS_NETWORK_OVERRIDE_VARS) {
    const raw = (env[name] ?? '').trim().toLowerCase();
    if (raw === '') {
      continue;
    }
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
      return true;
    }
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
      return false;
    }
  }
  return null;
}

/**
 * Domain/host env vars that betray a Microsoft corp-joined machine. On Windows
 * `USERDNSDOMAIN` is typically e.g. `REDMOND.CORP.MICROSOFT.COM`; `USERDOMAIN`
 * and `LOGONSERVER` carry similar hints. Matching is case-insensitive.
 */
const MS_DOMAIN_VARS = [
  'USERDNSDOMAIN',
  'USERDOMAIN',
  'LOGONSERVER',
  'USERDNSDOMAIN_FQDN',
] as const;

const MS_DOMAIN_PATTERN = /(?<![a-z0-9])(corp|redmond|microsoft|ntdev|fareast)(?![a-z0-9])/i;

/**
 * Env-only heuristic: true when a domain/host env var matches a known Microsoft
 * corp-network marker. Pure and side-effect free.
 */
export function envIndicatesMicrosoftNetwork(
  env: Record<string, string | undefined>,
): boolean {
  return MS_DOMAIN_VARS.some((name) => {
    const value = env[name];
    return typeof value === 'string' && MS_DOMAIN_PATTERN.test(value);
  });
}

/**
 * Combines all signals into the final Microsoft-network decision, honouring an
 * explicit override above everything, then the env heuristic, then the injected
 * endpoint-reachability probe result (`true` reachable, `false` unreachable,
 * `null` not probed / unknown).
 */
export function resolveMicrosoftNetwork(signals: {
  override: boolean | null;
  envMicrosoft: boolean;
  endpointReachable: boolean | null;
}): boolean {
  if (signals.override !== null) {
    return signals.override;
  }
  if (signals.envMicrosoft) {
    return true;
  }
  return signals.endpointReachable === true;
}

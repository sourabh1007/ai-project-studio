import type { ProviderInfo } from './types.js';

/**
 * Keeps only providers whose CLI is installed and enabled on this machine.
 *
 * This is the single source of truth for "which providers may a user pick",
 * so every selection/display surface (session dropdown, status bar, settings,
 * MCP) filters through here and stays consistent with backend install state.
 */
export function installedProviders(
  providers: readonly ProviderInfo[],
): ProviderInfo[] {
  return providers.filter((provider) => provider.installed);
}

/** Provider ids that are installed, as a set for quick membership checks. */
export function installedProviderIds(
  providers: readonly ProviderInfo[],
): Set<string> {
  return new Set(installedProviders(providers).map((provider) => provider.id));
}

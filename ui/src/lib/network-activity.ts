/**
 * Network Activity transparency catalog (Phase 1a).
 *
 * AI Project Studio's core value — Copilot, GitHub, Azure DevOps, MCP — is
 * inherently cloud-connected, so "offline-by-default" does not apply. Instead we
 * lead with *transparency*: a read-only, plain-language inventory of every
 * outbound integration the backend uses, what it is for, and what data leaves
 * the machine. This module is the single source of truth for that inventory —
 * pure data + pure helpers so it can be fully unit-tested and reused by both the
 * Settings surface today and a richer Network Activity Center (Phase 5c) later.
 *
 * The catalog is curated (not scraped from live traffic): it mirrors the actual
 * endpoints wired in the backend (github device-auth, azure-* REST listers,
 * the agency bootstrap, MCP servers) so it stays honest and reviewable.
 */

/** Broad classification of what an integration is used for. */
export type IntegrationCategory =
  | 'authentication'
  | 'source-control'
  | 'code-review'
  | 'ai'
  | 'tooling'
  | 'extension';

/** How sensitive the data that leaves the machine is, at a glance. */
export type DataSensitivity = 'none' | 'low' | 'high';

export interface NetworkIntegration {
  /** Stable identifier (used as a React key and for tests). */
  readonly id: string;
  /** Human-facing provider/service name. */
  readonly provider: string;
  /** What the integration is used for. */
  readonly category: IntegrationCategory;
  /** One-line, plain-language purpose. */
  readonly purpose: string;
  /** Plain-language description of the data that leaves the machine. */
  readonly dataShared: string;
  /** Relative sensitivity of {@link dataShared}. */
  readonly sensitivity: DataSensitivity;
  /** Representative endpoint host(s)/pattern(s) contacted. */
  readonly endpoints: readonly string[];
  /** Whether the call carries user credentials / a token. */
  readonly requiresAuth: boolean;
  /**
   * True when the concrete endpoints depend on user configuration (e.g. the org
   * in an Azure URL, or the servers a user adds), so the listed endpoints are
   * illustrative rather than exhaustive.
   */
  readonly configurable?: boolean;
}

/**
 * The curated inventory of outbound integrations. Kept in sync with the backend
 * network layer; every entry corresponds to code that actually makes requests.
 */
export const NETWORK_INTEGRATIONS: readonly NetworkIntegration[] = [
  {
    id: 'github-auth',
    provider: 'GitHub',
    category: 'authentication',
    purpose: 'Sign in with the GitHub device-authorization flow.',
    dataShared: 'A one-time device code; in return an access token is stored locally.',
    sensitivity: 'high',
    endpoints: ['github.com/login/device/code', 'github.com/login/oauth/access_token'],
    requiresAuth: false,
  },
  {
    id: 'github-repos',
    provider: 'GitHub',
    category: 'source-control',
    purpose: 'List repositories and clone/fetch code via the GitHub CLI and git.',
    dataShared: 'Your access token and repository metadata; code is fetched to disk.',
    sensitivity: 'high',
    endpoints: ['github.com', 'api.github.com'],
    requiresAuth: true,
  },
  {
    id: 'github-pr-review',
    provider: 'GitHub',
    category: 'code-review',
    purpose: 'List, comment on, approve, and review pull requests.',
    dataShared: 'PR metadata plus any review comments and approvals you submit.',
    sensitivity: 'high',
    endpoints: ['api.github.com'],
    requiresAuth: true,
  },
  {
    id: 'azure-devops',
    provider: 'Azure DevOps',
    category: 'source-control',
    purpose: 'List repositories and pull requests in configured Azure DevOps orgs.',
    dataShared: 'Your token, plus repository and pull-request metadata.',
    sensitivity: 'high',
    endpoints: ['dev.azure.com', 'vssps.dev.azure.com'],
    requiresAuth: true,
    configurable: true,
  },
  {
    id: 'azure-pr-review',
    provider: 'Azure DevOps',
    category: 'code-review',
    purpose: 'Add comments and approvals to Azure DevOps pull requests.',
    dataShared: 'PR metadata and any comments/approvals you submit.',
    sensitivity: 'high',
    endpoints: ['dev.azure.com'],
    requiresAuth: true,
    configurable: true,
  },
  {
    id: 'copilot',
    provider: 'GitHub Copilot',
    category: 'ai',
    purpose: 'Run AI coding sessions through the Copilot CLI in terminals.',
    dataShared: 'Prompts and the code/context you share with the assistant.',
    sensitivity: 'high',
    endpoints: ['Copilot service (via the Copilot CLI)'],
    requiresAuth: true,
  },
  {
    id: 'agency-bootstrap',
    provider: 'Microsoft',
    category: 'tooling',
    purpose: 'One-time download of the agency CLI toolchain installer.',
    dataShared: 'Nothing sensitive — downloads a setup script.',
    sensitivity: 'none',
    endpoints: ['aka.ms/InstallTool.sh'],
    requiresAuth: false,
  },
  {
    id: 'mcp-servers',
    provider: 'MCP servers',
    category: 'extension',
    purpose: 'Context/tool servers (Model Context Protocol) you configure.',
    dataShared: 'Whatever each server requests — varies per server you add.',
    sensitivity: 'low',
    endpoints: ['User-configured endpoints'],
    requiresAuth: true,
    configurable: true,
  },
];

export interface ProviderGroup {
  readonly provider: string;
  readonly integrations: readonly NetworkIntegration[];
}

/**
 * Groups integrations by provider, preserving the first-seen order of both
 * providers and the integrations within each provider.
 */
export function groupIntegrationsByProvider(
  integrations: readonly NetworkIntegration[] = NETWORK_INTEGRATIONS,
): ProviderGroup[] {
  const groups: { provider: string; integrations: NetworkIntegration[] }[] = [];
  const byProvider = new Map<
    string,
    { provider: string; integrations: NetworkIntegration[] }
  >();
  for (const integration of integrations) {
    let group = byProvider.get(integration.provider);
    if (!group) {
      group = { provider: integration.provider, integrations: [] };
      byProvider.set(integration.provider, group);
      groups.push(group);
    }
    group.integrations.push(integration);
  }
  return groups;
}

export interface EgressSummary {
  /** Total number of catalogued integrations. */
  readonly total: number;
  /** How many transmit credentials/tokens. */
  readonly authenticated: number;
  /** How many send data classified as high sensitivity. */
  readonly highSensitivity: number;
  /** How many have endpoints that depend on user configuration. */
  readonly configurable: number;
}

/** Computes at-a-glance counts for a header/summary line. */
export function summarizeEgress(
  integrations: readonly NetworkIntegration[] = NETWORK_INTEGRATIONS,
): EgressSummary {
  let authenticated = 0;
  let highSensitivity = 0;
  let configurable = 0;
  for (const integration of integrations) {
    if (integration.requiresAuth) {
      authenticated += 1;
    }
    if (integration.sensitivity === 'high') {
      highSensitivity += 1;
    }
    if (integration.configurable) {
      configurable += 1;
    }
  }
  return {
    total: integrations.length,
    authenticated,
    highSensitivity,
    configurable,
  };
}

const CATEGORY_LABELS: Readonly<Record<IntegrationCategory, string>> = {
  authentication: 'Authentication',
  'source-control': 'Source control',
  'code-review': 'Code review',
  ai: 'AI',
  tooling: 'Tooling',
  extension: 'Extension',
};

/** Human-facing label for a category. */
export function categoryLabel(category: IntegrationCategory): string {
  return CATEGORY_LABELS[category];
}

const SENSITIVITY_LABELS: Readonly<Record<DataSensitivity, string>> = {
  none: 'No sensitive data',
  low: 'Low sensitivity',
  high: 'Sensitive data',
};

/** Human-facing label for a data-sensitivity level. */
export function sensitivityLabel(sensitivity: DataSensitivity): string {
  return SENSITIVITY_LABELS[sensitivity];
}

/** Canonical display order of categories, used to render stable filter chips. */
export const CATEGORY_ORDER: readonly IntegrationCategory[] = [
  'authentication',
  'source-control',
  'code-review',
  'ai',
  'tooling',
  'extension',
];

/** Canonical display order of sensitivity levels (most sensitive first). */
export const SENSITIVITY_ORDER: readonly DataSensitivity[] = [
  'high',
  'low',
  'none',
];

/** Active filters for the Network Activity Center (Phase 5c). */
export interface NetworkActivityFilter {
  /** Free-text query matched against provider, purpose, data, and endpoints. */
  readonly query?: string;
  /** Restrict to one category, or `'all'`/undefined for every category. */
  readonly category?: IntegrationCategory | 'all';
  /** Restrict to one sensitivity level, or `'all'`/undefined for every level. */
  readonly sensitivity?: DataSensitivity | 'all';
  /** When true, keep only integrations that transmit credentials. */
  readonly authOnly?: boolean;
}

/** Whether an integration matches a lower-cased free-text query. */
function matchesQuery(integration: NetworkIntegration, query: string): boolean {
  if (integration.provider.toLowerCase().includes(query)) {
    return true;
  }
  if (integration.purpose.toLowerCase().includes(query)) {
    return true;
  }
  if (integration.dataShared.toLowerCase().includes(query)) {
    return true;
  }
  return integration.endpoints.some((endpoint) =>
    endpoint.toLowerCase().includes(query),
  );
}

/**
 * Applies the Network Activity Center filters to an integration list, preserving
 * order. Pure so the interactive center stays fully unit-testable. An empty
 * filter (no query, `'all'` selectors, no `authOnly`) returns the list unchanged.
 */
export function filterIntegrations(
  integrations: readonly NetworkIntegration[] = NETWORK_INTEGRATIONS,
  filter: NetworkActivityFilter = {},
): NetworkIntegration[] {
  const query = filter.query?.trim().toLowerCase() ?? '';
  return integrations.filter((integration) => {
    if (
      filter.category &&
      filter.category !== 'all' &&
      integration.category !== filter.category
    ) {
      return false;
    }
    if (
      filter.sensitivity &&
      filter.sensitivity !== 'all' &&
      integration.sensitivity !== filter.sensitivity
    ) {
      return false;
    }
    if (filter.authOnly && !integration.requiresAuth) {
      return false;
    }
    if (query && !matchesQuery(integration, query)) {
      return false;
    }
    return true;
  });
}

/** The categories actually present in a list, in canonical display order. */
export function listCategories(
  integrations: readonly NetworkIntegration[] = NETWORK_INTEGRATIONS,
): IntegrationCategory[] {
  const present = new Set(integrations.map((i) => i.category));
  return CATEGORY_ORDER.filter((category) => present.has(category));
}

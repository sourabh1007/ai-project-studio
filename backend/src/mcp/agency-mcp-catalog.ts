import type { AgencyMcpConfigRunner } from './agency-mcp-config-store.js';
import type { McpCapabilities, McpOperation, McpServerEntry } from './mcp-contract.js';

export interface AgencyPublicMcp {
  name: string;
  description: string;
  instruction: string;
}

export interface AgencyMcpCatalog {
  servers: McpServerEntry[];
  notices: string[];
}

/**
 * Public catalog allow-list verified against docs/agency/Tools/MCP/mcp.md,
 * "Available Built-in MCPs". Never derive public visibility from installed help.
 */
export const AGENCY_PUBLIC_MCPS: readonly AgencyPublicMcp[] = [
  ['ado', 'Azure DevOps'],
  ['finish-pr', 'Drive an Azure DevOps pull request to completion'],
  ['bluebird', 'Engineering Copilot'],
  ['es-chat', 'ES Chat'],
  ['engage', 'Engage'],
  ['msft-learn', 'Microsoft Learn'],
  ['s360-breeze', 'S360 Breeze'],
  ['change-ledger', 'Azure change tracking'],
  ['safefly', 'Azure deployment safety'],
  ['perf-pas', 'Cross-Microsoft performance analysis'],
  ['domain-lens', 'Microsoft domain and OCDI status'],
  ['service-tree', 'ServiceTree'],
  ['icm', 'Incident Manager'],
  ['watson', 'Watson'],
  ['fluent', 'Fluent'],
  ['security-context', 'Microsoft Security Context'],
  ['dvdr', 'Dynamic Vulnerability Detection and Remediation'],
  ['ecs', 'Experimentation and Configuration Service'],
  ['top', 'Teams Ops Plane incident investigation'],
  ['smart-dri', 'DRI productivity'],
  ['atlas', 'Microsoft enterprise Atlas'],
  ['graph', 'Microsoft enterprise Graph'],
  ['powerbi', 'Semantic models and permission-scoped DAX'],
  ['kusto', 'Azure Kusto'],
  ['workiq', 'M365 Copilot integration'],
  ['teams', 'Microsoft Teams'],
  ['sharepoint', 'Microsoft SharePoint'],
  ['onedrive', 'Microsoft OneDrive'],
  ['mail', 'Microsoft Mail'],
  ['calendar', 'Microsoft Calendar'],
  ['cloudbuild', 'CloudBuild'],
  ['word', 'Microsoft Word'],
  ['planner', 'Microsoft Planner'],
  ['m365-user', 'Microsoft Graph user, manager, team and direct reports'],
  ['m365-copilot', 'M365 content search'],
  ['enghub', 'EngineeringHub documentation, troubleshooting guides and ServiceTree'],
  ['logger', 'Custom App Insights events and scoped session logs'],
  ['mrc', 'M365 Roadmap and Azure Updates'],
].map(([name, description]) => ({
  name,
  description,
  instruction: `Configure in your terminal with: agency config set --global --mcp ${name}. ` +
    'Some built-ins require parameters; consult agency config set --help and the built-in documentation before running it. ' +
    'For example: agency config set --global --mcp "ado --organization myorg". ' +
    'This manager has not run setup or authentication.',
}));

/** Only the narrowly documented config-set help section is an inventory source. */
export function parseAgencyAvailableMcps(help: string): string[] | null {
  const lines = help.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'Available MCPs:');
  if (start < 0) return null;
  const headingIndent = lines[start].length - lines[start].trimStart().length;
  const names = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) break;
    const indent = line.length - line.trimStart().length;
    if (indent <= headingIndent) break;
    if (!/^[a-z][a-z0-9_-]*$/.test(line.trim())) return null;
    names.add(line.trim());
  }
  return names.size ? [...names] : null;
}

/** Installed help intersected with an independently verified PUBLIC documentation allow-list. */
export function createAgencyMcpCatalog(
  runner: AgencyMcpConfigRunner,
  publicMcps: readonly AgencyPublicMcp[],
): () => Promise<AgencyMcpCatalog> {
  let active: Promise<AgencyMcpCatalog> | undefined;
  const load = async (): Promise<AgencyMcpCatalog> => {
    try {
      const response = await runner.run(['config', 'set', '--help']);
      if (response.code !== 0) return {
        servers: [], notices: ['Installed Agency catalog help is unavailable. No available-server entries were inferred.'],
      };
      const installed = parseAgencyAvailableMcps(response.stdout);
      if (installed === null) return {
        servers: [], notices: ['Installed Agency help did not contain a recognized Available MCPs section. No catalog entries were guessed.'],
      };
      const names = new Set(installed);
      const servers = publicMcps.filter((entry) => names.has(entry.name)).map((entry): McpServerEntry => {
        const operations: McpOperation[] = ['add', 'edit', 'remove', 'toggle', 'tools', 'toolToggle', 'restart'];
        const reason = `Available built-in, not configured or connected. ${entry.instruction}`;
        return {
          name: `catalog:${entry.name}`, displayName: entry.name, description: entry.description,
          source: 'Installed Agency MCP catalog', scope: 'Available built-in',
          catalog: true, providerLabel: 'Agency', origin: 'agency-built-in', builtinName: entry.name,
          spec: { type: 'agency-builtin', description: entry.description, nativeConfiguration: entry.instruction },
          capabilities: Object.fromEntries(operations.map((operation) => [
            operation, { supported: false, reason },
          ])) as McpCapabilities,
          toolDiscovery: { status: 'skipped', message: reason, output: [] },
        };
      });
      return {
        servers,
        notices: ['Available built-ins are the intersection of installed Agency help and the public documented catalog. Availability does not mean configured, authenticated, enabled, or connected.'],
      };
    } catch {
      return { servers: [], notices: ['Installed Agency catalog could not be read within its bounded command execution. No catalog entries were inferred.'] };
    }
  };
  return () => {
    if (!active) active = load().finally(() => { active = undefined; });
    return active;
  };
}

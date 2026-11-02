import { describe, expect, it } from 'vitest';
import { commandCatalog, internalCommands, mcpCommands, providerCommands, repositoryCommands, type CommandCatalogEntry } from './command-catalog.js';
import { createCommandCatalogRoutes } from '../api/command-catalog-controller.js';
import type { HttpRequest } from '../api/http-contract.js';
import { copilotDefaults } from '../provider/copilot-adapter/config.js';
import { agencyDefaults } from '../provider/agency-adapter/config.js';
import { claudeDefaults } from '../provider/claude-adapter/config.js';
import { metaDefaults } from '../meta/config.js';
import { planUsageDefaults } from '../plan-usage/config.js';
import { agencyBootstrapDefaults } from '../agency-bootstrap/config.js';
import { copilotBootstrapDefaults } from '../copilot-bootstrap/config.js';
import { selfHealDefaults } from '../self-heal/config.js';
import { mcpDefaults } from '../mcp/config.js';
import { gitDefaults } from '../git/config.js';
import { githubCliDefaults } from '../github-auth/config.js';
import { desktopRuntimeDefaults } from '../desktop-runtime/config.js';

describe('safe command catalog', () => {
  it('returns metadata only and filters unavailable module owners without executing anything', async () => {
    const entry: CommandCatalogEntry = {
      id: 'mcp', label: 'MCP', category: 'mcp', description: 'Native owner',
      required: ['protocol'], sources: ['inspector.inspect'], owner: 'native', settingsLink: 'mcp',
      config: { namespace: 'mcp', keys: ['timeout'] },
    };
    const entries = [{ ...entry, env: { TOKEN: 'secret' }, spec: { command: 'secret' }, current: 'secret' }, {
      ...entry, id: 'hidden', config: { namespace: 'agency', keys: [] },
    }, { id: 'internal', label: 'Internal', category: 'internal' as const, description: 'Read only', required: [], sources: [] }];
    const result = commandCatalog(entries, (namespace) => namespace !== 'agency');
    expect(result).toEqual([entry, entries[2]]);
    expect(JSON.stringify(result)).not.toContain('secret');
    const routes = createCommandCatalogRoutes({ entries, exposed: () => true });
    const response = await routes[0].handler({} as HttpRequest);
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(3);
    expect(result[0].required).not.toBe(entry.required);
  });

  it('inventories provider, repository, installers and explicit internal/user-owned exclusions without duplicate IDs or login editors', () => {
    const entries = [...providerCommands, ...repositoryCommands, ...mcpCommands, ...internalCommands];
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.sources.length).toBeGreaterThan(0);
      expect(entry.required.length).toBeGreaterThan(0);
    }
    expect(entries.flatMap((entry) => entry.config?.keys ?? [])).not.toContain('commandProfile.loginCommand');
    const sources = entries.flatMap((entry) => entry.sources).join('\n');
    for (const name of ['buildCopilotArgs', 'buildAgencyCommand', 'buildClaudeArgs', 'spawnLive', 'readAgencyVersion',
      'gitRun', 'createGitBranchReader', 'listTrackedFiles', 'lastCommitAuthor', 'PR diff executor', 'ghRun', 'ghLogin',
      'createGithubPr', 'createProcessSampler', 'extractArchive', 'killProcessTree', 'spawnClaudeHistoryWorker',
      'runSilentInstall', 'runShell']) expect(sources).toContain(name);
    expect(commandCatalog(entries, () => false).every((entry) => !entry.config)).toBe(true);
  });

  it('references real module-owned settings rather than introducing a duplicate value store', () => {
    const defaults: Record<string, unknown> = {
      copilot: copilotDefaults, agency: agencyDefaults, claude: claudeDefaults, meta: metaDefaults,
      planUsage: planUsageDefaults, agencyBootstrap: agencyBootstrapDefaults, copilotBootstrap: copilotBootstrapDefaults,
      selfHeal: selfHealDefaults, mcp: mcpDefaults, git: gitDefaults, githubCli: githubCliDefaults,
      desktopRuntime: desktopRuntimeDefaults,
    };
    for (const entry of [...providerCommands, ...repositoryCommands, ...mcpCommands, ...internalCommands]) {
      if (!entry.config) continue;
      for (const key of entry.config.keys) {
        let value = defaults[entry.config.namespace];
        for (const part of key.split('.')) value = (value as Record<string, unknown>)[part];
        expect(value, `${entry.id}: ${entry.config.namespace}.${key}`).not.toBeUndefined();
      }
    }
  });

  it('exposes MCP reload configuration only for Agency, which actually consumes it', () => {
    const copilot = providerCommands.find((entry) => entry.id === 'copilot')!;
    const agency = providerCommands.find((entry) => entry.id === 'agency')!;
    expect(copilot.config?.keys).not.toContain('commandProfile.liveReloadCommand');
    expect(copilot.sources.join('\n')).not.toContain('liveReload');
    expect(copilot.sources.join('\n')).toContain('configuration-path lookup only');
    expect(agency.config?.keys).toContain('commandProfile.liveReloadCommand');
    expect(agency.sources.join('\n')).toContain('mcp/mcp-service.ts: liveReload');
  });
});

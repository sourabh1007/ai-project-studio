import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, type FetchLike } from './api.js';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function mockFetch(response: Response): { fetchImpl: FetchLike; calls: Array<[string, RequestInit | undefined]> } {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push([input, init]);
    return response;
  };
  return { fetchImpl, calls };
}

describe('createApiClient', () => {
  it('lists features against the default base url', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([{ id: 'f1' }]));
    const client = createApiClient({ fetchImpl });
    const result = await client.listFeatures();
    expect(result).toEqual([{ id: 'f1' }]);
    expect(calls[0][0]).toBe('/api/features');
  });

  it('checks backend health via GET /health', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ status: 'ok', uptimeMs: 1234 }),
    );
    const client = createApiClient({ fetchImpl });
    const result = await client.checkHealth();
    expect(result).toEqual({ status: 'ok', uptimeMs: 1234 });
    expect(calls[0][0]).toBe('/api/health');
  });

  it('honours a custom base url', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'f1' }));
    const client = createApiClient({ baseUrl: 'http://host/api', fetchImpl });
    await client.getFeature('f1');
    expect(calls[0][0]).toBe('http://host/api/features/f1');
  });

  it('creates a feature with a JSON POST body', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'f1' }));
    const client = createApiClient({ fetchImpl });
    await client.createFeature({ name: 'n', description: 'd' });
    const [url, init] = calls[0];
    expect(url).toBe('/api/features');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify({ name: 'n', description: 'd' }));
  });

  it('renames a feature with a JSON PUT body', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'f1', name: 'x' }));
    const client = createApiClient({ fetchImpl });
    await client.renameFeature('f1', 'x');
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1');
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify({ name: 'x' }));
  });

  it('deletes a feature with a DELETE request', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'f1' }));
    const client = createApiClient({ fetchImpl });
    const result = await client.deleteFeature('f1');
    expect(result).toEqual({ id: 'f1' });
    expect(calls[0][0]).toBe('/api/features/f1');
    expect(calls[0][1]?.method).toBe('DELETE');
  });

  it('moves a feature with a JSON POST body', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'f1' }));
    const client = createApiClient({ fetchImpl });
    await client.moveFeature({ id: 'f1', targetRepoId: 'r2', targetIndex: 2 });
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1/move');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(
      JSON.stringify({ targetRepoId: 'r2', targetIndex: 2, targetParentFeatureId: null }),
    );
  });

  it('deletes a session with a DELETE request', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 's1' }));
    const client = createApiClient({ fetchImpl });
    const result = await client.deleteSession('s1');
    expect(result).toEqual({ id: 's1' });
    expect(calls[0][0]).toBe('/api/sessions/s1');
    expect(calls[0][1]?.method).toBe('DELETE');
  });

  it('gets repository insights', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ repositoryId: 'r1', agentReady: true }),
    );
    const client = createApiClient({ fetchImpl });
    await client.getRepoInsights('r1');
    expect(calls[0][0]).toBe('/api/repos/r1/insights');
    expect(calls[0][1]).toBeUndefined();
    await client.getRepoInsights('r1', true);
    expect(calls[1][0]).toBe('/api/repos/r1/insights?refresh=true');
  });

  it('gets a repository definition file', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ path: 'docs/tsg/a b.md', branch: 'main', content: '# hi' }),
    );
    const client = createApiClient({ fetchImpl });
    await client.getRepoDefinition('r1', 'docs/tsg/a b.md');
    expect(calls[0][0]).toBe(
      '/api/repos/r1/insights/file?path=docs%2Ftsg%2Fa%20b.md',
    );
    expect(calls[0][1]).toBeUndefined();
  });

  it('reads and refreshes repository context', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ repositoryId: 'r1', status: 'ready' }),
    );
    const client = createApiClient({ fetchImpl });
    await client.getRepositoryContext('r1');
    await client.refreshRepositoryContext('r1');
    expect(calls[0][0]).toBe('/api/repos/r1/context');
    expect(calls[0][1]).toBeUndefined();
    expect(calls[1][0]).toBe('/api/repos/r1/context/refresh');
    expect(calls[1][1]?.method).toBe('POST');
    expect(calls[1][1]?.body).toBe(JSON.stringify({}));
  });

  it('renames a session with a JSON PUT body', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 's1', name: 'x' }));
    const client = createApiClient({ fetchImpl });
    await client.renameSession('s1', 'x');
    const [url, init] = calls[0];
    expect(url).toBe('/api/sessions/s1');
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify({ name: 'x' }));
  });

  it('lists sessions for a feature', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([]));
    const client = createApiClient({ fetchImpl });
    await client.listSessions('f1');
    expect(calls[0][0]).toBe('/api/features/f1/sessions');
  });

  it('can include internal sessions for analytics labels', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([]));
    const client = createApiClient({ fetchImpl });
    await client.listSessions('f1', { includeInternal: true });
    expect(calls[0][0]).toBe(
      '/api/features/f1/sessions?includeInternal=true',
    );
  });

  it('lists a feature tree groups', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([]));
    const client = createApiClient({ fetchImpl });
    await client.listGroups('f1');
    expect(calls[0][0]).toBe('/api/features/f1/groups');
  });

  it('creates a group with a JSON POST body', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'g1' }));
    const client = createApiClient({ fetchImpl });
    await client.createGroup('f1', { kind: 'subcategory', name: 'Docs' });
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1/groups');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(
      JSON.stringify({ kind: 'subcategory', name: 'Docs' }),
    );
  });

  it('renames a group with a JSON PUT body', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'g1' }));
    const client = createApiClient({ fetchImpl });
    await client.renameGroup('g1', 'Renamed');
    const [url, init] = calls[0];
    expect(url).toBe('/api/groups/g1');
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(JSON.stringify({ name: 'Renamed' }));
  });

  it('deletes a group with a DELETE request', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'g1' }));
    const client = createApiClient({ fetchImpl });
    const result = await client.deleteGroup('g1');
    expect(result).toEqual({ id: 'g1' });
    expect(calls[0][0]).toBe('/api/groups/g1');
    expect(calls[0][1]?.method).toBe('DELETE');
  });

  it('moves a tree node with a JSON POST body', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ moved: true }));
    const client = createApiClient({ fetchImpl });
    const input = {
      type: 'session' as const,
      id: 's1',
      targetFeatureId: 'f1',
      targetParentGroupId: null,
      targetIndex: 0,
    };
    const result = await client.moveNode(input);
    expect(result).toEqual({ moved: true });
    expect(calls[0][0]).toBe('/api/tree/move');
    expect(calls[0][1]?.method).toBe('POST');
    expect(calls[0][1]?.body).toBe(JSON.stringify(input));
  });

  it('starts a session', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 's1' }));
    const client = createApiClient({ fetchImpl });
    await client.startSession('f1', { prompt: 'hi' });
    expect(calls[0][0]).toBe('/api/features/f1/sessions');
    expect(calls[0][1]?.method).toBe('POST');
  });

  it('creates an interactive terminal session', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 's1' }));
    const client = createApiClient({ fetchImpl });
    await client.createTerminalSession('f1', { model: 'gpt-5.4' });
    expect(calls[0][0]).toBe('/api/features/f1/terminal-sessions');
    expect(calls[0][1]?.method).toBe('POST');
    expect(calls[0][1]?.body).toBe(JSON.stringify({ model: 'gpt-5.4' }));
  });

  it('reads feature usage', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({}));
    const client = createApiClient({ fetchImpl });
    await client.getFeatureUsage('f1');
    expect(calls[0][0]).toBe('/api/features/f1/usage');
  });

  it('reads per-turn session usage events', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([]));
    const client = createApiClient({ fetchImpl });
    await client.getSessionUsageEvents('s1');
    expect(calls[0][0]).toBe('/api/sessions/s1/usage');
  });

  it('reads per-turn feature usage events', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([]));
    const client = createApiClient({ fetchImpl });
    await client.getFeatureUsageEvents('f1');
    expect(calls[0][0]).toBe('/api/features/f1/usage/events');
  });

  it('reads per-turn repository usage events', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([]));
    const client = createApiClient({ fetchImpl });
    await client.getRepoUsageEvents('r1');
    expect(calls[0][0]).toBe('/api/repos/r1/usage/events');
  });

  it('reads workspace totals', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({}));
    const client = createApiClient({ fetchImpl });
    await client.getWorkspaceTotals();
    expect(calls[0][0]).toBe('/api/usage/totals');
  });

  it('reads workspace stats', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({}));
    const client = createApiClient({ fetchImpl });
    await client.getWorkspaceStats();
    expect(calls[0][0]).toBe('/api/usage/workspace');
  });

  it('generates and reads a summary', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({}));
    const client = createApiClient({ fetchImpl });
    await client.generateSummary('f1');
    await client.getSummary('f1');
    expect(calls[0][0]).toBe('/api/features/f1/summary');
    expect(calls[0][1]?.method).toBe('POST');
    expect(calls[1][0]).toBe('/api/features/f1/summary');
    expect(calls[1][1]).toBeUndefined();
  });

  it('reads the feature work summary', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ featureId: 'f1', sessions: [] }),
    );
    const client = createApiClient({ fetchImpl });
    await client.getFeatureWorkSummary('f1');
    expect(calls[0][0]).toBe('/api/features/f1/work-summary');
    expect(calls[0][1]).toBeUndefined();
  });

  it('lists providers and models', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([]));
    const client = createApiClient({ fetchImpl });
    await client.listProviders();
    await client.listModels('copilot');
    expect(calls[0][0]).toBe('/api/providers');
    expect(calls[1][0]).toBe('/api/providers/copilot/models');
  });

  it('lists MCP providers', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([{ id: 'agency' }]));
    const client = createApiClient({ fetchImpl });
    const result = await client.listMcpProviders();
    expect(result).toEqual([{ id: 'agency' }]);
    expect(calls[0][0]).toBe('/api/mcp/providers');
  });

  it('gets MCP servers for a provider, encoding the id', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({
        providerId: 'a/b',
        configPath: '/x',
        exists: true,
        servers: [],
      }),
    );
    const client = createApiClient({ fetchImpl });
    await client.getMcpServers('a/b');
    expect(calls[0][0]).toBe('/api/mcp/providers/a%2Fb/servers');
  });

  it('adds/updates an MCP server with a JSON PUT body', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({
        providerId: 'agency',
        configPath: '/x',
        exists: true,
        servers: [],
      }),
    );
    const client = createApiClient({ fetchImpl });
    await client.putMcpServer('agency', {
      name: 'fs',
      spec: { command: 'npx' },
    });
    const [url, init] = calls[0];
    expect(url).toBe('/api/mcp/providers/agency/servers');
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(
      JSON.stringify({ name: 'fs', spec: { command: 'npx' } }),
    );
  });

  it('toggles an MCP tool with a JSON PUT body and encoded path params', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({
        config: { providerId: 'a/b', configPath: '/x', exists: true, servers: [] },
        server: { name: 'Azure MCP', spec: {} },
        liveReloadedSessions: 1,
        liveReloadCommand: '/restart',
      }),
    );
    const client = createApiClient({ fetchImpl });
    await client.setMcpToolEnabled('a/b', 'Azure MCP', 'tool/read', false);
    const [url, init] = calls[0];
    expect(url).toBe(
      '/api/mcp/providers/a%2Fb/servers/Azure%20MCP/tools/tool%2Fread',
    );
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(JSON.stringify({ enabled: false }));
  });

  it('restarts an MCP server with a JSON POST body', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({
        config: { providerId: 'agency', configPath: '/x', exists: true, servers: [] },
        server: { name: 'Azure', spec: {} },
        liveReloadedSessions: 1,
        liveReloadCommand: '/restart',
      }),
    );
    const client = createApiClient({ fetchImpl });
    await client.restartMcpServer('agency', 'Azure');
    const [url, init] = calls[0];
    expect(url).toBe('/api/mcp/providers/agency/servers/Azure/restart');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({}));
  });

  it('reads the effective config', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ namespaces: [], defaults: {}, current: {}, overrides: {} }),
    );
    const client = createApiClient({ fetchImpl });
    await client.getConfig();
    expect(calls[0][0]).toBe('/api/config');
  });

  it('reads the warm metasession pool status', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ enabled: true, pools: [] }),
    );
    const client = createApiClient({ fetchImpl });
    await client.getMetaPools();
    expect(calls[0][0]).toBe('/api/meta/pools');
  });

  it('resizes a warm metasession pool with a JSON POST body', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ enabled: true, pools: [] }),
    );
    const client = createApiClient({ fetchImpl });
    await client.resizeMetaPool('general', 4);
    expect(calls[0][0]).toBe('/api/meta/pools/resize');
    expect(calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      purpose: 'general',
      size: 4,
    });
  });

  it('creates a warm metasession pool with a JSON POST body', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ enabled: true, pools: [] }),
    );
    const client = createApiClient({ fetchImpl });
    await client.createMetaPool('self-recovery', 2);
    expect(calls[0][0]).toBe('/api/meta/pools/create');
    expect(calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      purpose: 'self-recovery',
      size: 2,
    });
  });

  it('removes a warm metasession pool with a JSON POST body', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ enabled: true, pools: [] }),
    );
    const client = createApiClient({ fetchImpl });
    await client.removeMetaPool('self-recovery');
    expect(calls[0][0]).toBe('/api/meta/pools/remove');
    expect(calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      purpose: 'self-recovery',
    });
  });

  it('reads the runtime meta AI settings', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ providerId: 'agency', model: 'auto', warmPoolEnabled: true }),
    );
    const client = createApiClient({ fetchImpl });
    await client.getMetaSettings();
    expect(calls[0][0]).toBe('/api/meta/settings');
  });

  it('fetches the metasession model catalog', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([]));
    const client = createApiClient({ fetchImpl });
    await client.getMetaModels();
    expect(calls[0][0]).toBe('/api/meta/models');
  });

  it('asks the settings assistant with a JSON POST body', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ answer: 'ok' }));
    const client = createApiClient({ fetchImpl });
    await client.askSettingsAssistant({
      namespace: 'meta',
      key: 'model',
      question: 'Which model?',
    });
    expect(calls[0][0]).toBe('/api/config/assistant');
    expect(calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      namespace: 'meta',
      key: 'model',
      question: 'Which model?',
    });
  });

  it('updates the runtime meta AI settings with a JSON PUT body', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ providerId: 'copilot', model: 'gpt-5', warmPoolEnabled: true }),
    );
    const client = createApiClient({ fetchImpl });
    await client.updateMetaSettings({ providerId: 'copilot', model: 'gpt-5' });
    expect(calls[0][0]).toBe('/api/meta/settings');
    expect(calls[0][1]?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      providerId: 'copilot',
      model: 'gpt-5',
    });
  });

  it('updates a namespace override with a JSON PUT body', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({
        namespace: 'logging',
        effective: {},
        override: { level: 'debug' },
        requiresRestart: true,
      }),
    );
    const client = createApiClient({ fetchImpl });
    await client.updateConfig('logging', { level: 'debug' });
    const [url, init] = calls[0];
    expect(url).toBe('/api/config/logging');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({
      values: { level: 'debug' },
    });
  });

  it('resets a namespace override with a DELETE request', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({
        namespace: 'logging',
        effective: {},
        override: {},
        requiresRestart: true,
      }),
    );
    const client = createApiClient({ fetchImpl });
    await client.resetConfig('logging');
    expect(calls[0][0]).toBe('/api/config/logging');
    expect(calls[0][1]?.method).toBe('DELETE');
  });

  it('gets the agency install status', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ installed: true }));
    const client = createApiClient({ fetchImpl });
    const result = await client.getAgencyStatus();
    expect(result).toEqual({ installed: true });
    expect(calls[0][0]).toBe('/api/agency/status');
  });

  it('gets the GitHub auth status', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ authenticated: true, login: 'octocat' }),
    );
    const client = createApiClient({ fetchImpl });
    const result = await client.getGithubStatus();
    expect(result).toEqual({ authenticated: true, login: 'octocat' });
    expect(calls[0][0]).toBe('/api/github/status');
  });

  it('gets the Azure DevOps status with and without an org url', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ authenticated: true, account: 'alice' }),
    );
    const client = createApiClient({ fetchImpl });
    const result = await client.getAzureStatus('dev.azure.com/contoso');
    await client.getAzureStatus();
    expect(result).toEqual({ authenticated: true, account: 'alice' });
    expect(calls[0][0]).toBe(
      '/api/azure-devops/status?url=dev.azure.com%2Fcontoso',
    );
    expect(calls[1][0]).toBe('/api/azure-devops/status');
  });

  it('triggers an Azure DevOps interactive sign-in', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ authenticated: true, account: 'bob' }),
    );
    const client = createApiClient({ fetchImpl });
    await client.azureSignIn('contoso');
    await client.azureSignIn();
    expect(calls[0][0]).toBe('/api/azure-devops/signin');
    expect(calls[0][1]?.method).toBe('POST');
    expect(calls[0][1]?.body).toBe(JSON.stringify({ url: 'contoso' }));
    expect(calls[1][1]?.body).toBe(JSON.stringify({}));
  });

  it('triggers an Azure DevOps sign-out', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ authenticated: false, account: null, message: null }),
    );
    const client = createApiClient({ fetchImpl });
    await client.azureSignOut('contoso');
    await client.azureSignOut();
    expect(calls[0][0]).toBe('/api/azure-devops/signout');
    expect(calls[0][1]?.method).toBe('POST');
    expect(calls[0][1]?.body).toBe(JSON.stringify({ url: 'contoso' }));
    expect(calls[1][1]?.body).toBe(JSON.stringify({}));
  });

  it('lists importable sessions and imports one', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([]));
    const client = createApiClient({ fetchImpl });
    await client.listImportableSessions();
    await client.importSession('f1', { provider: 'agency', externalId: 's9' });
    expect(calls[0][0]).toBe('/api/importable-sessions');
    expect(calls[0][1]).toBeUndefined();
    expect(calls[1][0]).toBe('/api/features/f1/import-session');
    expect(calls[1][1]?.method).toBe('POST');
    expect(calls[1][1]?.body).toBe(
      JSON.stringify({ provider: 'agency', externalId: 's9' }),
    );
  });

  it('performs the full skills lifecycle over HTTP', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'k1' }));
    const client = createApiClient({ fetchImpl });

    await client.listSkills();
    await client.getSkill('k1');
    await client.createSkill({ name: 'A', kind: 'instruction', instructions: 'x' });
    await client.updateSkill('k1', { name: 'B', instructions: 'y' });
    await client.deleteSkill('k1');
    await client.tagSkill('k1', 'feature', 'f1');
    await client.untagSkill('a1');
    await client.listFeatureSkills('f1');
    await client.listSessionSkills('s1');
    await client.exportSkill('k1');
    await client.exportSkills();
    await client.importSkill({
      schemaVersion: 1,
      name: 'A',
      kind: 'instruction',
      instructions: 'x',
      removalInstructions: '',
      recommendedScope: 'feature',
    });

    expect(calls[0][0]).toBe('/api/skills');
    expect(calls[1][0]).toBe('/api/skills/k1');
    expect(calls[2][1]?.method).toBe('POST');
    expect(calls[3][0]).toBe('/api/skills/k1');
    expect(calls[3][1]?.method).toBe('PUT');
    expect(calls[4][1]?.method).toBe('DELETE');
    expect(calls[5][0]).toBe('/api/skills/k1/attachments');
    expect(calls[5][1]?.body).toBe(
      JSON.stringify({ scope: 'feature', targetId: 'f1' }),
    );
    expect(calls[6][0]).toBe('/api/skills/attachments/a1');
    expect(calls[6][1]?.method).toBe('DELETE');
    expect(calls[7][0]).toBe('/api/features/f1/skills');
    expect(calls[8][0]).toBe('/api/sessions/s1/skills');
    expect(calls[9][0]).toBe('/api/skills/k1/export');
    expect(calls[10][0]).toBe('/api/skills/export');
    expect(calls[11][0]).toBe('/api/skills/import');
    expect(calls[11][1]?.method).toBe('POST');
  });

  it('requests the files a session touched', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([]));
    const client = createApiClient({ fetchImpl });

    await client.listSessionFiles('s1');

    expect(calls[0][0]).toBe('/api/sessions/s1/files');
    expect(calls[0][1]?.method ?? 'GET').toBe('GET');
  });

  it('reads workspace shared context without a scopeId query', async () => {
    const doc = {
      scope: 'workspace',
      scopeId: '',
      content: '- rule',
      updatedAt: 't',
      updatedBy: 'manual',
    };
    const { fetchImpl, calls } = mockFetch(jsonResponse(doc));
    const client = createApiClient({ fetchImpl });

    const result = await client.getSharedContext('workspace', '');

    expect(result).toEqual(doc);
    expect(calls[0][0]).toBe('/api/context/workspace');
  });

  it('reads scoped shared context with an encoded scopeId query', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ scope: 'feature' }));
    const client = createApiClient({ fetchImpl });

    await client.getSharedContext('feature', 'f 1');

    expect(calls[0][0]).toBe('/api/context/feature?scopeId=f%201');
  });

  it('returns null when shared context is absent', async () => {
    const { fetchImpl } = mockFetch(jsonResponse({}, 404));
    const client = createApiClient({ fetchImpl });

    expect(await client.getSharedContext('repo', 'r1')).toBeNull();
  });

  it('propagates non-404 errors when reading shared context', async () => {
    const { fetchImpl } = mockFetch(jsonResponse({}, 500));
    const client = createApiClient({ fetchImpl });

    await expect(client.getSharedContext('repo', 'r1')).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('saves shared context with a JSON PUT body', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ scope: 'repo' }));
    const client = createApiClient({ fetchImpl });

    await client.saveSharedContext('repo', 'r1', 'new content');

    const [url, init] = calls[0];
    expect(url).toBe('/api/context/repo');
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(
      JSON.stringify({ scopeId: 'r1', content: 'new content' }),
    );
  });

  it('appends a shared-context fact with a JSON POST body', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ scope: 'feature' }));
    const client = createApiClient({ fetchImpl });

    await client.rememberSharedContext('feature', 'f1', 'be nice');

    const [url, init] = calls[0];
    expect(url).toBe('/api/context/feature/remember');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ scopeId: 'f1', text: 'be nice' }));
  });

  it('performs the full feature-tasks lifecycle over HTTP', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 't1' }));
    const client = createApiClient({ fetchImpl });

    await client.listFeatureTasks('f1');
    await client.generateFeatureTasks('f1');
    await client.addFeatureTask('f1', { title: 'New', detail: 'd' });
    await client.toggleFeatureTask('t1');
    await client.removeFeatureTask('t1');

    expect(calls[0][0]).toBe('/api/features/f1/tasks');
    expect(calls[1][0]).toBe('/api/features/f1/tasks/generate');
    expect(calls[1][1]?.method).toBe('POST');
    expect(calls[2][0]).toBe('/api/features/f1/tasks');
    expect(calls[2][1]?.method).toBe('POST');
    expect(calls[2][1]?.body).toBe(JSON.stringify({ title: 'New', detail: 'd' }));
    expect(calls[3][0]).toBe('/api/tasks/t1');
    expect(calls[3][1]?.method).toBe('PUT');
    expect(calls[4][0]).toBe('/api/tasks/t1');
    expect(calls[4][1]?.method).toBe('DELETE');
  });

  it('reads IDE AI usage', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ totals: {} }));
    const client = createApiClient({ fetchImpl });
    await client.getIdeUsage();
    expect(calls[0][0]).toBe('/api/usage/ide');
  });

  it('reads the plan AI-credit budget', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ usedAic: 25000 }));
    const client = createApiClient({ fetchImpl });
    await client.getPlanUsage();
    expect(calls[0][0]).toBe('/api/usage/plan');
  });

  it('throws ApiError on a non-ok response', async () => {
    const { fetchImpl } = mockFetch(jsonResponse({}, 500));
    const client = createApiClient({ fetchImpl });
    await expect(client.listFeatures()).rejects.toBeInstanceOf(ApiError);
  });

  it('carries the status code on ApiError', async () => {
    const { fetchImpl } = mockFetch(jsonResponse({}, 404));
    const client = createApiClient({ fetchImpl });
    await expect(client.getFeature('x')).rejects.toMatchObject({
      status: 404,
      name: 'ApiError',
    });
  });

  it('falls back to global fetch when no impl is provided', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse([{ id: 'f1' }]));
    const client = createApiClient();
    const result = await client.listFeatures();
    expect(result).toEqual([{ id: 'f1' }]);
    expect(spy).toHaveBeenCalledWith('/api/features', undefined);
    spy.mockRestore();
  });

  it('lists workspace repositories', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([{ id: 'r1' }]));
    const client = createApiClient({ fetchImpl });
    const result = await client.listRepos();
    expect(result).toEqual([{ id: 'r1' }]);
    expect(calls[0][0]).toBe('/api/repos');
  });

  it('adds a repository with a JSON POST body', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'r1' }));
    const client = createApiClient({ fetchImpl });
    const input = {
      provider: 'github' as const,
      remoteUrl: 'https://x/y.git',
      name: 'x/y',
      localPath: 'C:\\repos\\y',
      mode: 'clone' as const,
    };
    await client.addRepo(input);
    const [url, init] = calls[0];
    expect(url).toBe('/api/repos');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify(input));
  });

  it('deletes a repository with a DELETE request', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'r1' }));
    const client = createApiClient({ fetchImpl });
    const result = await client.deleteRepo('r1');
    expect(result).toEqual({ id: 'r1' });
    expect(calls[0][0]).toBe('/api/repos/r1');
    expect(calls[0][1]?.method).toBe('DELETE');
  });

  it('lists GitHub repositories to pick from', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([{ name: 'o/r' }]));
    const client = createApiClient({ fetchImpl });
    await client.listGithubRepos();
    expect(calls[0][0]).toBe('/api/providers/github/repos');
  });

  it('lists Azure DevOps repositories for an org, url-encoding it', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([{ name: 'p/r' }]));
    const client = createApiClient({ fetchImpl });
    await client.listAzureRepos('my org');
    expect(calls[0][0]).toBe('/api/providers/azure-devops/repos?org=my%20org');
  });

  it("lists a repository's open pull requests", async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([{ number: 7 }]));
    const client = createApiClient({ fetchImpl });
    const result = await client.listRepoPulls('r1');
    expect(result).toEqual([{ number: 7 }]);
    expect(calls[0][0]).toBe('/api/repos/r1/pulls?filter=all');
    expect(calls[0][1]?.method ?? 'GET').toBe('GET');
  });

  it('passes a filter through to the pull-request list endpoint', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([]));
    const client = createApiClient({ fetchImpl });
    await client.listRepoPulls('r1', 'mine');
    expect(calls[0][0]).toBe('/api/repos/r1/pulls?filter=mine');
  });

  it('creates a review feature from a pull request via a JSON POST', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'f1' }));
    const client = createApiClient({ fetchImpl });
    await client.createPrFeature('r1', 42);
    const [url, init] = calls[0];
    expect(url).toBe('/api/repos/r1/pulls');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(
      JSON.stringify({ number: 42, parentFeatureId: null }),
    );
  });

  it('nests a review feature under a parent feature when given one', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'f2' }));
    const client = createApiClient({ fetchImpl });
    await client.createPrFeature('r1', 42, 'parent-1');
    expect(calls[0][1]?.body).toBe(
      JSON.stringify({ number: 42, parentFeatureId: 'parent-1' }),
    );
  });

  it('reads a PR review for a feature', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ featureId: 'f1' }));
    const client = createApiClient({ fetchImpl });
    const result = await client.getPrReview('f1');
    expect(result).toEqual({ featureId: 'f1' });
    expect(calls[0][0]).toBe('/api/features/f1/pr-review');
    expect(calls[0][1]?.method ?? 'GET').toBe('GET');
  });

  it('reads a review board for a feature', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ featureId: 'f1' }));
    const client = createApiClient({ fetchImpl });
    const result = await client.getReviewBoard('f1');
    expect(result).toEqual({ featureId: 'f1' });
    expect(calls[0][0]).toBe('/api/features/f1/review-board');
    expect(calls[0][1]?.method ?? 'GET').toBe('GET');
  });

  it('analyzes a review board via a JSON POST', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ featureId: 'f1' }));
    const client = createApiClient({ fetchImpl });
    const result = await client.analyzeReviewBoard('f1');
    expect(result).toEqual({ featureId: 'f1' });
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1/review-board/analyze');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({}));
  });

  it('analyzes a single review perspective via a JSON POST', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({
        perspectiveId: 'security',
        perspective: { id: 'security' },
        skipped: false,
        skipReason: null,
        summary: null,
        rationale: [],
        checks: [],
      }),
    );
    const client = createApiClient({ fetchImpl });
    const result = await client.analyzeReviewBoardPerspective('f1', 'security');
    expect(result.perspectiveId).toBe('security');
    const [url, init] = calls[0];
    expect(url).toBe(
      '/api/features/f1/review-board/perspectives/security/analyze',
    );
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({}));
  });

  it('chats with the review agent via a JSON POST with perspective and messages', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ answer: 'Because.' }));
    const client = createApiClient({ fetchImpl });
    const messages = [{ role: 'user' as const, content: 'Why?' }];
    const reply = await client.chatReviewBoard('f1', 'security', messages);
    expect(reply).toEqual({ answer: 'Because.' });
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1/review-board/chat');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(
      JSON.stringify({ perspectiveId: 'security', messages, context: null }),
    );
  });

  it('forwards the analysed-perspective context to the chat endpoint', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ answer: 'Line 42.' }));
    const client = createApiClient({ fetchImpl });
    const messages = [{ role: 'user' as const, content: 'Where?' }];
    const context = { status: 'warning' as const, risk: 'high' as const, findings: [] };
    await client.chatReviewBoard('f1', 'security', messages, context);
    const [, init] = calls[0];
    expect(init?.body).toBe(
      JSON.stringify({ perspectiveId: 'security', messages, context }),
    );
  });

  it('refreshes a PR review via a JSON POST', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ featureId: 'f1' }));
    const client = createApiClient({ fetchImpl });
    await client.refreshPrReview('f1');
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1/pr-review/refresh');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({}));
  });

  it('takes the latest for a PR review via a JSON POST', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ featureId: 'f1' }));
    const client = createApiClient({ fetchImpl });
    await client.pullLatestPrReview('f1');
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1/pr-review/pull-latest');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({}));
  });

  it('retries a single PR review step via a JSON POST', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ featureId: 'f1' }));
    const client = createApiClient({ fetchImpl });
    await client.retryPrReviewStep('f1', 'changeGraph');
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1/pr-review/steps/changeGraph/retry');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({}));
  });

  it('explains a PR review file via a JSON POST with the path', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ featureId: 'f1' }));
    const client = createApiClient({ fetchImpl });
    await client.explainPrReviewFile('f1', 'src/a.ts');
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1/pr-review/files/explain');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ path: 'src/a.ts' }));
  });

  it('gets a PR review file content via a GET with the encoded path', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ path: 'src/a b.ts', content: 'line1\nline2' }),
    );
    const client = createApiClient({ fetchImpl });
    const res = await client.getPrReviewFileContent('f1', 'src/a b.ts');
    expect(res).toEqual({ path: 'src/a b.ts', content: 'line1\nline2' });
    const [url, init] = calls[0];
    expect(url).toBe(
      '/api/features/f1/pr-review/files/content?path=src%2Fa%20b.ts',
    );
    expect(init?.method).toBeUndefined();
  });

  it('chats about a change graph via a JSON POST with category and messages', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ answer: 'Two files.' }));
    const client = createApiClient({ fetchImpl });
    const messages = [{ role: 'user' as const, content: 'What changed?' }];
    const reply = await client.chatPrReviewGraph('f1', 'code', messages);
    expect(reply).toEqual({ answer: 'Two files.' });
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1/pr-review/graph-chat');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ category: 'code', messages }));
  });

  it('lists PR review comments for a feature', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse([]));
    const client = createApiClient({ fetchImpl });
    const threads = await client.listPrReviewComments('f1');
    expect(threads).toEqual([]);
    expect(calls[0][0]).toBe('/api/features/f1/pr-review/comments');
    expect(calls[0][1]?.method ?? 'GET').toBe('GET');
  });

  it('adds a PR review comment via a JSON POST', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 't1' }));
    const client = createApiClient({ fetchImpl });
    await client.addPrReviewComment('f1', {
      path: 'src/a.ts',
      line: 4,
      body: 'nit',
    });
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1/pr-review/comments');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(
      JSON.stringify({ path: 'src/a.ts', line: 4, body: 'nit' }),
    );
  });

  it('sets a PR review comment status via a JSON POST', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 't1' }));
    const client = createApiClient({ fetchImpl });
    await client.setPrReviewCommentStatus('f1', 't1', 'resolved');
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1/pr-review/comments/t1/status');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ status: 'resolved' }));
  });

  it('approves a PR review via a JSON POST', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ approved: true, state: 'approved' }),
    );
    const client = createApiClient({ fetchImpl });
    const result = await client.approvePrReview('f1');
    expect(result).toEqual({ approved: true, state: 'approved' });
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1/pr-review/approve');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({}));
  });

  it('exports a PR review into the description via a JSON POST', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ updated: true, url: 'https://example/pr/7' }),
    );
    const client = createApiClient({ fetchImpl });
    const result = await client.exportPrReviewDescription('f1');
    expect(result).toEqual({ updated: true, url: 'https://example/pr/7' });
    const [url, init] = calls[0];
    expect(url).toBe('/api/features/f1/pr-review/export-description');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({}));
  });

  it('lists managed worktrees via GET', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse([
        { path: '/w/app-pr-7', branch: 'pr-7', repoId: 'r1', repoName: 'app', pullNumber: 7 },
      ]),
    );
    const client = createApiClient({ fetchImpl });
    const result = await client.listWorktrees();
    expect(result).toHaveLength(1);
    expect(calls[0][0]).toBe('/api/worktrees');
  });

  it('removes a worktree via a JSON POST', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ removed: true }));
    const client = createApiClient({ fetchImpl });
    const result = await client.removeWorktree('/w/app-pr-7');
    expect(result).toEqual({ removed: true });
    const [url, init] = calls[0];
    expect(url).toBe('/api/worktrees/remove');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ path: '/w/app-pr-7' }));
  });

  it('starts a GitHub device-flow sign-in via a JSON POST', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ userCode: 'ABCD-1234' }),
    );
    const client = createApiClient({ fetchImpl });
    const result = await client.githubSignInStart();
    expect(result).toEqual({ userCode: 'ABCD-1234' });
    expect(calls[0][0]).toBe('/api/github/signin/start');
    expect(calls[0][1]?.method).toBe('POST');
  });

  it('polls a GitHub device-flow sign-in with the device code', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ status: 'success' }));
    const client = createApiClient({ fetchImpl });
    const result = await client.githubSignInPoll('dev-code');
    expect(result).toEqual({ status: 'success' });
    expect(calls[0][0]).toBe('/api/github/signin/poll');
    expect(calls[0][1]?.body).toBe(JSON.stringify({ deviceCode: 'dev-code' }));
  });

  it('signs out of GitHub', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ authenticated: false, login: null }),
    );
    const client = createApiClient({ fetchImpl });
    const result = await client.githubSignOut();
    expect(result).toEqual({ authenticated: false, login: null });
    expect(calls[0][0]).toBe('/api/github/signout');
    expect(calls[0][1]?.method).toBe('POST');
  });

  it('surfaces the server error message on ApiError', async () => {
    const { fetchImpl } = mockFetch(
      jsonResponse({ error: { message: 'no access to org' } }, 403),
    );
    const client = createApiClient({ fetchImpl });
    await expect(client.listRepoPulls('r1')).rejects.toMatchObject({
      status: 403,
      message: 'no access to org',
    });
  });

  it('falls back to a generic message when the error body has no message', async () => {
    const response = {
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response;
    const client = createApiClient({ fetchImpl: async () => response });
    await expect(client.listFeatures()).rejects.toMatchObject({
      status: 500,
      message: 'Request failed: /features',
    });
  });

  it('lists automations and reads one', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ automations: [], subagents: [] }),
    );
    const client = createApiClient({ fetchImpl });
    await client.listAutomations();
    await client.getAutomation('a1');
    expect(calls[0][0]).toBe('/api/automations');
    expect(calls[0][1]).toBeUndefined();
    expect(calls[1][0]).toBe('/api/automations/a1');
  });

  it('creates an automation with a JSON POST body', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'a1' }));
    const client = createApiClient({ fetchImpl });
    await client.createAutomation({
      name: 'Watch',
      mode: 'long',
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'always' },
      action: { type: 'report', prompt: 'go' },
    });
    expect(calls[0][0]).toBe('/api/automations');
    expect(calls[0][1]?.method).toBe('POST');
  });

  it('drives automation lifecycle routes', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 'a1' }));
    const client = createApiClient({ fetchImpl });
    await client.pauseAutomation('a1');
    await client.resumeAutomation('a1');
    await client.cancelAutomation('a1');
    await client.runAutomation('a1');
    await client.updateAutomationInterval('a1', 300_000);
    await client.deleteAutomation('a1');
    expect(calls.map((c) => `${c[1]?.method ?? 'GET'} ${c[0]}`)).toEqual([
      'POST /api/automations/a1/pause',
      'POST /api/automations/a1/resume',
      'POST /api/automations/a1/cancel',
      'POST /api/automations/a1/run',
      'POST /api/automations/a1/interval',
      'DELETE /api/automations/a1',
    ]);
    expect(calls[4][1]?.body).toBe(JSON.stringify({ intervalMs: 300_000 }));
  });
});

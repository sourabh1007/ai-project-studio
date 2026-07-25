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

  it('deletes a session with a DELETE request', async () => {
    const { fetchImpl, calls } = mockFetch(jsonResponse({ id: 's1' }));
    const client = createApiClient({ fetchImpl });
    const result = await client.deleteSession('s1');
    expect(result).toEqual({ id: 's1' });
    expect(calls[0][0]).toBe('/api/sessions/s1');
    expect(calls[0][1]?.method).toBe('DELETE');
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

  it('reads the effective config', async () => {
    const { fetchImpl, calls } = mockFetch(
      jsonResponse({ namespaces: [], defaults: {}, current: {} }),
    );
    const client = createApiClient({ fetchImpl });
    await client.getConfig();
    expect(calls[0][0]).toBe('/api/config');
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
});

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

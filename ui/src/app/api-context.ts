import { createContext, useContext } from 'react';
import { createApiClient, type ApiClient, type FetchLike } from '../lib/api.js';
import { resolveApiBase } from '../lib/api-base.js';
import { beginActivity, endActivity, failActivity } from '../lib/activity.js';

/**
 * Derives a short, human-readable status-bar label from a request so the user
 * always sees what the app is doing (e.g. "Checking out pull request…") rather
 * than a blank spinner. Falls back to a generic "Working…".
 */
export function describeRequest(method: string, path: string): string {
  const p = path.split('?')[0];
  const m = method.toUpperCase();
  if (p.endsWith('/pulls') && m === 'POST') return 'Checking out pull request…';
  if (p.endsWith('/pulls')) return 'Loading pull requests…';
  if (p.includes('/signin')) return 'Signing in…';
  if (p.endsWith('/repos') && m === 'POST') return 'Adding repository…';
  if (p.includes('/providers/') && p.includes('/repos'))
    return 'Loading repositories…';
  if (p.endsWith('/summary') && m === 'POST') return 'Generating summary…';
  if (p.includes('/tasks/generate')) return 'Generating tasks…';
  if (p.endsWith('/sessions') && m === 'POST') return 'Starting session…';
  if (p.includes('/skills') && m === 'POST') return 'Saving skill…';
  if (m === 'DELETE') return 'Deleting…';
  if (m === 'POST' || m === 'PUT') return 'Saving…';
  return 'Working…';
}

/**
 * A fetch wrapper that reports every request into the global activity store so
 * the status bar reflects in-flight work and surfaces failures. Errors are
 * re-thrown unchanged so callers still handle them inline.
 */
const activityFetch: FetchLike = async (input, init) => {
  const label = describeRequest(init?.method ?? 'GET', String(input));
  beginActivity(label);
  try {
    const response = await fetch(input, init);
    if (response.ok) {
      endActivity();
    } else {
      failActivity(label);
    }
    return response;
  } catch (err) {
    failActivity(err instanceof Error ? err.message : label);
    throw err;
  }
};

/**
 * Single shared API client. The base URL is config-driven: in the packaged
 * desktop app the Electron preload injects an absolute `window.__CW_API_BASE__`
 * (there is no dev proxy over file://); in the browser it falls back to the
 * Vite-proxied `/api`.
 */
export const apiClient: ApiClient = createApiClient({
  baseUrl: resolveApiBase(
    typeof window !== 'undefined' ? window.__CW_API_BASE__ : undefined,
    import.meta.env.VITE_API_BASE,
  ),
  fetchImpl: activityFetch,
});

const ApiContext = createContext<ApiClient>(apiClient);

export const ApiProvider = ApiContext.Provider;

/** Access the shared API client from any component. */
export function useApi(): ApiClient {
  return useContext(ApiContext);
}

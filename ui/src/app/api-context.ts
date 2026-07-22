import { createContext, useContext } from 'react';
import { createApiClient, type ApiClient } from '../lib/api.js';
import { resolveApiBase } from '../lib/api-base.js';

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
});

const ApiContext = createContext<ApiClient>(apiClient);

export const ApiProvider = ApiContext.Provider;

/** Access the shared API client from any component. */
export function useApi(): ApiClient {
  return useContext(ApiContext);
}

/**
 * Resolves the backend API base URL from the available config sources, in
 * priority order: an absolute base injected by the desktop shell
 * (`window.__CW_API_BASE__`), then a Vite build-time env (`VITE_API_BASE`),
 * then the dev-proxied default `/api`. Empty strings are ignored so a blank
 * injection never overrides a real value.
 */
export function resolveApiBase(
  windowBase: string | undefined,
  envBase: string | undefined,
): string {
  if (windowBase && windowBase.length > 0) {
    return windowBase;
  }
  if (envBase && envBase.length > 0) {
    return envBase;
  }
  return '/api';
}

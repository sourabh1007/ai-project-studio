/**
 * Builds the WebSocket URL for a session's interactive terminal from the
 * configured API base. Handles both a relative base (same-origin desktop /
 * dev-proxy, e.g. `/api`) and an absolute base (`http(s)://host/api`), mapping
 * the scheme to `ws`/`wss`. Pure and injectable for testing.
 */
export interface WsLocation {
  protocol: string;
  host: string;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function buildTerminalWsUrl(
  apiBase: string,
  sessionId: string,
  location: WsLocation,
): string {
  const query = `?sessionId=${encodeURIComponent(sessionId)}`;
  if (/^https?:\/\//i.test(apiBase)) {
    const url = new URL(apiBase);
    const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = stripTrailingSlash(url.pathname);
    return `${scheme}//${url.host}${path}/terminal${query}`;
  }
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${stripTrailingSlash(apiBase)}/terminal${query}`;
}

/**
 * Best-effort classification of whether a failed MCP probe failed because the
 * server needs the user to authenticate, plus any login URL it printed. MCP
 * servers have no standard "auth required" signal, so this reads the human-facing
 * output (stderr/stdout lines and the error message) the server emitted and
 * matches the login/device-code language they conventionally use.
 */

import { nativeAuthenticationRequired } from './native-mcp-auth.js';

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gi;

export interface McpAuthClassification {
  authRequired: boolean;
  authUrl: string | null;
}

/** Classifies auth-need and extracts the first login URL from probe output. */
export function classifyMcpAuth(
  message: string | null,
  output: readonly string[],
): McpAuthClassification {
  const haystack = [message ?? '', ...output].join('\n');
  const authRequired = nativeAuthenticationRequired(message, output) ||
    /\b(?:HTTP(?:\/[\d.]+)?|status(?:\s+code)?|request failed with)\s*[:=]?\s*401\b|\b401\s+unauthorized\b|\b(?:az login|gh auth login|login)\s+(?:is )?required\b/i.test(haystack);
  const authUrl = authRequired ? findAuthUrl(message, output) : null;
  return { authRequired, authUrl };
}

/** Returns a safe HTTPS link only after an explicit authentication challenge. */
function findAuthUrl(
  message: string | null,
  output: readonly string[],
): string | null {
  for (const line of [...output, message ?? '']) {
    for (const match of line.matchAll(URL_PATTERN)) {
      try {
        const url = new URL(match[0]);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) continue;
        if ([...url.searchParams.keys()].some((key) => /(?:^|_)(?:token|secret|password|credential)$|^(?:code|code_verifier)$/i.test(key))) continue;
        return url.href;
      } catch {
        // A malformed diagnostic URL is not a usable sign-in link.
      }
    }
  }
  return null;
}

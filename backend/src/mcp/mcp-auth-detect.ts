/**
 * Best-effort classification of whether a failed MCP probe failed because the
 * server needs the user to authenticate, plus any login URL it printed. MCP
 * servers have no standard "auth required" signal, so this reads the human-facing
 * output (stderr/stdout lines and the error message) the server emitted and
 * matches the login/device-code language they conventionally use.
 */

const AUTH_SIGNALS: readonly string[] = [
  'unauthorized',
  'not authenticated',
  'authentication required',
  'authentication failed',
  'authenticate',
  'please log in',
  'please login',
  'please sign in',
  'sign in',
  'sign-in',
  'signed in',
  'log in',
  'login',
  'az login',
  'gh auth login',
  'device code',
  'devicecode',
  'device_code',
  'access token',
  'token has expired',
  'token expired',
  'expired token',
  'credential',
  'no credentials',
  'permission denied',
  'forbidden',
  '401',
  '403',
];

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/i;

export interface McpAuthClassification {
  authRequired: boolean;
  authUrl: string | null;
}

/** Classifies auth-need and extracts the first login URL from probe output. */
export function classifyMcpAuth(
  message: string | null,
  output: readonly string[],
): McpAuthClassification {
  const haystack = [message ?? '', ...output].join('\n').toLowerCase();
  const authRequired = AUTH_SIGNALS.some((signal) => haystack.includes(signal));
  const authUrl = authRequired ? findAuthUrl(message, output) : null;
  return { authRequired, authUrl };
}

/** Returns the first http(s) URL printed alongside an auth prompt, if any. */
function findAuthUrl(
  message: string | null,
  output: readonly string[],
): string | null {
  for (const line of [...output, message ?? '']) {
    const match = URL_PATTERN.exec(line);
    if (match) {
      return match[0];
    }
  }
  return null;
}

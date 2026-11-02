import type { McpToolInspection } from './mcp-contract.js';

export const NATIVE_AUTH_INTERRUPTED_MESSAGE = 'Tools were listed while a native sign-in challenge was pending. The probe ended before sign-in completion or credential caching could be confirmed. Complete service sign-in in the native CLI; this check does not establish reusable authentication.';

export function nativeAuthenticationInterrupted(result: McpToolInspection): boolean {
  return result.authenticationInterrupted === true ||
    (result.status === 'ok' && nativeAuthenticationPrompt(result.output).authUrl !== null);
}

export function nativeCredentialsExpired(message: string | null, output: readonly string[]): boolean {
  return /\b(?:access |refresh )?token(?: has| is)? expired\b|\bexpired (?:access |refresh )?token\b|\bcredentials?(?: have| has| are| is)? expired\b|\bexpired credentials?\b/i
    .test([message ?? '', ...output].join('\n'));
}

/** Evidence of a challenge, not a guess from timeout, permission denial or tool availability. */
export function nativeAuthenticationRequired(message: string | null, output: readonly string[]): boolean {
  return nativeCredentialsExpired(message, output) || /authentication (?:required|failed)|not authenticated|not logged in|unauthorized|(?:please|to) (?:sign[ -]in|log[ -]?in|authenticate)|device[ _-]?code|no credentials|credentialunavailable|credentials? (?:are |is )?unavailable/i
    .test([message ?? '', ...output].join('\n'));
}

/** Only recognized Microsoft sign-in challenges are surfaced, never arbitrary stderr URLs/tokens. */
export function nativeAuthenticationPrompt(output: readonly string[]): { authUrl: string | null; deviceCode: string | null } {
  const text = output.join('\n');
  if (!nativeAuthenticationRequired(null, output)) return { authUrl: null, deviceCode: null };
  const url = /https:\/\/(?:www\.)?microsoft\.com\/devicelogin(?=[\s"'<>)]|$)/i.exec(text)?.[0];
  if (url) {
    const code = /\benter (?:the )?code[:\s]+([A-Z0-9]{6,16})\b/i.exec(text)?.[1];
    return { authUrl: 'https://microsoft.com/devicelogin', deviceCode: code ?? null };
  }
  for (const candidate of text.match(/https:\/\/[^\s"'<>)]*/gi) ?? []) {
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname !== 'login.microsoftonline.com' || parsed.username || parsed.password || parsed.port || parsed.hash ||
          !/^\/[A-Za-z0-9.-]+\/oauth2\/(?:v2\.0\/)?authorize$/.test(parsed.pathname)) continue;
      if ([...parsed.searchParams.keys()].some((key) => /token|secret|password|credential/i.test(key) || key.toLowerCase() === 'code')) continue;
      if (parsed.searchParams.get('response_type') !== 'code' ||
          !parsed.searchParams.get('client_id') || !parsed.searchParams.get('state')) continue;
      const redirect = new URL(parsed.searchParams.get('redirect_uri') ?? '');
      if (!['http:', 'https:'].includes(redirect.protocol) || redirect.username || redirect.password || redirect.hash ||
          !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)) continue;
      return { authUrl: candidate, deviceCode: null };
    } catch {
      // Malformed native output is not a usable authentication challenge.
    }
  }
  return { authUrl: null, deviceCode: null };
}

/** Short-lived native probes must not advertise a dead process's authentication link. */
export function nativeToolInspection(result: McpToolInspection): McpToolInspection {
  if (nativeAuthenticationInterrupted(result)) return {
    ...result, status: 'failed', authenticationInterrupted: true,
    output: [], authUrl: null, authRequired: false, message: NATIVE_AUTH_INTERRUPTED_MESSAGE,
  };
  const authRequired = result.status !== 'ok' && nativeAuthenticationRequired(result.message, result.output);
  return {
    ...result,
    output: [],
    authUrl: null,
    authRequired,
    message: result.status === 'ok'
      ? 'Native tool inventory was returned. Authorization for individual tool calls has not been verified.'
      : authRequired
        ? 'The native proxy reported an authentication requirement. The short probe has ended; continue explicitly to keep a native process running.'
        : 'Native tool discovery did not complete. No authentication requirement was confirmed. Run the configured native MCP command in a trusted terminal to inspect startup diagnostics. For managed or enterprise policy failures, ask your administrator to repair the approved configuration; this app will not bypass administrator policy or native safety flags.',
  };
}

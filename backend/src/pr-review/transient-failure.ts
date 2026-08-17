/**
 * Infrastructure signals that mean a metasession failed for a *transient*,
 * retryable reason rather than a genuine problem with the request: an upstream
 * 5xx, a GitHub CLI auth/login blip (the "Failed to fetch GitHub CLI user
 * login (503)" family seen when GitHub is briefly unavailable), a network
 * reset, a briefly-unavailable service, or a flaky Copilot CLI launch (which
 * surfaces as a generic non-zero `launch_engine` exit even though the real
 * cause upstream was transient). Matched case-insensitively as substrings.
 */
const TRANSIENT_SIGNALS: readonly string[] = [
  'no server is currently available',
  'failed to fetch github cli user login',
  'service unavailable',
  'temporarily unavailable',
  'internal server error',
  'bad gateway',
  'gateway timeout',
  ' 500',
  ' 502',
  ' 503',
  ' 504',
  '(500)',
  '(502)',
  '(503)',
  '(504)',
  '429',
  'rate limit',
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'eai_again',
  'socket hang up',
  'connection reset',
  'network error',
  'exited with non-zero status',
  'agent execution failed',
  'launch_engine',
];

/**
 * True when a provider-failure message looks transient and the read-only step
 * that produced it is worth retrying. A runner *timeout* is deliberately never
 * transient: it already waited out the whole step budget, so it should surface
 * at once instead of tripling the wait with retries.
 */
export function isTransientProviderFailure(message: string): boolean {
  const text = message.toLowerCase();
  if (text.includes('timed out')) {
    return false;
  }
  return TRANSIENT_SIGNALS.some((signal) => text.includes(signal));
}

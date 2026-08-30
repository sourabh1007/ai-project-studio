import { isTransientProviderFailure } from '../pr-review/transient-failure.js';

/**
 * Signals that a live CLI session has entered a *recoverable* broken state — one
 * that a fresh conversation (re-submit, and ultimately a session restart) clears
 * — rather than a genuine problem with the user's request. The canonical case is
 * a corrupted/oversized conversation history the provider rejects with a
 * `400 Bad Request`, and an MCP server that takes too long to hand-shake on
 * session start. Matched case-insensitively as substrings.
 *
 * These are deliberately kept separate from {@link isTransientProviderFailure}'s
 * upstream-blip signals: those are safe to retry anywhere (including read-only
 * metasession steps), whereas a `400` is only worth retrying for an *interactive*
 * session the IDE can restart — treating it as transient elsewhere would mask a
 * real bad request.
 */
const RECOVERABLE_SESSION_SIGNALS: readonly string[] = [
  '400 bad request',
  'bad request (400)',
  '(400)',
  ' 400 ',
  'request_id',
  'invalid request',
  'context length',
  'context_length_exceeded',
  'maximum context length',
  'too many tokens',
  'taking longer than expected to connect',
  'mcp server',
  'failed to connect to mcp',
  'connection closed',
  'session is corrupted',
  'stream error',
];

/**
 * True when a completed CLI output line signals a recoverable session error the
 * IDE should try to self-heal from: either a transient upstream blip (reusing
 * the shared classifier) or a session-corruption signal that a restart clears.
 * Used only for interactive dev sessions the IDE can safely re-drive.
 */
export function isRecoverableSessionError(line: string): boolean {
  if (isTransientProviderFailure(line)) {
    return true;
  }
  const text = line.toLowerCase();
  return RECOVERABLE_SESSION_SIGNALS.some((signal) => text.includes(signal));
}

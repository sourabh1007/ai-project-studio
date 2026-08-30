import { stripAnsi } from './ansi.js';

/** Max bytes of pending (un-newlined) output retained while scanning lines. */
const OUTPUT_SCAN_CAP = 16384;

export interface SessionAutoRetryDeps {
  /**
   * True when a completed output line signals a *transient*, retryable provider
   * failure (an upstream 5xx / 429 / network reset) rather than a genuine
   * problem with the request. Reuses the metasession classifier so interactive
   * sessions heal from the same blips the IDE already retries elsewhere.
   */
  isTransient: (line: string) => boolean;
  /** Extra automatic re-submits of the last prompt per failure streak. */
  maxAttempts: number;
  /** Delay before a re-submit, giving the flaky upstream a moment to recover. */
  backoffMs: number;
  /**
   * Re-submits a prompt into the live terminal exactly as a user would (writes
   * the text, then a submit keystroke once the paste settles). Must NOT feed
   * back into {@link SessionAutoRetry.observeInput}, or the resend would be
   * mistaken for a fresh prompt and reset the attempt budget.
   */
  resubmit: (prompt: string) => void;
  /** Optional user-visible notice shown when an automatic retry fires. */
  notify?: (text: string) => void;
  /**
   * Invoked once per failure streak when the automatic re-submit budget is
   * spent but the session is still failing on a recoverable error. Lets a
   * higher tier (metasession analysis, a CLI restart) take over. Fires at most
   * once until a fresh user prompt resets the streak, so escalation never
   * loops. Carries the prompt that could not be recovered and the failing line.
   */
  onExhausted?: (info: { prompt: string; line: string }) => void;
  /** Injected timer so tests stay deterministic; defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => void;
}

export interface SessionAutoRetry {
  /** Feeds raw browser keystrokes so the last submitted prompt is tracked. */
  observeInput(data: string): void;
  /** Feeds raw terminal output so transient failures trigger a re-submit. */
  observeOutput(data: string): void;
}

type EscapeState = 'none' | 'esc' | 'csi';

/**
 * Auto-heals an interactive AI CLI session from transient provider failures by
 * re-submitting the user's last prompt. It reconstructs that prompt from the
 * keystroke stream (handling backspace and arrow-key/escape sequences), scans
 * completed output lines for a transient-failure signal, and — bounded by a
 * per-streak attempt budget — resends the prompt after a short backoff. A fresh
 * user prompt resets the budget; a resend never does (it bypasses input
 * observation), so a genuinely broken request cannot loop forever.
 */
export function createSessionAutoRetry(
  deps: SessionAutoRetryDeps,
): SessionAutoRetry {
  const setTimer =
    deps.setTimer ?? ((fn, ms) => void setTimeout(fn, ms));

  let inputLine = '';
  let escape: EscapeState = 'none';
  let lastPrompt: string | null = null;
  let attempts = 0;
  // Guards a single failure streak: cleared while a retry is pending so a burst
  // of failure lines can't schedule multiple resends, re-armed on each resend.
  let armed = false;
  // Ensures the exhaustion escalation fires at most once per streak, however
  // many failure lines the CLI prints after the budget is spent.
  let exhaustedFired = false;
  let outputBuffer = '';

  const submitInputLine = (): void => {
    const prompt = inputLine.trim();
    inputLine = '';
    if (prompt.length === 0) {
      return;
    }
    lastPrompt = prompt;
    attempts = 0;
    armed = true;
    exhaustedFired = false;
  };

  const observeInput = (data: string): void => {
    for (let i = 0; i < data.length; i += 1) {
      const ch = data[i];
      const code = data.charCodeAt(i);
      if (escape === 'esc') {
        escape = ch === '[' || ch === 'O' ? 'csi' : 'none';
        continue;
      }
      if (escape === 'csi') {
        if (code >= 0x40 && code <= 0x7e) {
          escape = 'none';
        }
        continue;
      }
      if (code === 0x1b) {
        escape = 'esc';
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        submitInputLine();
        continue;
      }
      if (code === 0x7f || code === 0x08) {
        inputLine = inputLine.slice(0, -1);
        continue;
      }
      if (code < 0x20) {
        continue;
      }
      inputLine += ch;
    }
  };

  const maybeRetry = (line: string): void => {
    if (!armed || lastPrompt === null || !deps.isTransient(line)) {
      return;
    }
    if (attempts >= deps.maxAttempts) {
      // Non-destructive re-submits are spent: hand off once to the escalation
      // tier (metasession analysis / CLI restart) rather than looping forever.
      if (!exhaustedFired) {
        exhaustedFired = true;
        deps.onExhausted?.({ prompt: lastPrompt, line });
      }
      return;
    }
    armed = false;
    attempts += 1;
    const attempt = attempts;
    deps.notify?.(
      `\r\n[auto-retry] transient provider error — retrying (attempt ${attempt}/${deps.maxAttempts})…\r\n`,
    );
    const prompt = lastPrompt;
    setTimer(() => {
      armed = true;
      deps.resubmit(prompt);
    }, deps.backoffMs);
  };

  const observeOutput = (data: string): void => {
    outputBuffer += data;
    let newline = outputBuffer.indexOf('\n');
    while (newline >= 0) {
      const rawLine = outputBuffer.slice(0, newline);
      outputBuffer = outputBuffer.slice(newline + 1);
      const line = stripAnsi(rawLine).trim();
      if (line.length > 0) {
        maybeRetry(line);
      }
      newline = outputBuffer.indexOf('\n');
    }
    if (outputBuffer.length > OUTPUT_SCAN_CAP) {
      outputBuffer = outputBuffer.slice(outputBuffer.length - OUTPUT_SCAN_CAP);
    }
  };

  return { observeInput, observeOutput };
}

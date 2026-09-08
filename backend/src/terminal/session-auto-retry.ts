import { stripAnsi } from './ansi.js';

/** Max bytes of pending (un-newlined) output retained while scanning lines. */
const OUTPUT_SCAN_CAP = 16384;

/** Cancels one scheduled retry callback. */
type CancelTimer = () => void;

export interface SessionAutoRetryDeps {
  /**
   * True when a completed output line signals a recoverable provider/session
   * failure (for example an upstream 5xx / 429 / network reset, or another
   * provider-specific error the caller has chosen to treat as retryable).
   */
  isTransient: (line: string) => boolean;
  /** Extra automatic re-submits of one confirmed safe request per failure streak. */
  maxAttempts: number;
  /** Delay before an automatic re-submit, giving the upstream a moment to recover. */
  backoffMs: number;
  /**
   * Re-submits a provider-confirmed replay-safe request into the live terminal.
   * Must NOT feed back into {@link SessionAutoRetry.observeInput}, or the resend
   * would be mistaken for fresh user activity and invalidate the authority.
   */
  resubmit: (prompt: string) => void;
  /** Optional user-visible notice shown for automatic retry/manual retry guidance. */
  notify?: (text: string) => void;
  /**
   * Invoked once per failure streak when a provider-confirmed replay-safe
   * request is still failing after the automatic re-submit budget is spent.
   * Carries an `isCurrent` guard so any async follow-up (analysis/restart) can
   * abort silently once new user input, disposal, or a newer request supersedes
   * the authority that triggered this escalation.
   */
  onExhausted?: (info: {
    prompt: string;
    line: string;
    isCurrent: () => boolean;
  }) => void;
  /**
   * Injected scheduler so tests stay deterministic; defaults to setTimeout and
   * returns a cancellation callback that must prevent future execution.
   */
  scheduleTimer?: (fn: () => void, ms: number) => CancelTimer;
}

export interface SessionAutoRetry {
  /**
   * Feeds raw browser keystrokes. Browser input NEVER establishes replay
   * authority; once any authority exists, later user input cancels it.
   */
  observeInput(data: string): void;
  /** Feeds raw terminal output so transient failures trigger retry/manual guidance. */
  observeOutput(data: string): void;
  /**
   * Records one exact request text as safe to replay, but only because an
   * authoritative provider-side path confirmed it. Raw PTY keystrokes must
   * never call this.
   */
  confirmReplaySafeRequest(exactText: string): void;
  /** Cancels pending retry/escalation work and makes future callbacks inert. */
  dispose(): void;
}

const MANUAL_RETRY_UNCONFIRMED_NOTICE =
  '\r\n[auto-retry] recoverable session error detected. Automatic replay is unavailable unless the provider confirms an exact replay-safe request, so review the CLI state and retry manually if needed.\r\n';

const MANUAL_RETRY_EXHAUSTED_NOTICE =
  '\r\n[auto-retry] recoverable session error detected again after the automatic retry budget was spent. Review the CLI state and retry manually if needed.\r\n';

interface ReplayAuthority {
  prompt: string;
  version: number;
}

/**
 * Bounded recovery helper for interactive sessions. It never tries to
 * reconstruct a request from raw terminal keystrokes; browser input only
 * invalidates pending automatic recovery. Automatic replay is allowed solely
 * for an exact request text the provider independently confirmed as
 * replay-safe.
 */
export function createSessionAutoRetry(
  deps: SessionAutoRetryDeps,
): SessionAutoRetry {
  const scheduleTimer =
    deps.scheduleTimer ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });

  let replayAuthority: ReplayAuthority | null = null;
  let authorityVersion = 0;
  let attempts = 0;
  let exhaustedFired = false;
  let manualNoticeFired = false;
  let cancelPendingRetry: CancelTimer | null = null;
  let outputBuffer = '';
  let disposed = false;

  const clearPendingRetry = (): void => {
    cancelPendingRetry?.();
    cancelPendingRetry = null;
  };

  const resetFlags = (): void => {
    attempts = 0;
    exhaustedFired = false;
    manualNoticeFired = false;
  };

  const invalidateReplayAuthority = (): void => {
    authorityVersion += 1;
    replayAuthority = null;
    clearPendingRetry();
    resetFlags();
  };

  const isCurrentAuthority = (version: number): boolean =>
    !disposed && replayAuthority?.version === version;

  const notifyManualRetry = (text: string): void => {
    if (manualNoticeFired) {
      return;
    }
    manualNoticeFired = true;
    deps.notify?.(text);
  };

  const confirmReplaySafeRequest = (exactText: string): void => {
    if (disposed) {
      return;
    }
    authorityVersion += 1;
    clearPendingRetry();
    resetFlags();
    replayAuthority =
      exactText.length === 0
        ? null
        : { prompt: exactText, version: authorityVersion };
  };

  const observeInput = (data: string): void => {
    if (disposed || data.length === 0) {
      return;
    }
    invalidateReplayAuthority();
  };

  const maybeRetry = (line: string): void => {
    if (disposed || !deps.isTransient(line)) {
      return;
    }
    const authority = replayAuthority;
    if (!authority) {
      notifyManualRetry(MANUAL_RETRY_UNCONFIRMED_NOTICE);
      return;
    }
    if (cancelPendingRetry) {
      return;
    }
    if (attempts >= deps.maxAttempts) {
      if (exhaustedFired) {
        return;
      }
      exhaustedFired = true;
      if (deps.onExhausted) {
        deps.onExhausted({
          prompt: authority.prompt,
          line,
          isCurrent: () => isCurrentAuthority(authority.version),
        });
      } else {
        notifyManualRetry(MANUAL_RETRY_EXHAUSTED_NOTICE);
      }
      return;
    }
    attempts += 1;
    const attempt = attempts;
    deps.notify?.(
      `\r\n[auto-retry] recoverable session error — retrying (attempt ${attempt}/${deps.maxAttempts})…\r\n`,
    );
    cancelPendingRetry = scheduleTimer(() => {
      cancelPendingRetry = null;
      if (!isCurrentAuthority(authority.version)) {
        return;
      }
      deps.resubmit(authority.prompt);
    }, deps.backoffMs);
  };

  const observeOutput = (data: string): void => {
    if (disposed) {
      return;
    }
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

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    invalidateReplayAuthority();
    disposed = true;
    outputBuffer = '';
  };

  return {
    observeInput,
    observeOutput,
    confirmReplaySafeRequest,
    dispose,
  };
}

/**
 * Keeps provider credentials (the GitHub token and the Azure DevOps OAuth
 * token) warm by periodically triggering a silent, non-interactive background
 * refresh. Future child processes can inherit the refreshed snapshot; existing
 * children and service-specific native MCP caches are not updated by this loop.
 *
 * The actual provider refresh is injected (GitHub `gh auth token` + Azure GCM
 * `credential-manager get`, wired in main.ts) so this stays a pure, testable
 * scheduler with no IO of its own.
 */
export interface CredentialWarmerDeps {
  /**
   * Runs one background credential refresh across all providers. Must resolve
   * whether or not the refresh succeeds — warming is best-effort and a failure
   * must never surface as an unhandled rejection.
   */
  refresh: () => Promise<void>;
  /** How often to warm, in milliseconds. */
  intervalMs: number;
  /** Optional hook invoked when a warm rejects, for logging. */
  onError?: (error: unknown) => void;
}

export interface CredentialWarmer {
  /** Runs a single warm now, reporting (never throwing) any error. */
  warm(): Promise<void>;
  /** Begins periodic warming. Idempotent — a second call is a no-op. */
  start(): void;
  /** Stops periodic warming. Idempotent — safe to call when not started. */
  stop(): void;
}

export function createCredentialWarmer(
  deps: CredentialWarmerDeps,
): CredentialWarmer {
  let timer: ReturnType<typeof setInterval> | null = null;

  const warm = async (): Promise<void> => {
    try {
      await deps.refresh();
    } catch (error) {
      deps.onError?.(error);
    }
  };

  return {
    warm,
    start() {
      if (timer !== null) {
        return;
      }
      timer = setInterval(() => {
        void warm();
      }, deps.intervalMs);
      // Never keep the process alive just to warm credentials.
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

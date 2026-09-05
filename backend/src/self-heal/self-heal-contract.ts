/**
 * Self-healing domain contract. The IDE distinguishes *its own* bugs from
 * environment problems it can fix on the user's behalf — a missing CLI, an
 * unconfigured model, a fixable config error. Those "healable" problems are
 * expressed as {@link Healer}s and driven by the {@link SelfHealService}, which
 * verifies, attempts a fix, and re-verifies, streaming progress so the UI can
 * show a live, premium status instead of a dead-end error.
 *
 * Type-only module (no runtime code) so it stays free of the coverage gate.
 */

/** Where a heal attempt currently is. */
export type HealPhase = 'idle' | 'checking' | 'healing' | 'done' | 'error';

/** Static description of something the IDE knows how to heal. */
export interface HealTargetInfo {
  /** Stable id used in the API route (e.g. `github-cli`). */
  id: string;
  /** Human title (e.g. `GitHub CLI`). */
  title: string;
  /** One-line explanation of the problem and the fix. */
  description: string;
  /**
   * How the fix is carried out — a direct action (install/config) or delegated
   * to a headless metasession that diagnoses and repairs autonomously.
   */
  strategy: 'install' | 'config' | 'metasession';
}

/** A streamed event from a heal run. `done`/`error` are terminal. */
export type HealEvent =
  | { kind: 'phase'; phase: HealPhase }
  | { kind: 'log'; line: string }
  | { kind: 'done'; healed: boolean; message: string }
  | { kind: 'error'; message: string };

/** A single self-healing capability. */
export interface Healer {
  readonly info: HealTargetInfo;
  /**
   * Whether the problem is already resolved. Called before healing (to skip a
   * no-op) and after (to confirm success).
   */
  verify(): Promise<boolean>;
  /** Attempt the fix, streaming human-readable log lines. */
  heal(log: (line: string) => void): Promise<void>;
}

/** Orchestrates the registered healers. */
export interface SelfHealService {
  /** The catalog of healable problems, for discovery in the UI. */
  list(): HealTargetInfo[];
  /**
   * Verify → heal → re-verify a target, streaming events. Resolves to whether
   * the problem is resolved at the end. Never throws — failures are emitted as
   * `error` events.
   */
  heal(targetId: string, onEvent: (event: HealEvent) => void): Promise<boolean>;
}

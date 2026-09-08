import type { Clock } from '../kernel/clock.js';
import type { EventBus } from '../kernel/event-bus.js';
import type { ProviderRegistry } from '../provider/provider-registry.js';
import type { SessionSpec } from '../provider/provider-contract.js';
import type { Session } from '../session/session-contract.js';
import type { SessionEventMap } from '../session/session-launcher.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { PtyProcess, PtySpawner } from './pty-contract.js';
import type { TerminalConfig } from './config.js';
import type { SessionFilesStore } from '../session-files/session-files-contract.js';
import {
  createTerminalSession,
  type TerminalSession,
} from './terminal-session.js';
import {
  createSessionAutoRetry,
  type SessionAutoRetry,
} from './session-auto-retry.js';
import {
  createSelfRecoveryCoordinator,
  type SelfRecoveryCoordinatorDeps,
} from '../self-recovery/self-recovery-coordinator.js';
import { stripAnsi } from './ansi.js';
import type { SessionBootstrap } from '../session-bootstrap/session-bootstrap.js';
import { createWorkTracker } from '../kernel/work-tracker.js';
import type { Logger } from '../kernel/logger.js';

/** Max bytes of recent (ANSI-stripped) output scanned for the ready prompt. */
const READY_SCAN_BYTES = 8192;

export interface TerminalManagerDeps {
  logger: Pick<Logger, 'error'>;
  spawner: PtySpawner;
  providers: ProviderRegistry;
  bus: EventBus<SessionEventMap>;
  clock: Clock;
  config: TerminalConfig;
  transcriptStore: TranscriptStore;
  bootstrap: Pick<SessionBootstrap, 'composeForSession'>;
  /** Records files each session creates/edits, parsed from its own output. */
  sessionFiles: Pick<SessionFilesStore, 'record'>;
  /**
   * Reports a mid-session model switch parsed from the tool's own terminal
   * output, so the resolved model shown for the session tracks the CLI. Omitted
   * when the caller does not track resolved models.
   */
  onModelResolved?: (sessionId: string, model: string) => void;
  /** User home directory, for a scanner to expand `~`-relative tool paths. */
  home: string;
  /**
   * Classifies a completed CLI output line as a recoverable session/provider
   * failure (for example an upstream 5xx / 429 / network reset). When provided
   * and retry handling is enabled, interactive sessions can automatically
   * replay only provider-confirmed replay-safe requests; raw PTY keystrokes are
   * never used as replay authority. Omitted to disable terminal retry handling.
   */
  isTransientFailure?: (line: string) => boolean;
  /**
   * Enables the self-recovery escalation ladder for interactive dev sessions:
   * once the non-destructive re-submits of a provider-confirmed replay-safe
   * request (see {@link isTransientFailure}) are exhausted on a recoverable
   * error, optionally analyze it via a metasession, then kill and relaunch the
   * CLI in a fresh conversation replaying that same confirmed request, and
   * finally report to the status bar if even that fails. Omitted to disable
   * escalation (only plain in-session retry/manual guidance runs).
   */
  selfRecovery?: {
    enabled: boolean;
    useMetaAnalysis: boolean;
    /** Analyzes the failing output via a metasession; rejects if it can't start. */
    analyze?: (errorText: string) => Promise<string | null>;
    /** Reports an unrecoverable failure to the UI status bar for a session. */
    report: (sessionId: string, message: string) => void;
  };
}

export interface LaunchOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  /**
   * A provider-confirmed replay-safe request to replay once the freshly
   * launched CLI is ready, seeded after any bootstrap context. Set only by the
   * self-recovery restart path, so a relaunch re-drives that exact confirmed
   * request in a clean conversation.
   */
  replaySeed?: string;
}

export interface TerminalManager {
  /**
   * Returns the live terminal for a session, launching the interactive CLI in a
   * PTY if one is not already running. Reuses the same Session/usage pipeline as
   * one-shot runs by emitting `session.started` / `session.ended`.
   */
  getOrLaunch(
    session: Session,
    options?: LaunchOptions,
  ): Promise<TerminalSession>;
  get(sessionId: string): TerminalSession | undefined;
  /** Follows replacements; null means reconnecting, or failed when flagged. */
  onTerminal(
    sessionId: string,
    listener: (terminal: TerminalSession | null, failed?: boolean) => void,
  ): () => void;
  /**
   * Seeds an instruction block into a session's already-running terminal, as
   * though it were typed and submitted. Used to apply a skill tagged to a live
   * session (session-scoped skills can only be tagged once the session — and
   * thus its terminal — is open, so they are never picked up by launch-time
   * seeding). Returns false when no live terminal exists or the block is empty.
   */
  injectInstructions(sessionId: string, instructions: string): boolean;
  /**
   * Feeds user keystrokes for a live session into its retry controller so any
   * pending automatic replay derived from an older confirmed request is
   * invalidated. Browser input NEVER establishes replay authority; only an
   * authoritative provider-side confirmation may do that. Programmatic writes
   * (skill seeding, an automatic resend) must not call this.
   */
  observeInput(sessionId: string, data: string): void;
  /**
   * Records an exact request text as safe to replay for a live session, but
   * only because some authoritative provider-side path independently confirmed
   * it. Raw browser/PTy input must never call this.
   */
  confirmReplaySafeRequest(sessionId: string, exactText: string): void;
  close(sessionId: string): void;
  /** Closes admission and requests termination; waitForIdle confirms settlement. */
  shutdown(): void;
}

export interface ManagedTerminalManager extends TerminalManager {
  waitForIdle(timeoutMs: number): Promise<boolean>;
  quiesceSession(sessionId: string, timeoutMs: number): Promise<boolean>;
  quiesceFeature(featureId: string, timeoutMs: number): Promise<boolean>;
}

export function createTerminalManager(
  deps: TerminalManagerDeps,
): ManagedTerminalManager {
  const work = createWorkTracker<string>();
  const completions = new Map<string, Promise<void>>();
  const features = new Map<string, string>();
  const blockedFeatures = new Set<string>();
  const sessions = new Map<string, TerminalSession>();
  const pending = new Map<string, Promise<TerminalSession>>();
  const tombstones = new Set<string>();
  // Retain attempt identity after exit, so delayed recovery can distinguish a
  // naturally-ended source from a newer launch (even one that also ended).
  const generations = new Map<string, number>();
  // Tracks whether an async recovery attempt still belongs to the latest
  // provider-confirmed request for a session. Browser input/new confirmations
  // bump it so delayed analysis cannot restart obsolete work.
  const replayEpochs = new Map<string, number>();
  const listeners = new Map<string, Set<(terminal: TerminalSession | null, failed?: boolean) => void>>();
  let stopped = false;
  let generation = 0;
  const currentReplayEpoch = (id: string) => replayEpochs.get(id) ?? 0;
  const bumpReplayEpoch = (id: string) => {
    replayEpochs.set(id, currentReplayEpoch(id) + 1);
  };
  const publish = (id: string, terminal: TerminalSession | null, failed?: boolean) => {
    for (const listener of listeners.get(id) ?? []) listener(terminal, failed);
  };
  const assertLaunchable = (id: string) => {
    if (stopped || tombstones.has(id) || blockedFeatures.has(features.get(id)!)) {
      throw new Error('Terminal launch cancelled');
    }
  };
  // Per-session interactive auto-retry controllers, keyed by session id. Only
  // present for interactive dev sessions when auto-retry is enabled; removed on
  // exit alongside the terminal.
  const retries = new Map<string, SessionAutoRetry>();
  // Sessions whose terminals are being killed as part of deletion. Their exit
  // must not be recorded as `session.ended` (which would re-persist the row we
  // are deleting); it is reported as `session.discarded` instead.
  const discarded = new Set<string>();

  function composeBootstrap(session: Session): Promise<string> | string {
    return session.kind === 'dev' && session.scope !== 'internal'
      ? deps.bootstrap.composeForSession(session)
      : '';
  }

  function spawnTerminal(
    session: Session,
    options: LaunchOptions,
    bootstrap: string,
  ): TerminalSession {
    assertLaunchable(session.id);
    const provider = deps.providers.get(session.provider);
    const spec: SessionSpec = {
      sessionId: session.id,
      featureId: session.featureId,
      prompt: session.prompt,
      model: session.requestedModel,
      kind: session.kind,
      otelFilePath: session.usageFilePath,
      cwd: options.cwd,
    };

    const started: Session = {
      ...session,
      status: 'running',
      startedAt: deps.clock.isoNow(),
      endedAt: null,
      exitCode: null,
    };
    const command = provider.buildInteractiveCommand(spec);
    assertLaunchable(session.id);
    const launchedGeneration = ++generation;
    generations.set(session.id, launchedGeneration);
    let pty: PtyProcess;
    try {
      deps.bus.emit('session.started', started);
      assertLaunchable(session.id);
      pty = deps.spawner.spawn({
        command: command.command,
        args: command.args,
        env: command.env,
        cwd: options.cwd,
        cols: options.cols ?? deps.config.defaultCols,
        rows: options.rows ?? deps.config.defaultRows,
      });
    } catch (error) {
      try {
        deps.bus.emit('session.ended', {
          ...started,
          status: stopped || tombstones.has(session.id) || blockedFeatures.has(session.featureId)
            ? 'cancelled' : 'failed',
          endedAt: deps.clock.isoNow(),
          exitCode: null,
        });
      } catch (publicationError) {
        throw new AggregateError([error, publicationError], 'Terminal startup failure could not be finalized');
      }
      throw error;
    }

    // Blocks to seed once the CLI is ready, in order: repository/feature/skill
    // bootstrap first, then any replay prompt from a self-recovery restart.
    const seeds = [bootstrap, options.replaySeed ?? ''].filter(
      (block) => block.length > 0,
    );

    let terminal!: TerminalSession;
    type ExitOutcome = {
      code: number | null;
      discarded: boolean;
      cancelled: boolean;
      endedAt: string;
    };
    let finishExit!: (outcome: ExitOutcome) => void;
    const exit = new Promise<ExitOutcome>((resolve) => {
      finishExit = resolve;
    });
    const persistExit = async () => {
      const outcome = await exit;
      if (outcome.discarded) return;
      const ended: Session = {
        ...started,
        status: outcome.cancelled ? 'cancelled' : outcome.code === 0 ? 'completed' : 'failed',
        endedAt: outcome.endedAt,
        exitCode: outcome.code,
      };
      try {
        await deps.transcriptStore.save({
          sessionId: session.id,
          stdout: [terminal.transcriptText()],
          stderr: [],
          exitCode: outcome.code,
        });
      } catch (error) {
        deps.bus.emit('session.notice', {
          sessionId: session.id,
          level: 'error',
          message: 'The terminal exited, but its transcript could not be saved.',
        });
        deps.bus.emit('session.ended', { ...ended, status: 'failed' });
        throw error;
      }
      deps.bus.emit('session.ended', ended);
    };
    const completion = work.own(session.id, async () => {
      try {
        await persistExit();
      } catch (error) {
        deps.logger.error('Terminal completion failed', { sessionId: session.id, error });
        throw error;
      } finally {
        if (completions.get(session.id) === completion) completions.delete(session.id);
      }
    });
    completions.set(session.id, completion);
    terminal = createTerminalSession({
      sessionId: session.id,
      generation: launchedGeneration,
      pty,
      inputReady: seeds.length === 0,
      scrollbackBytes: deps.config.scrollbackBytes,
      transcriptBytes: deps.config.transcriptBytes,
      initialCols: options.cols ?? deps.config.defaultCols,
      initialRows: options.rows ?? deps.config.defaultRows,
      onExit: (code) => {
        // Replacement waits for this completion; TerminalSession already deduplicates native exits.
        sessions.delete(session.id);
        retries.get(session.id)?.dispose();
        retries.delete(session.id);
        const wasDiscarded = discarded.delete(session.id);
        finishExit({
          code, discarded: wasDiscarded, cancelled: stopped, endedAt: deps.clock.isoNow(),
        });
        if (wasDiscarded) {
          // Deleted out from under us: drop the terminal without persisting an
          // ended snapshot, but let listeners release the usage tailer.
          deps.bus.emit('session.discarded', session.id);
        }
      },
    });

    sessions.set(session.id, terminal);

    // Track files this session creates/edits by parsing the tool's own output.
    // Each PTY is one session, so attribution is unambiguous — unlike watching
    // a shared working directory. Providers without a scanner contribute none.
    attachOutputScanner(terminal, provider, spec);

    // Track mid-session model switches the CLI announces in its output, so the
    // resolved model shown in the UI follows the CLI immediately.
    attachModelScanner(terminal, provider, session.id);

    // Surface MCP server connection failures the CLI prints as an IDE-level
    // notice, so the user gets an actionable signal instead of the error only
    // scrolling past in the terminal.
    attachMcpErrorScanner(terminal, provider, session.id);

    if (seeds.length > 0) {
      seedSequence(terminal, seeds, options.replaySeed ? currentReplayEpoch(session.id) : null);
    }

    attachAutoRetry(terminal, session, { ...options });
    publish(session.id, terminal);

    return terminal;
  }

  async function launch(
    session: Session,
    options: LaunchOptions,
  ): Promise<TerminalSession> {
    const finishing = completions.get(session.id);
    if (finishing) await finishing;
    assertLaunchable(session.id);
    // Compose first so repository-context readiness is enforced before any
    // lifecycle event is emitted or provider process is spawned.
    const bootstrapOrPromise = composeBootstrap(session);
    const bootstrap =
      typeof bootstrapOrPromise === 'string'
        ? bootstrapOrPromise
        : await bootstrapOrPromise;
    return spawnTerminal(session, options, bootstrap);
  }

  /**
   * Attaches a bounded retry controller for recoverable interactive-session
   * errors. It observes output via a sink, but it NEVER reconstructs replay
   * text from raw keystrokes; browser input only invalidates stale work.
   * Automatic replay happens solely for provider-confirmed replay-safe
   * requests, resent via {@link seedNow} (a programmatic write that bypasses
   * input observation, so a resend cannot invalidate itself). When no
   * confirmation exists, the controller surfaces manual retry guidance instead
   * of pretending the request was healed.
   */
  function attachAutoRetry(
    terminal: TerminalSession,
    session: Session,
    options: LaunchOptions,
  ): void {
    const isTransient = deps.isTransientFailure;
    const selfRecovery = deps.selfRecovery;
    const autoRetry = deps.config.autoRetryEnabled;
    const escalate = selfRecovery?.enabled === true;
    if (
      (!autoRetry && !escalate) ||
      !isTransient ||
      session.kind !== 'dev' ||
      session.scope === 'internal'
    ) {
      return;
    }
    const controller = createSessionAutoRetry({
      isTransient,
      // With auto-retry off but self-recovery on, skip the non-destructive
      // in-session re-submits and escalate straight to analysis + restart.
      maxAttempts: autoRetry ? deps.config.autoRetryMaxAttempts : 0,
      backoffMs: deps.config.autoRetryBackoffMs,
      resubmit: (prompt) => seedNow(terminal, prompt, undefined, currentReplayEpoch(session.id)),
      notify: (text) => terminal.notify(text),
      onExhausted:
        escalate && selfRecovery
          ? ({ prompt, line }) => {
              const epoch = currentReplayEpoch(session.id);
              const isCurrentRequest = () =>
                !stopped &&
                !tombstones.has(session.id) &&
                currentReplayEpoch(session.id) === epoch;
              void work.own(session.id, () => escalateRecovery(
                terminal,
                session,
                selfRecovery,
                prompt,
                line,
                isCurrentRequest,
                options,
              )).catch((error: unknown) => {
                deps.logger.error('Terminal recovery failed', { sessionId: session.id, error });
              });
            }
          : undefined,
    });
    retries.set(session.id, controller);
    terminal.attach({
      send: (data) => controller.observeOutput(data),
      exit: () => controller.dispose(),
    });
  }

  /**
   * Runs the self-recovery escalation ladder once a session's confirmed
   * replay-safe request has spent its in-session re-submit budget: optional
   * metasession analysis, then a last-resort CLI restart replaying that same
   * confirmed request, then a status-bar report if nothing recovered it. Bound
   * to the failing terminal/session so notices land where the user is looking.
   */
  async function escalateRecovery(
    terminal: TerminalSession,
    session: Session,
    selfRecovery: NonNullable<TerminalManagerDeps['selfRecovery']>,
    prompt: string,
    line: string,
    isCurrent: () => boolean,
    options: LaunchOptions,
  ): Promise<void> {
    const analyze = selfRecovery.analyze;
    const coordinatorDeps: SelfRecoveryCoordinatorDeps = {
      useMetaAnalysis: selfRecovery.useMetaAnalysis,
      analyze: analyze
        ? async (errorText) => {
            const diagnosis = await analyze(errorText);
            return isCurrent() ? diagnosis : null;
          }
        : undefined,
      restart: async () => {
        if (!isCurrent()) {
          return true;
        }
        return restartSession(
          terminal,
          session,
          prompt,
          options,
          isCurrent,
        );
      },
      notify: (text) => {
        if (isCurrent()) {
          terminal.notify(text);
        }
      },
      report: (message) => {
        if (isCurrent()) {
          selfRecovery.report(session.id, message);
        }
      },
    };
    await createSelfRecoveryCoordinator(coordinatorDeps).escalate(line);
  }

  /**
   * Last-resort recovery: kills the session's current PTY (suppressing the
   * spurious `failed` snapshot a deliberate teardown would record) and relaunches
   * the CLI in a fresh conversation, replaying the exact confirmed request
   * after any bootstrap context. Resolves true when the relaunch was carried
   * out, false if it threw (so the caller can report the failure to the status
   * bar).
   */
  async function restartSession(
    source: TerminalSession,
    session: Session,
    prompt: string,
    options: LaunchOptions,
    isCurrentRequest: () => boolean,
  ): Promise<boolean> {
    const sourceOwnsSession = () =>
      generations.get(session.id) === source.generation;
    try {
      assertLaunchable(session.id);
      retries.get(session.id)?.dispose();
      retries.delete(session.id);
      publish(session.id, null);
      if (!source.exited) {
        // The fresh launch re-emits session.started, not a failed teardown.
        discarded.add(session.id);
        const exited = awaitExit(source);
        source.kill();
        await exited;
      }
      const finishing = completions.get(session.id);
      if (finishing) await finishing;
      if (!isCurrentRequest() || !sourceOwnsSession()) {
        if (sourceOwnsSession() && !pending.has(session.id)) publish(session.id, null, true);
        return false;
      }
      const bootstrap = await deps.bootstrap.composeForSession(session);
      if (!isCurrentRequest() || !sourceOwnsSession()) {
        if (sourceOwnsSession() && !pending.has(session.id)) publish(session.id, null, true);
        return false;
      }
      let resolve!: (terminal: TerminalSession) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<TerminalSession>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      pending.set(session.id, promise);
      try {
        try {
          resolve(
            spawnTerminal(session, { ...options, replaySeed: prompt }, bootstrap),
          );
        } catch (error) {
          reject(error);
        }
        await promise;
      } finally {
        pending.delete(session.id);
      }
      return true;
    } catch {
      if (isCurrentRequest()) {
        publish(session.id, null, true);
      }
      return false;
    }
  }

  /** Called synchronously while the PTY is live, before requesting its kill. */
  function awaitExit(terminal: TerminalSession): Promise<void> {
    return new Promise((resolve) => {
      const detach = terminal.attach({
        send: () => {},
        exit: () => {
          detach();
          resolve();
        },
      });
    });
  }

  /**
   * Attaches a provider-supplied scanner that reads the tool's terminal output
   * and records each file it announces creating/editing. Feeds raw output so
   * the scanner can strip ANSI per complete line (redraw codes can span
   * chunks). No-op when the provider exposes no scanner.
   */
  function attachOutputScanner(
    terminal: TerminalSession,
    provider: ReturnType<ProviderRegistry['get']>,
    spec: SessionSpec,
  ): void {
    if (!provider.createOutputScanner) {
      return;
    }
    const scanner = provider.createOutputScanner({
      home: deps.home,
      cwd: spec.cwd,
    });
    terminal.attach({
      send: (data) => {
        for (const op of scanner.feed(data)) {
          deps.sessionFiles.record(
            spec.sessionId,
            op.path,
            op.tool,
            deps.clock.isoNow(),
          );
          // Notify clients so the left-panel Files view refreshes live rather
          // than only on remount. Carries just the session id; the UI re-fetches
          // the authoritative list.
          deps.bus.emit('session.file', { sessionId: spec.sessionId });
        }
      },
      exit: () => {},
    });
  }

  /**
   * Attaches a provider-supplied scanner that watches the tool's terminal
   * output for the CLI's own model-change announcements and reports each newly
   * selected model, so the session's resolved model tracks the CLI even before
   * the next usage row is recorded. No-op when the provider exposes no model
   * scanner or the caller tracks no resolved model.
   */
  function attachModelScanner(
    terminal: TerminalSession,
    provider: ReturnType<ProviderRegistry['get']>,
    sessionId: string,
  ): void {
    const onModelResolved = deps.onModelResolved;
    if (!provider.createModelChangeScanner || !onModelResolved) {
      return;
    }
    const scanner = provider.createModelChangeScanner();
    terminal.attach({
      send: (data) => {
        for (const model of scanner.feed(data)) {
          onModelResolved(sessionId, model);
        }
      },
      exit: () => {},
    });
  }

  /**
   * Attaches a provider-supplied scanner that watches the tool's terminal output
   * for MCP server connection failures and raises one IDE-level `session.notice`
   * per failing server. This lets the UI surface the failure (e.g. in the status
   * bar) rather than the user having to spot it scrolling past in the terminal.
   * No-op when the provider exposes no MCP-error scanner.
   */
  function attachMcpErrorScanner(
    terminal: TerminalSession,
    provider: ReturnType<ProviderRegistry['get']>,
    sessionId: string,
  ): void {
    if (!provider.createMcpErrorScanner) {
      return;
    }
    const scanner = provider.createMcpErrorScanner();
    terminal.attach({
      send: (data) => {
        for (const error of scanner.feed(data)) {
          const detail = error.reason ? ` — ${error.reason}` : '';
          deps.bus.emit('session.notice', {
            sessionId,
            level: 'error',
            message: `MCP server "${error.server}" failed to connect${detail}`,
          });
        }
      },
      exit: () => {},
    });
  }

  /**
   * Writes an instruction block into a live terminal and submits it with a
   * separate keystroke once the terminal output has settled. The interactive
   * CLI treats a fast multi-line write as a paste and would absorb an
   * immediately-trailing newline as a line break, so the submit keystroke is
   * sent on its own. Crucially, we wait for a quiet window of *no output* — so
   * the submit lands only after the paste echo (and any in-flight agent
   * response, e.g. when a skill is removed mid-turn) has finished. A max-wait
   * cap guarantees submission even if the CLI never fully stops emitting.
   */
  function seedNow(
    terminal: TerminalSession,
    instructions: string,
    onComplete: () => void = () => {},
    epoch: number | null = null,
  ): void {
    if (epoch !== null && currentReplayEpoch(terminal.sessionId) !== epoch) {
      onComplete();
      return;
    }
    try {
      terminal.write(instructions);
    } catch {
      onComplete();
      return;
    }

    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let detach!: () => void;

    const submit = (): void => {
      clearTimeout(quietTimer);
      clearTimeout(capTimer);
      detach();
      // Suppress the submit if the terminal exited while waiting for quiet.
      if (!terminal.exited && (epoch === null || currentReplayEpoch(terminal.sessionId) === epoch)) {
        try {
          terminal.write(deps.config.instructionSeedSuffix);
        } catch {
          // Input readiness must still settle if the PTY rejects the submit.
        }
      }
      onComplete();
    };

    const arm = (): void => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(submit, deps.config.instructionSeedSubmitDelayMs);
    };

    detach = terminal.attach({
      // Any output (the paste echo, or a streaming agent response) restarts the
      // quiet window, so the submit keystroke only lands once the terminal has
      // gone idle. Removing a skill mid-response therefore still submits.
      send: () => arm(),
      exit: () => submit(),
    });

    const capTimer = setTimeout(
      submit,
      deps.config.instructionSeedSubmitMaxWaitMs,
    );
    arm();
  }

  /**
   * Seeds the instruction block once the interactive CLI's prompt is ready,
   * then submits it with a separate keystroke after a short pause.
   *
   * Two timing hazards make a naive `write(text + Enter)` fail:
   *  - Seeding before the TUI finishes booting lets the submit keystroke be
   *    swallowed during startup, so the text lands in the composer unsent. We
   *    therefore wait for a ready marker in the output (with a timeout
   *    fallback) before seeding.
   *  - The CLI treats a fast multi-line write as a paste and absorbs an
   *    immediately-trailing newline as a line break, so the submit keystroke
   *    is sent on its own once the paste burst settles.
   */
  function seedInstructionsWhenReady(
    terminal: TerminalSession,
    instructions: string,
    onComplete: () => void,
    epoch: number | null,
  ): void {
    const readyPattern = new RegExp(deps.config.instructionSeedReadyPattern);
    let observed = '';
    let detach = (): void => {};
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    let submitted = false;

    const submit = (): void => {
      submitted = true;
      clearTimeout(readyTimer);
      detach();
      seedNow(terminal, instructions, onComplete, epoch);
    };

    detach = terminal.attach({
      send: (data) => {
        observed = (observed + stripAnsi(data)).slice(-READY_SCAN_BYTES);
        if (readyPattern.test(observed)) {
          submit();
        }
      },
      exit: () => {
        clearTimeout(readyTimer);
        detach();
      },
    });

    if (submitted) {
      detach();
    } else {
      readyTimer = setTimeout(
        submit,
        deps.config.instructionSeedReadyTimeoutMs,
      );
    }
  }

  /**
   * Seeds an ordered list of instruction blocks into a freshly-launched CLI: the
   * first waits for the ready marker, and each subsequent block is submitted only
   * once the previous one has settled. Input readiness is marked after the final
   * block, so browser input is unblocked exactly when seeding completes. Used by
   * the self-recovery restart path to re-seed bootstrap context and then replay
   * the user's prompt without the two writes racing.
   */
  function seedSequence(
    terminal: TerminalSession,
    blocks: readonly string[],
    epoch: number | null,
  ): void {
    const seedRest = (index: number): void => {
      if (index >= blocks.length || (epoch !== null && currentReplayEpoch(terminal.sessionId) !== epoch)) {
        terminal.markInputReady();
        return;
      }
      seedNow(terminal, blocks[index], () => seedRest(index + 1), epoch);
    };
    seedInstructionsWhenReady(terminal, blocks[0], () => seedRest(1), epoch);
  }

  async function getOrLaunch(
    session: Session,
    options: LaunchOptions = {},
  ): Promise<TerminalSession> {
    features.set(session.id, session.featureId);
    assertLaunchable(session.id);
    const launching = pending.get(session.id);
    if (launching) return launching;
    const existing = sessions.get(session.id);
    if (existing && !existing.exited) {
      return existing;
    }
    bumpReplayEpoch(session.id);
    let resolve!: (terminal: TerminalSession) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<TerminalSession>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Reserve before launch: internal sessions can emit lifecycle events synchronously.
    pending.set(session.id, promise);
    void work.own(session.id, () => launch(session, options)).then(resolve, reject);
    try {
      return await promise;
    } finally {
      pending.delete(session.id);
    }
  }

  const attempt = (errors: unknown[], action: () => void) => {
    try {
      action();
    } catch (error) {
      errors.push(error);
    }
  };
  const throwTerminationErrors = (errors: unknown[]) => {
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Some terminal termination requests failed');
    }
  };
  const requestTermination = (terminal: TerminalSession, errors: unknown[]) => {
    bumpReplayEpoch(terminal.sessionId);
    attempt(errors, () => retries.get(terminal.sessionId)?.dispose());
    retries.delete(terminal.sessionId);
    attempt(errors, () => terminal.kill());
  };
  const close = (sessionId: string) => {
    tombstones.add(sessionId);
    bumpReplayEpoch(sessionId);
    const errors: unknown[] = [];
    attempt(errors, () => publish(sessionId, null, true));
    const terminal = sessions.get(sessionId);
    if (terminal) {
      discarded.add(sessionId);
      requestTermination(terminal, errors);
    }
    throwTerminationErrors(errors);
  };

  return {
    getOrLaunch,
    get: (sessionId) => sessions.get(sessionId),
    onTerminal(sessionId, listener) {
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(sessionId);
      };
    },
    injectInstructions(sessionId, instructions) {
      // kill closes input immediately, while native exit may arrive later.
      const terminal = sessions.get(sessionId);
      if (!terminal || terminal.inputReadiness === 'closed' || instructions.length === 0) {
        return false;
      }
      bumpReplayEpoch(sessionId);
      retries.get(sessionId)?.confirmReplaySafeRequest('');
      seedNow(terminal, instructions, undefined, currentReplayEpoch(sessionId));
      return true;
    },
    observeInput(sessionId, data) {
      if (data.length > 0) {
        bumpReplayEpoch(sessionId);
      }
      retries.get(sessionId)?.observeInput(data);
    },
    confirmReplaySafeRequest(sessionId, exactText) {
      bumpReplayEpoch(sessionId);
      retries.get(sessionId)?.confirmReplaySafeRequest(exactText);
    },
    close,
    waitForIdle: (timeoutMs) => work.waitForIdle(timeoutMs),
    async quiesceSession(sessionId, timeoutMs) {
      close(sessionId);
      return work.waitForIdle(timeoutMs, (id) => id === sessionId);
    },
    async quiesceFeature(featureId, timeoutMs) {
      blockedFeatures.add(featureId);
      const errors: unknown[] = [];
      for (const [id, feature] of features) {
        if (feature === featureId) attempt(errors, () => close(id));
      }
      throwTerminationErrors(errors);
      return work.waitForIdle(timeoutMs, (id) => features.get(id) === featureId);
    },
    shutdown() {
      stopped = true;
      const errors: unknown[] = [];
      for (const sessionId of listeners.keys()) {
        attempt(errors, () => publish(sessionId, null, true));
      }
      for (const terminal of [...sessions.values()]) requestTermination(terminal, errors);
      throwTerminationErrors(errors);
    },
  };
}

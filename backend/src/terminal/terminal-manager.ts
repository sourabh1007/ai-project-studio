import type { Clock } from '../kernel/clock.js';
import type { EventBus } from '../kernel/event-bus.js';
import type { ProviderRegistry } from '../provider/provider-registry.js';
import type { SessionSpec } from '../provider/provider-contract.js';
import type { Session } from '../session/session-contract.js';
import type { SessionEventMap } from '../session/session-launcher.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { PtySpawner } from './pty-contract.js';
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

/** Max bytes of recent (ANSI-stripped) output scanned for the ready prompt. */
const READY_SCAN_BYTES = 8192;

export interface TerminalManagerDeps {
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
   * Classifies a completed CLI output line as a *transient*, retryable provider
   * failure (upstream 5xx / 429 / network reset). When provided and
   * `config.autoRetryEnabled`, interactive sessions auto-resubmit the user's
   * last prompt on such a failure. Omitted to disable interactive auto-retry.
   */
  isTransientFailure?: (line: string) => boolean;
  /**
   * Enables the self-recovery escalation ladder for interactive dev sessions:
   * once the non-destructive re-submits (see {@link isTransientFailure}) are
   * exhausted on a recoverable error, optionally analyze it via a metasession,
   * then kill and relaunch the CLI in a fresh conversation replaying the user's
   * last prompt, and finally report to the status bar if even that fails.
   * Omitted to disable escalation (only the plain re-submit auto-retry runs).
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
   * A prompt to replay once the freshly-launched CLI is ready, seeded after any
   * bootstrap context. Set only by the self-recovery restart path, so a relaunch
   * re-drives the user's last prompt in a clean conversation.
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
  /**
   * Seeds an instruction block into a session's already-running terminal, as
   * though it were typed and submitted. Used to apply a skill tagged to a live
   * session (session-scoped skills can only be tagged once the session — and
   * thus its terminal — is open, so they are never picked up by launch-time
   * seeding). Returns false when no live terminal exists or the block is empty.
   */
  injectInstructions(sessionId: string, instructions: string): boolean;
  /**
   * Feeds user keystrokes for a live session into its auto-retry controller so
   * the last submitted prompt is tracked. Only browser input should be fed
   * here — programmatic writes (skill seeding, an auto-retry resend) must not,
   * or a resend would be mistaken for a fresh prompt. No-op when the session
   * has no controller (auto-retry disabled or a non-interactive session).
   */
  observeInput(sessionId: string, data: string): void;
  close(sessionId: string): void;
  /**
   * Kills every live terminal without emitting `session.ended` /
   * `session.discarded`. Used for process shutdown, where the goal is to tear
   * down child PTYs promptly rather than record lifecycle transitions.
   */
  shutdown(): void;
}

export function createTerminalManager(
  deps: TerminalManagerDeps,
): TerminalManager {
  const sessions = new Map<string, TerminalSession>();
  // Per-session interactive auto-retry controllers, keyed by session id. Only
  // present for interactive dev sessions when auto-retry is enabled; removed on
  // exit alongside the terminal.
  const retries = new Map<string, SessionAutoRetry>();
  // Last launch options per live session, so the self-recovery restart path can
  // relaunch a session with the same viewport/cwd it was originally opened in.
  const launchOptions = new Map<string, LaunchOptions>();
  // Sessions whose terminals are being killed as part of deletion. Their exit
  // must not be recorded as `session.ended` (which would re-persist the row we
  // are deleting); it is reported as `session.discarded` instead.
  const discarded = new Set<string>();

  async function launch(
    session: Session,
    options: LaunchOptions,
  ): Promise<TerminalSession> {
    // Compose first so repository-context readiness is enforced before any
    // lifecycle event is emitted or provider process is spawned.
    const bootstrap =
      session.kind === 'dev' && session.scope !== 'internal'
        ? await deps.bootstrap.composeForSession(session)
        : '';
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
    deps.bus.emit('session.started', started);

    const command = provider.buildInteractiveCommand(spec);
    const pty = deps.spawner.spawn({
      command: command.command,
      args: command.args,
      env: command.env,
      cwd: options.cwd,
      cols: options.cols ?? deps.config.defaultCols,
      rows: options.rows ?? deps.config.defaultRows,
    });

    // Blocks to seed once the CLI is ready, in order: repository/feature/skill
    // bootstrap first, then any replay prompt from a self-recovery restart.
    const seeds = [bootstrap, options.replaySeed ?? ''].filter(
      (block) => block.length > 0,
    );

    let terminal!: TerminalSession;
    terminal = createTerminalSession({
      sessionId: session.id,
      pty,
      inputReady: seeds.length === 0,
      scrollbackBytes: deps.config.scrollbackBytes,
      transcriptBytes: deps.config.transcriptBytes,
      initialCols: options.cols ?? deps.config.defaultCols,
      initialRows: options.rows ?? deps.config.defaultRows,
      onExit: (code) => {
        sessions.delete(session.id);
        retries.delete(session.id);
        launchOptions.delete(session.id);
        if (discarded.has(session.id)) {
          // Deleted out from under us: drop the terminal without persisting an
          // ended snapshot, but let listeners release the usage tailer.
          discarded.delete(session.id);
          deps.bus.emit('session.discarded', session.id);
          return;
        }
        const ended: Session = {
          ...started,
          status: code === 0 ? 'completed' : 'failed',
          endedAt: deps.clock.isoNow(),
          exitCode: code,
        };
        void deps.transcriptStore.save({
          sessionId: session.id,
          stdout: [terminal.transcriptText()],
          stderr: [],
          exitCode: code,
        });
        deps.bus.emit('session.ended', ended);
      },
    });

    sessions.set(session.id, terminal);
    launchOptions.set(session.id, options);

    // Track files this session creates/edits by parsing the tool's own output.
    // Each PTY is one session, so attribution is unambiguous — unlike watching
    // a shared working directory. Providers without a scanner contribute none.
    attachOutputScanner(terminal, provider, spec);

    // Track mid-session model switches the CLI announces in its output, so the
    // resolved model shown in the UI follows the CLI immediately.
    attachModelScanner(terminal, provider, session.id);

    if (seeds.length > 0) {
      seedSequence(terminal, seeds);
    }

    attachAutoRetry(terminal, session);

    return terminal;
  }

  /**
   * Attaches an auto-retry controller that re-submits the user's last prompt
   * when the interactive CLI reports a transient provider failure. Only wired
   * for interactive dev sessions (a human types prompts there) when a
   * transient classifier is provided and auto-retry is enabled. The controller
   * observes output via a sink, resends via {@link seedNow} (a programmatic
   * write that bypasses input observation, so a resend cannot reset the attempt
   * budget), and surfaces a notice through {@link TerminalSession.notify}.
   */
  function attachAutoRetry(terminal: TerminalSession, session: Session): void {
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
      // re-submits and escalate straight to analysis + restart.
      maxAttempts: autoRetry ? deps.config.autoRetryMaxAttempts : 0,
      backoffMs: deps.config.autoRetryBackoffMs,
      resubmit: (prompt) => seedNow(terminal, prompt),
      notify: (text) => terminal.notify(text),
      onExhausted:
        escalate && selfRecovery
          ? ({ prompt, line }) => {
              void escalateRecovery(
                terminal,
                session,
                selfRecovery,
                prompt,
                line,
              );
            }
          : undefined,
    });
    retries.set(session.id, controller);
    terminal.attach({
      send: (data) => controller.observeOutput(data),
      exit: () => {},
    });
  }

  /**
   * Runs the self-recovery escalation ladder once a session's non-destructive
   * re-submits are spent: optional metasession analysis, then a last-resort CLI
   * restart replaying the prompt, then a status-bar report if nothing recovered
   * it. Bound to the failing terminal/session so notices land where the user is
   * looking.
   */
  async function escalateRecovery(
    terminal: TerminalSession,
    session: Session,
    selfRecovery: NonNullable<TerminalManagerDeps['selfRecovery']>,
    prompt: string,
    line: string,
  ): Promise<void> {
    const coordinatorDeps: SelfRecoveryCoordinatorDeps = {
      useMetaAnalysis: selfRecovery.useMetaAnalysis,
      analyze: selfRecovery.analyze,
      restart: () => restartSession(session, prompt),
      notify: (text) => terminal.notify(text),
      report: (message) => selfRecovery.report(session.id, message),
    };
    await createSelfRecoveryCoordinator(coordinatorDeps).escalate(line);
  }

  /**
   * Last-resort recovery: kills the session's current PTY (suppressing the
   * spurious `failed` snapshot a deliberate teardown would record) and relaunches
   * the CLI in a fresh conversation, replaying the user's last prompt after any
   * bootstrap context. Resolves true when the relaunch was carried out, false if
   * it threw (so the caller can report the failure to the status bar).
   */
  async function restartSession(
    session: Session,
    prompt: string,
  ): Promise<boolean> {
    try {
      const options = launchOptions.get(session.id) ?? {};
      const existing = sessions.get(session.id);
      if (existing && !existing.exited) {
        // Treat the kill as a discard so its exit does not persist a `failed`
        // snapshot; the fresh launch below re-emits `session.started`.
        discarded.add(session.id);
        const exited = awaitExit(existing);
        existing.kill();
        await exited;
      }
      await launch(session, { ...options, replaySeed: prompt });
      return true;
    } catch {
      return false;
    }
  }

  /** Resolves once the terminal's PTY has exited (immediately if already gone). */
  function awaitExit(terminal: TerminalSession): Promise<void> {
    // An already-exited terminal fires the exit sink synchronously on attach, so
    // this resolves immediately in that case without a special-cased guard.
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
  ): void {
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
      if (!terminal.exited) {
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
      seedNow(terminal, instructions, onComplete);
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
  ): void {
    const seedRest = (index: number): void => {
      if (index >= blocks.length) {
        terminal.markInputReady();
        return;
      }
      seedNow(terminal, blocks[index], () => seedRest(index + 1));
    };
    seedInstructionsWhenReady(terminal, blocks[0], () => seedRest(1));
  }

  return {
    async getOrLaunch(session, options = {}) {
      const existing = sessions.get(session.id);
      if (existing && !existing.exited) {
        return existing;
      }
      return await launch(session, options);
    },
    get: (sessionId) => sessions.get(sessionId),
    injectInstructions(sessionId, instructions) {
      // A terminal is only in the map while live (its exit handler removes it),
      // so a found terminal is always writable.
      const terminal = sessions.get(sessionId);
      if (!terminal || instructions.length === 0) {
        return false;
      }
      seedNow(terminal, instructions);
      return true;
    },
    observeInput(sessionId, data) {
      retries.get(sessionId)?.observeInput(data);
    },
    close(sessionId) {
      // A terminal is only in the map while live: its exit handler removes it.
      // So a found terminal is always killable, and killing it during deletion
      // is reported as `session.discarded` (never `session.ended`).
      const terminal = sessions.get(sessionId);
      if (!terminal) {
        return;
      }
      discarded.add(sessionId);
      terminal.kill();
    },
    shutdown() {
      for (const terminal of sessions.values()) {
        discarded.add(terminal.sessionId);
        terminal.kill();
      }
    },
  };
}

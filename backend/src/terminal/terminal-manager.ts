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
  /** User home directory, for a scanner to expand `~`-relative tool paths. */
  home: string;
}

export interface LaunchOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
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

    let terminal!: TerminalSession;
    terminal = createTerminalSession({
      sessionId: session.id,
      pty,
      inputReady: bootstrap.length === 0,
      scrollbackBytes: deps.config.scrollbackBytes,
      transcriptBytes: deps.config.transcriptBytes,
      onExit: (code) => {
        sessions.delete(session.id);
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

    // Track files this session creates/edits by parsing the tool's own output.
    // Each PTY is one session, so attribution is unambiguous — unlike watching
    // a shared working directory. Providers without a scanner contribute none.
    attachOutputScanner(terminal, provider, spec);

    if (bootstrap.length > 0) {
      seedInstructionsWhenReady(terminal, bootstrap);
    }

    return terminal;
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
      seedNow(terminal, instructions, () => terminal.markInputReady());
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

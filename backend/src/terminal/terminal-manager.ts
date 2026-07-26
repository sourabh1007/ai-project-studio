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

/** Max bytes of recent (ANSI-stripped) output scanned for the ready prompt. */
const READY_SCAN_BYTES = 8192;

/** Supplies the composed instruction block to seed into an interactive session. */
export interface SessionInstructionsProvider {
  instructionsForSession(sessionId: string): string;
}

export interface TerminalManagerDeps {
  spawner: PtySpawner;
  providers: ProviderRegistry;
  bus: EventBus<SessionEventMap>;
  clock: Clock;
  config: TerminalConfig;
  transcriptStore: TranscriptStore;
  skills: SessionInstructionsProvider;
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
  getOrLaunch(session: Session, options?: LaunchOptions): TerminalSession;
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
}

export function createTerminalManager(
  deps: TerminalManagerDeps,
): TerminalManager {
  const sessions = new Map<string, TerminalSession>();
  // Sessions whose terminals are being killed as part of deletion. Their exit
  // must not be recorded as `session.ended` (which would re-persist the row we
  // are deleting); it is reported as `session.discarded` instead.
  const discarded = new Set<string>();

  function launch(session: Session, options: LaunchOptions): TerminalSession {
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
      scrollbackBytes: deps.config.scrollbackBytes,
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

    // Seed the effective instruction skills as the first input so the
    // interactive AI follows them. Meta sessions carry no user skills.
    if (session.kind !== 'meta') {
      const instructions = deps.skills.instructionsForSession(session.id);
      if (instructions.length > 0) {
        seedInstructionsWhenReady(terminal, instructions);
      }
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
   * separate keystroke after the paste burst settles. The interactive CLI
   * treats a fast multi-line write as a paste and would absorb an
   * immediately-trailing newline as a line break, so the submit keystroke is
   * sent on its own once the write has settled.
   */
  function seedNow(terminal: TerminalSession, instructions: string): void {
    terminal.write(instructions);
    setTimeout(() => {
      if (!terminal.exited) {
        terminal.write(deps.config.instructionSeedSuffix);
      }
    }, deps.config.instructionSeedSubmitDelayMs);
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
    // Assigned before `submit` can run: the terminal was just spawned, so its
    // scrollback is empty and `attach` replays nothing synchronously.
    let detach!: () => void;
    let readyTimer!: ReturnType<typeof setTimeout>;

    const submit = (): void => {
      clearTimeout(readyTimer);
      detach();
      seedNow(terminal, instructions);
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
      },
    });

    readyTimer = setTimeout(
      submit,
      deps.config.instructionSeedReadyTimeoutMs,
    );
  }

  return {
    getOrLaunch(session, options = {}) {
      const existing = sessions.get(session.id);
      if (existing && !existing.exited) {
        return existing;
      }
      return launch(session, options);
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
  };
}

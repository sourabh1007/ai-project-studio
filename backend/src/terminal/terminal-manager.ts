import type { Clock } from '../kernel/clock.js';
import type { EventBus } from '../kernel/event-bus.js';
import type { ProviderRegistry } from '../provider/provider-registry.js';
import type { SessionSpec } from '../provider/provider-contract.js';
import type { Session } from '../session/session-contract.js';
import type { SessionEventMap } from '../session/session-launcher.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { PtySpawner } from './pty-contract.js';
import type { TerminalConfig } from './config.js';
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
  close(sessionId: string): void;
}

export function createTerminalManager(
  deps: TerminalManagerDeps,
): TerminalManager {
  const sessions = new Map<string, TerminalSession>();

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
      terminal.write(instructions);
      setTimeout(() => {
        if (!terminal.exited) {
          terminal.write(deps.config.instructionSeedSuffix);
        }
      }, deps.config.instructionSeedSubmitDelayMs);
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
    close(sessionId) {
      const terminal = sessions.get(sessionId);
      if (terminal) {
        terminal.kill();
      }
    },
  };
}

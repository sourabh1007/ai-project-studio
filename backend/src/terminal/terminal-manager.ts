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
        terminal.write(`${instructions}${deps.config.instructionSeedSuffix}`);
      }
    }

    return terminal;
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

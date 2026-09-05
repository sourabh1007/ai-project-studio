import {
  encodeRequest,
  parseMessage,
  sessionIdOf,
  stopReasonOf,
  textFromUpdate,
} from './acp-protocol.js';

/**
 * The minimal process surface the ACP client drives: a live `copilot --acp`
 * child. Kept as a port so the client is unit-tested against a fake while the
 * real child-process wiring lives in an IO adapter.
 */
export interface AcpProcess {
  /** Writes one newline-terminated JSON-RPC line to the process stdin. */
  write(line: string): void;
  /** Registers a handler for each complete stdout line. */
  onLine(handler: (line: string) => void): void;
  /** Registers a handler invoked once when the process exits. */
  onExit(handler: (code: number | null) => void): void;
  /** Terminates the process. */
  kill(): void;
}

export interface AcpClientConfig {
  /** Timeout (ms) for the one-time `initialize` handshake. */
  initializeTimeoutMs: number;
  /** Timeout (ms) for a single `session/new` or `session/prompt` request. */
  turnTimeoutMs: number;
}

/** Token accounting reported by a completed turn, when present. */
export interface AcpUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AcpTurnRequest {
  /** The full prompt text; delivered inline (ACP has no argv length limit). */
  prompt: string;
  /** Working directory for the session. */
  cwd?: string;
  /** Invoked with each streamed assistant text chunk as the turn runs. */
  onActivity?: (text: string) => void;
}

export interface AcpTurnResult {
  text: string;
  sessionId: string;
  stopReason: string | null;
  usage: AcpUsage | null;
}

interface Pending {
  resolve: (result: Record<string, unknown> | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveTurn {
  text: string;
  onActivity?: (text: string) => void;
}

function usageOf(result: Record<string, unknown> | null): AcpUsage | null {
  const usage =
    result && typeof result.usage === 'object' && result.usage !== null
      ? (result.usage as Record<string, unknown>)
      : null;
  if (!usage) {
    return null;
  }
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (typeof input !== 'number' || typeof output !== 'number') {
    return null;
  }
  return { inputTokens: input, outputTokens: output };
}

/**
 * Drives one live `copilot --acp` process over JSON-RPC. The process boots once
 * via {@link AcpClient.initialize}; thereafter every {@link AcpClient.runTurn}
 * creates a fresh session and submits a single prompt, resolving when the
 * agent's `session/prompt` response arrives — so the heavy CLI startup is paid
 * once and each turn is cheap. A client serves one turn at a time (the pool
 * leases it exclusively), so a single in-flight turn accumulates streamed text.
 */
export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private active: ActiveTurn | null = null;
  private dead: Error | null = null;
  private exitHandlers: (() => void)[] = [];

  constructor(
    private readonly process: AcpProcess,
    private readonly config: AcpClientConfig,
  ) {
    this.process.onLine((line) => this.handleLine(line));
    this.process.onExit(() => this.handleExit());
  }

  /** True until the underlying process has exited. */
  get alive(): boolean {
    return this.dead === null;
  }

  /** Registers a callback fired when the process exits (for pool replenish). */
  onExit(handler: () => void): void {
    this.exitHandlers.push(handler);
  }

  /** Performs the one-time ACP handshake; must resolve before any turn. */
  async initialize(): Promise<void> {
    await this.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      },
      this.config.initializeTimeoutMs,
    );
  }

  /**
   * Creates a fresh ACP session and returns the raw `session/new` result. The
   * result carries not only the new session id but the CLI's advertised model
   * catalog (`models.availableModels`), which the model-catalog probe reads.
   */
  async newSession(cwd?: string): Promise<Record<string, unknown> | null> {
    return this.request(
      'session/new',
      { cwd, mcpServers: [] },
      this.config.turnTimeoutMs,
    );
  }

  /** Runs a single prompt as a fresh session and returns its response text. */
  async runTurn(request: AcpTurnRequest): Promise<AcpTurnResult> {
    const created = await this.newSession(request.cwd);
    const sessionId = sessionIdOf(created);
    if (!sessionId) {
      throw new Error('ACP session/new returned no session id');
    }
    this.active = { text: '', onActivity: request.onActivity };
    try {
      const result = await this.request(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: request.prompt }],
        },
        this.config.turnTimeoutMs,
      );
      return {
        text: this.active.text,
        sessionId,
        stopReason: stopReasonOf(result),
        usage: usageOf(result),
      };
    } finally {
      this.active = null;
    }
  }

  /** Kills the process; pending requests reject via the exit handler. */
  kill(): void {
    this.process.kill();
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> {
    if (this.dead) {
      return Promise.reject(this.dead);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      this.pending.set(id, { resolve, reject, timer });
      this.process.write(encodeRequest(id, method, params));
    });
  }

  private handleLine(line: string): void {
    const message = parseMessage(line);
    if (!message) {
      return;
    }
    if (message.kind === 'notification') {
      if (message.method === 'session/update' && this.active) {
        const text = textFromUpdate(message.params);
        if (text !== null) {
          this.active.text += text;
          this.active.onActivity?.(text);
        }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new Error(`ACP error ${message.error.code}: ${message.error.message}`),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private handleExit(): void {
    if (this.dead) {
      return;
    }
    this.dead = new Error('ACP process exited');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.dead);
    }
    this.pending.clear();
    for (const handler of this.exitHandlers) {
      handler();
    }
  }
}

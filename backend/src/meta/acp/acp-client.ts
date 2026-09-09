import {
  encodeNotification,
  encodeRequest,
  parseMessage,
  sessionIdFromUpdate,
  sessionIdOf,
  stateFromUpdate,
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
  /** Most recent bounded/sanitized stderr diagnostic, when available. */
  diagnostic?(): string | null;
  /** Terminates the process. */
  kill(): void;
}

export interface AcpClientConfig {
  /** Timeout (ms) for the one-time `initialize` handshake. */
  initializeTimeoutMs: number;
  /** Timeout (ms) for a single `session/new` or `session/prompt` request. */
  turnTimeoutMs: number;
  /** Grace period (ms) to wait for cancellation before killing the process. */
  cancelGraceMs?: number;
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
  /** Internal absolute deadline (epoch ms) carried across ACP stages. */
  deadlineAt?: number;
  /** Pool callback fired once the turn really begins running. */
  onStart?: () => void;
  /** Overall turn timeout budget used to build deadline-based errors. */
  timeoutMs?: number;
  /** Optional cancellation signal observed by the warm-pool wrapper. */
  signal?: AbortSignal;
  /** Invoked with each streamed assistant text chunk as the turn runs. */
  onActivity?: (text: string) => void;
}

export interface AcpTurnResult {
  text: string;
  sessionId: string;
  stopReason: string | null;
  usage: AcpUsage | null;
}

export class AcpRequestError extends Error {
  readonly method: string;
  readonly allowFallbackToCold: boolean;

  constructor(
    message: string,
    options: { method: string; allowFallbackToCold: boolean; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = 'AcpRequestError';
    this.method = options.method;
    this.allowFallbackToCold = options.allowFallbackToCold;
  }
}

interface Pending {
  method: string;
  allowFallbackToCold: boolean;
  resolve: (result: Record<string, unknown> | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveTurn {
  generation: number;
  sessionId: string;
  requestId: number | null;
  text: string;
  acceptingActivity: boolean;
  onActivity?: (text: string) => void;
}

interface Disposal {
  generation: number;
  sessionId: string;
  requestId: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_CANCEL_GRACE_MS = 1_000;

/** Bounds on retained non-protocol stdout: enough to diagnose, never a leak. */
const MAX_UNPARSED_LINES = 5;
const MAX_UNPARSED_LINE_CHARACTERS = 200;
const MAX_UNPARSED_CHARACTERS = 1_000;

function remainingTimeout(deadlineAt: number | undefined, fallbackMs: number): number {
  if (deadlineAt === undefined) {
    return fallbackMs;
  }
  return Math.max(1, deadlineAt - Date.now());
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
  private turnGeneration = 0;
  private readonly pending = new Map<number, Pending>();
  private active: ActiveTurn | null = null;
  private disposal: Disposal | null = null;
  private dead: Error | null = null;
  private reusableState = true;
  private exitHandlers: (() => void)[] = [];
  /** True once any valid ACP message has been read from this process. */
  private spokeProtocol = false;
  /** Bounded tail of stdout lines that were not ACP messages. */
  private unparsed: string[] = [];
  private unparsedCharacters = 0;

  constructor(
    private readonly process: AcpProcess,
    private readonly config: AcpClientConfig,
  ) {
    this.process.onLine((line) => this.handleLine(line));
    this.process.onExit((code) => this.handleExit(code));
  }

  /** True until the underlying process has exited. */
  get alive(): boolean {
    return this.dead === null;
  }

  /** True while the client may safely be leased for another warm turn. */
  get reusable(): boolean {
    return this.reusableState && this.disposal === null && this.dead === null;
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
      { allowFallbackToCold: true, onTimeout: () => this.dispose() },
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
      { allowFallbackToCold: true, onTimeout: () => this.dispose() },
    );
  }

  /** Runs a single prompt as a fresh session and returns its response text. */
  async runTurn(request: AcpTurnRequest): Promise<AcpTurnResult> {
    const created = await this.request(
      'session/new',
      { cwd: request.cwd, mcpServers: [] },
      remainingTimeout(request.deadlineAt, this.config.turnTimeoutMs),
      { allowFallbackToCold: true, onTimeout: () => this.dispose() },
    );
    const sessionId = sessionIdOf(created);
    if (!sessionId) {
      this.dispose();
      throw new AcpRequestError('ACP session/new returned no session id', {
        method: 'session/new',
        allowFallbackToCold: true,
      });
    }
    const turn: ActiveTurn = {
      generation: ++this.turnGeneration,
      sessionId,
      requestId: null,
      text: '',
      acceptingActivity: true,
      onActivity: request.onActivity,
    };
    this.active = turn;
    try {
      const result = await this.request(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: request.prompt }],
        },
        remainingTimeout(request.deadlineAt, this.config.turnTimeoutMs),
        {
          allowFallbackToCold: false,
          onDispatch: (id) => {
            turn.requestId = id;
          },
          onTimeout: () => this.disposeTurn(turn),
        },
      );
      return {
        text: turn.text,
        sessionId,
        stopReason: stopReasonOf(result),
        usage: usageOf(result),
      };
    } finally {
      if (this.active?.generation === turn.generation) {
        this.active = null;
      }
    }
  }

  /** Kills the process; pending requests reject via the exit handler. */
  kill(): void {
    this.reusableState = false;
    this.process.kill();
  }

  /** Cancels/kills the process so it cannot be reused for another warm turn. */
  dispose(): void {
    this.reusableState = false;
    if (this.dead || this.disposal) {
      return;
    }
    const active = this.active;
    if (active) {
      this.disposeTurn(active);
      return;
    }
    this.process.kill();
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    options: {
      allowFallbackToCold: boolean;
      onDispatch?: (id: number) => void;
      onTimeout?: () => void;
    },
  ): Promise<Record<string, unknown> | null> {
    if (this.dead) {
      return Promise.reject(this.dead);
    }
    if (!this.reusableState || this.disposal) {
      return Promise.reject(new Error('ACP client is not reusable'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        options.onTimeout?.();
        reject(
          this.requestError(
            `ACP ${method} timed out after ${timeoutMs}ms${this.diagnosticSuffix()}`,
            method,
            options.allowFallbackToCold,
          ),
        );
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      this.pending.set(id, {
        method,
        allowFallbackToCold: options.allowFallbackToCold,
        resolve,
        reject,
        timer,
      });
      options.onDispatch?.(id);
      try {
        this.process.write(encodeRequest(id, method, params));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.dispose();
        reject(
          this.requestError(
            `ACP ${method} could not be written${this.diagnosticSuffix()}`,
            method,
            options.allowFallbackToCold,
            error,
          ),
        );
      }
    });
  }

  private handleLine(line: string): void {
    const message = parseMessage(line);
    if (!message) {
      this.recordUnparsedLine(line);
      return;
    }
    this.spokeProtocol = true;
    this.unparsed = [];
    this.unparsedCharacters = 0;
    if (message.kind === 'notification') {
      if (message.method === 'session/update') {
        const sessionId = sessionIdFromUpdate(message.params);
        if (
          this.active &&
          sessionId === this.active.sessionId &&
          this.active.acceptingActivity &&
          !(
            this.disposal &&
            this.disposal.generation === this.active.generation &&
            this.disposal.sessionId === sessionId
          )
        ) {
          const text = textFromUpdate(message.params);
          if (text !== null) {
            this.active.text += text;
            this.active.onActivity?.(text);
          }
        }
        const state = stateFromUpdate(message.params);
        if (
          this.disposal &&
          sessionId === this.disposal.sessionId &&
          state &&
          (state.stopReason === 'cancelled' || state.state === 'idle')
        ) {
          this.finishDisposal();
        }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      if (this.disposal && this.disposal.requestId === message.id) {
        this.finishDisposal();
      }
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      if (pending.method === 'session/prompt') {
        const active = this.active;
        if (active && active.requestId === message.id) {
          this.disposeTurn(active);
        } else {
          this.dispose();
        }
      } else {
        this.dispose();
      }
      pending.reject(
        this.requestError(
          `ACP error ${message.error.code}: ${message.error.message}${this.diagnosticSuffix()}`,
          pending.method,
          pending.allowFallbackToCold,
        ),
      );
      return;
    }
    pending.resolve(message.result);
    if (this.disposal && this.disposal.requestId === message.id) {
      this.finishDisposal();
    }
  }

  private handleExit(code: number | null): void {
    if (this.dead) {
      return;
    }
    this.reusableState = false;
    if (this.disposal?.timer) {
      clearTimeout(this.disposal.timer);
    }
    this.disposal = null;
    const message = `ACP process exited${
      code === null ? '' : ` (exit code ${code})`
    }${this.diagnosticSuffix()}`;
    this.dead = new Error(message);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        this.requestError(message, pending.method, pending.allowFallbackToCold),
      );
    }
    this.pending.clear();
    for (const handler of this.exitHandlers) {
      handler();
    }
  }

  private requestError(
    message: string,
    method: string,
    allowFallbackToCold: boolean,
    cause?: unknown,
  ): AcpRequestError {
    return new AcpRequestError(message, { method, allowFallbackToCold, cause });
  }

  private diagnosticSuffix(): string {
    const parts: string[] = [];
    const diagnostic = this.process.diagnostic?.();
    if (diagnostic) parts.push(diagnostic);
    // Non-protocol stdout is the only evidence available when a CLI answers an
    // auth prompt, prints an upgrade banner or crashes instead of speaking ACP.
    // Without it the turn just reports a timeout and the real cause is lost.
    if (this.unparsed.length > 0) {
      parts.push(`unexpected output: ${this.unparsed.join(' / ')}`);
    }
    return parts.length > 0 ? `: ${parts.join('; ')}` : '';
  }

  /**
   * Keeps a bounded tail of stdout that was not an ACP message, and fails the
   * process fast when it has never spoken ACP at all. A binary that is not an
   * ACP agent (wrong version, an interactive prompt, an error banner) would
   * otherwise hang every request for its full timeout and report nothing
   * actionable. Once a single valid message is seen the process is known to
   * speak the protocol, so later chatter is only ever retained as diagnostics.
   */
  private recordUnparsedLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0 || this.dead) {
      return;
    }
    const clipped = trimmed.slice(0, MAX_UNPARSED_LINE_CHARACTERS);
    this.unparsed.push(clipped);
    this.unparsedCharacters += clipped.length;
    while (
      this.unparsed.length > MAX_UNPARSED_LINES ||
      this.unparsedCharacters > MAX_UNPARSED_CHARACTERS
    ) {
      this.unparsedCharacters -= this.unparsed.shift()!.length;
    }
    if (
      !this.spokeProtocol &&
      this.pending.size > 0 &&
      this.unparsed.length >= MAX_UNPARSED_LINES
    ) {
      this.failProtocol();
    }
  }

  /** Fails every in-flight request because the process is not an ACP agent. */
  private failProtocol(): void {
    const message = `ACP process did not speak the protocol${this.diagnosticSuffix()}`;
    this.reusableState = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      // Cold fallback is allowed: the prompt itself is fine, this process is not.
      pending.reject(this.requestError(message, pending.method, true));
    }
    this.pending.clear();
    this.dispose();
  }

  private disposeTurn(turn: ActiveTurn): void {
    this.reusableState = false;
    turn.acceptingActivity = false;
    if (this.dead || this.disposal) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    this.disposal = {
      generation: turn.generation,
      sessionId: turn.sessionId,
      requestId: turn.requestId,
      timer,
    };
    try {
      this.process.write(
        encodeNotification('session/cancel', { sessionId: turn.sessionId }),
      );
    } catch {
      this.finishDisposal();
      return;
    }
    timer = setTimeout(() => {
      this.finishDisposal();
    }, this.config.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.disposal.timer = timer;
  }

  private finishDisposal(): void {
    if (!this.disposal) {
      return;
    }
    if (this.disposal.timer) {
      clearTimeout(this.disposal.timer);
    }
    this.disposal = null;
    try {
      this.process.kill();
    } catch {
      // Best effort: keep the client quarantined until an actual exit arrives.
    }
  }
}

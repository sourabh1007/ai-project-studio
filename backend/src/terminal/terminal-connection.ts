import type { ClientMessage, ServerMessage, TerminalState } from './terminal-protocol.js';
import type { TerminalSession } from './terminal-session.js';
import { terminalDefaults } from './config.js';
import type { ConfirmCheckoutRecovery } from '../session-worktree/checkout-recovery.js';
import type { SelectSessionWorktree } from '../session-worktree/session-ref-resolver.js';

interface ConnectionDeps {
  launch(report: (message: string) => void, signal: AbortSignal, confirm: ConfirmCheckoutRecovery, select: SelectSessionWorktree): Promise<TerminalSession>;
  subscribe(listener: (terminal: TerminalSession | null, failed?: boolean) => void): () => void;
  observeInput(data: string): void;
  send(message: ServerMessage): void;
  inputLimit: number;
  launchTimeoutMs?: number;
}

type Input = Extract<ClientMessage, { type: 'input' }>;

/** One socket's ordered input ownership; never replays across a PTY generation. */
export function createTerminalConnection(deps: ConnectionDeps) {
  let connected = true;
  const controller = new AbortController();
  let launchTimer: ReturnType<typeof setTimeout> | undefined;
  let terminal: TerminalSession | undefined;
  let generation = 0;
  let state: TerminalState = 'connecting';
  let lastSeq = 0;
  let queue: Input[] = [];
  let bytes = 0;
  let geometry: Extract<ClientMessage, { type: 'resize' }> | undefined;
  let detach = () => {};
  let detachReadiness = () => {};
  let recoveryId = 0;
  let recovery: { id: number; settle(approved: boolean): void } | undefined;
  let selectionId = 0;
  let selection: { id: number; settle(choiceId: string | null): void } | undefined;
  const selectWorktree: SelectSessionWorktree = (choices) => {
    if (!connected || controller.signal.aborted || generation !== 0 || recovery || selection) return Promise.resolve(null);
    rejectQueue('Choose a worktree first; queued input was not replayed.');
    return new Promise<string | null>((resolve) => {
      const cancel = () => settle(null);
      const settle = (choiceId: string | null) => {
        controller.signal.removeEventListener('abort', cancel);
        selection = undefined;
        resolve(choiceId);
      };
      selection = { id: ++selectionId, settle };
      controller.signal.addEventListener('abort', cancel, { once: true });
      deps.send({ type: 'worktree-selection', requestId: selection.id, choices });
    });
  };
  const confirmRecovery: ConfirmCheckoutRecovery = (detail) => {
    if (!connected || controller.signal.aborted || generation !== 0 || recovery || selection) return Promise.resolve(false);
    rejectQueue('Checkout recovery requires confirmation; queued input was not replayed.');
    return new Promise<boolean>((resolve) => {
      const cancel = () => settle(false);
      const settle = (approved: boolean) => {
        controller.signal.removeEventListener('abort', cancel);
        recovery = undefined;
        resolve(approved);
      };
      recovery = { id: ++recoveryId, settle };
      controller.signal.addEventListener('abort', cancel, { once: true });
      deps.send({ type: 'checkout-recovery', requestId: recovery.id, detail });
    });
  };
  const setState = (next: TerminalState, detail?: string) => {
    state = next;
    deps.send({ type: 'state', version: 2, generation, state, inputLimit: deps.inputLimit, heartbeat: true, ...(detail ? { detail } : {}) });
  };
  const ack = (input: Input, outcome: 'written' | 'rejected' | 'uncertain', reason = '') =>
    deps.send({ type: 'ack', seq: input.seq, generation: input.generation, outcome, reason });
  const rejectQueue = (reason: string) => {
    for (const input of queue) ack(input, 'rejected', reason);
    queue = [];
    bytes = 0;
  };
  const fail = (reason: string) => {
    rejectQueue(reason);
    setState('failed', reason);
  };
  const write = (input: Input) => {
    try {
      terminal!.write(input.data);
    } catch {
      ack(input, 'uncertain', 'PTY write failed; input may have been partially executed. Not replayed.');
      fail('Input stopped after a write failure.');
      return false;
    }
    ack(input, 'written');
    return true;
  };
  const resize = () => {
    if (!geometry) return;
    try {
      terminal!.resize(geometry.cols, geometry.rows);
      geometry = undefined;
    } catch {
      fail('Terminal resize failed.');
    }
  };
  const bind = (next: TerminalSession | null, failed?: boolean) => {
    if (!connected || controller.signal.aborted || (next && next.generation <= generation)) return;
    detach();
    detachReadiness();
    if (generation !== 0) {
      rejectQueue('Terminal generation changed; unsent input was not replayed.');
      geometry = undefined;
    }
    terminal = next ?? undefined;
    if (!next) {
      setState(failed || state === 'failed' ? 'failed' : 'reconnecting');
      return;
    }
    generation = next.generation;
    setState(state === 'failed' ? 'failed' : 'bootstrapping');
    detach = next.attach({
      suppressible: true,
      send: (data) => deps.send({ type: 'output', data }),
      resize: (cols, rows) => deps.send({ type: 'resize', cols, rows }),
      exit: (code) => deps.send({ type: 'exit', code }),
    });
    detachReadiness = next.onInputReadiness((readiness) => {
      if (readiness === 'closed') {
        rejectQueue('Terminal closed before input could be written.');
        setState('closed');
      } else if (state !== 'failed') {
        resize();
        if ((state as TerminalState) === 'failed') return;
        setState('ready');
        const buffered = queue;
        queue = [];
        bytes = 0;
        for (let index = 0; index < buffered.length; index++) {
          if (!write(buffered[index])) {
            for (const input of buffered.slice(index + 1)) ack(input, 'rejected', 'Input stopped after a write failure.');
            break;
          }
        }
      }
    });
  };
  const unsubscribe = deps.subscribe(bind);
  setState('connecting');
  return {
    async start() {
      launchTimer = setTimeout(() => {
        controller.abort();
        if (connected) fail('Terminal startup timed out. Reconnect to check preparation; no input will be replayed.');
      }, deps.launchTimeoutMs ?? terminalDefaults.launchTimeoutMs);
      try {
        bind(await deps.launch((message) => {
          if (connected && !controller.signal.aborted) setState(state, message);
        }, controller.signal, confirmRecovery, selectWorktree));
      } catch (error) {
        if (connected && !controller.signal.aborted) fail(error instanceof Error ? error.message : 'Terminal launch failed.');
      } finally {
        recovery?.settle(false);
        selection?.settle(null);
        clearTimeout(launchTimer);
      }
    },
    receive(message: ClientMessage) {
      if (!connected) return;
      if (message.type === 'ping') {
        deps.send({ type: 'pong', generation, seq: message.seq });
        return;
      }
      const current = message.generation === generation;
      if (message.type === 'worktree-selection') {
        if (current && selection?.id === message.requestId) selection.settle(message.choiceId);
        return;
      }
      if (message.type === 'checkout-recovery') {
        if (current && recovery?.id === message.requestId) recovery.settle(message.approved);
        return;
      }
      if (message.type === 'resize') {
        if (!current || state === 'closed' || state === 'failed' || state === 'reconnecting') return;
        geometry = message;
        if (state === 'ready') resize();
        return;
      }
      if (message.seq <= lastSeq) {
        ack(message, 'uncertain', 'Duplicate or out-of-order input; original may have executed. Not replayed.');
        return;
      }
      lastSeq = message.seq;
      // New user intent cancels older recovery even while PTY writes are blocked.
      if (current) deps.observeInput(message.data);
      if (!current || recovery || selection || state === 'closed' || state === 'failed' || state === 'reconnecting') {
        ack(message, 'rejected', 'Input does not belong to a writable terminal generation.');
        return;
      }
      if (Buffer.byteLength(message.data) > deps.inputLimit - bytes) {
        ack(message, 'rejected', 'Input limit exceeded. Entire queued input rejected; clear the CLI composer before retrying.');
        fail('Input limit exceeded; queued input and subsequent submit rejected.');
        return;
      }
      if (state === 'ready') write(message);
      else {
        queue.push(message);
        bytes += Buffer.byteLength(message.data);
      }
    },
    close() {
      connected = false;
      clearTimeout(launchTimer);
      controller.abort();
      queue = [];
      bytes = 0;
      unsubscribe();
      detachReadiness();
      detach();
    },
  };
}

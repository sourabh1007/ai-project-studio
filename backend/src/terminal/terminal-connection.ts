import type { ClientMessage, ServerMessage, TerminalState } from './terminal-protocol.js';
import type { TerminalSession } from './terminal-session.js';

interface ConnectionDeps {
  launch(): Promise<TerminalSession>;
  subscribe(listener: (terminal: TerminalSession | null, failed?: boolean) => void): () => void;
  observeInput(data: string): void;
  send(message: ServerMessage): void;
  inputLimit: number;
}

type Input = Extract<ClientMessage, { type: 'input' }>;

/** One socket's ordered input ownership; never replays across a PTY generation. */
export function createTerminalConnection(deps: ConnectionDeps) {
  let connected = true;
  let terminal: TerminalSession | undefined;
  let generation = 0;
  let state: TerminalState = 'connecting';
  let lastSeq = 0;
  let queue: Input[] = [];
  let bytes = 0;
  let geometry: Extract<ClientMessage, { type: 'resize' }> | undefined;
  let detach = () => {};
  let detachReadiness = () => {};
  const setState = (next: TerminalState) => {
    state = next;
    deps.send({ type: 'state', version: 2, generation, state, inputLimit: deps.inputLimit });
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
    setState('failed');
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
    if (!connected || (next && next.generation <= generation)) return;
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
      try {
        bind(await deps.launch());
      } catch {
        if (connected) fail('Terminal launch failed.');
      }
    },
    receive(message: ClientMessage) {
      if (!connected) return;
      const current = message.generation === generation;
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
      if (!current || state === 'closed' || state === 'failed' || state === 'reconnecting') {
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
      queue = [];
      bytes = 0;
      unsubscribe();
      detachReadiness();
      detach();
    },
  };
}

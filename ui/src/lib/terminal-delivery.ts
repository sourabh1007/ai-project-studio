import type { ClientMessage, ServerMessage, TerminalState } from './terminal-protocol.js';

interface DeliveryDeps {
  send(message: ClientMessage): void;
  status(state: TerminalState, notice: string): void;
}

/** Holds only this connection's input. An acknowledgement means PTY write, not command completion. */
export function createTerminalDelivery(deps: DeliveryDeps) {
  let state: TerminalState = 'connecting';
  let generation = 0;
  let seq = 0;
  let limit = 65536;
  let queue: string[] = [];
  const pending = new Map<number, number>();
  let bytes = 0;
  let notice = '';
  let geometry: { cols: number; rows: number } | undefined;
  let sentGeometry = '';
  const report = () => deps.status(state, notice);
  const discard = (reason: string) => {
    if (pending.size || queue.length) {
      notice = `${reason} ${queue.length} unsent input frame(s) discarded; ${pending.size} unacknowledged frame(s) may have executed. Nothing replayed.`;
    }
    queue = [];
    pending.clear();
    bytes = 0;
  };
  const fail = (reason: string) => {
    discard(reason);
    notice = reason + (notice ? ` ${notice}` : '');
    state = 'failed';
    report();
  };
  const flush = () => {
    if (state !== 'ready') return;
    try {
      if (geometry) {
        const key = `${generation}:${geometry.cols}:${geometry.rows}`;
        if (key !== sentGeometry) {
          deps.send({ type: 'resize', ...geometry, generation });
          sentGeometry = key;
        }
      }
      while (queue.length) {
        const data = queue.shift()!;
        const id = ++seq;
        pending.set(id, new TextEncoder().encode(data).length);
        deps.send({ type: 'input', data, generation, seq: id });
      }
    } catch {
      fail('Connection write failed. Clear the CLI composer before retrying.');
    }
  };
  return {
    offer(data: string) {
      if (!data) return;
      if (state === 'failed' || state === 'closed' || state === 'reconnecting') {
        if (!notice) notice = 'Input not sent: terminal is not writable.';
        report();
        return;
      }
      const size = new TextEncoder().encode(data).length;
      if (size > limit - bytes) {
        fail('Input limit exceeded. Paste rejected in full; queued input and subsequent Enter blocked. Clear the CLI composer before retrying.');
        return;
      }
      bytes += size;
      queue.push(data);
      flush();
    },
    resize(cols: number, rows: number) {
      geometry = { cols, rows };
      flush();
    },
    receive(message: ServerMessage) {
      if (message.type === 'state') {
        if (message.generation !== generation && generation !== 0) discard('Terminal generation changed.');
        generation = message.generation;
        limit = message.inputLimit;
        if (state !== 'failed') state = message.state;
        if (message.state === 'closed' || message.state === 'failed' || message.state === 'reconnecting') {
          discard(`Terminal ${message.state}.`);
        }
        if (bytes > limit) fail('Server input limit exceeded. Queued input rejected in full.');
        else {
          report();
          flush();
        }
      } else if (message.type === 'ack' && message.generation === generation) {
        const size = pending.get(message.seq);
        if (size === undefined) return;
        pending.delete(message.seq);
        bytes -= size;
        if (message.outcome !== 'written') fail(`${message.outcome}: ${message.reason}`);
      }
    },
    disconnect(reconnect: boolean) {
      discard('Connection lost.');
      generation = 0;
      seq = 0;
      sentGeometry = '';
      state = reconnect ? 'reconnecting' : 'failed';
      report();
    },
  };
}

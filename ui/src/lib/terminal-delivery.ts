import type { ClientMessage, ServerMessage, TerminalState } from './terminal-protocol.js';

interface DeliveryDeps {
  send(message: ClientMessage): void;
  status(state: TerminalState, notice: string): void;
}

/** Target size for a single input frame. Kept well under a typical input window
 * so a large paste is pipelined as several in-flight frames rather than one
 * all-or-nothing block. Clamped to the server's advertised limit per session. */
const CHUNK_TARGET_BYTES = 16384;

const encoder = new TextEncoder();
const utf8Len = (text: string): number => encoder.encode(text).length;

/**
 * Splits `data` into pieces each at most `maxBytes` UTF-8 bytes, never splitting
 * a multi-byte code point across a boundary. A single code point larger than
 * `maxBytes` is emitted whole (its own oversized piece) rather than looping, so
 * progress is always made. Returns `[]` for empty input.
 */
export function chunkByUtf8Bytes(data: string, maxBytes: number): string[] {
  if (data === '') return [];
  const bytes = encoder.encode(data);
  if (bytes.length <= maxBytes) return [data];
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    if (end < bytes.length) {
      // Back off a UTF-8 continuation byte (0b10xxxxxx) to the code-point
      // boundary, so the split never lands mid-character.
      while (end > start && (bytes[end] & 0xc0) === 0x80) {
        end -= 1;
      }
      if (end === start) {
        // The window is smaller than a single code point: extend to include the
        // whole character instead of stalling.
        end = Math.min(start + maxBytes, bytes.length);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
          end += 1;
        }
      }
    }
    chunks.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  return chunks;
}

/** Holds only this connection's input. An acknowledgement means PTY write, not command completion. */
export function createTerminalDelivery(deps: DeliveryDeps) {
  let state: TerminalState = 'connecting';
  let generation = 0;
  let seq = 0;
  let limit = 65536;
  // Offered input awaiting a free budget window, in submission order. Sliced
  // lazily in pump() against the current window so frame sizes always respect
  // the limit the server actually advertised.
  let outbox: string[] = [];
  const pending = new Map<number, number>();
  let bytes = 0;
  let notice = '';
  let geometry: { cols: number; rows: number } | undefined;
  let sentGeometry = '';
  const report = () => deps.status(state, notice);
  const discard = (reason: string) => {
    if (pending.size || outbox.length) {
      notice = `${reason} ${outbox.length} unsent input frame(s) discarded; ${pending.size} unacknowledged frame(s) may have executed. Nothing replayed.`;
    }
    outbox = [];
    pending.clear();
    bytes = 0;
  };
  const fail = (reason: string) => {
    discard(reason);
    notice = reason + (notice ? ` ${notice}` : '');
    state = 'failed';
    report();
  };
  // Drains queued input into the socket while the outstanding (unacknowledged)
  // byte window has room, slicing each offered string into frames no larger than
  // the remaining window (capped so a big paste pipelines as several in-flight
  // frames). Whatever does not fit waits and is pumped again as acks free space,
  // so an arbitrarily large paste streams through instead of being rejected. A
  // frame is always allowed out of an empty window — even a lone code point
  // wider than the window — so delivery can never stall.
  const pump = () => {
    if (state !== 'ready') return;
    try {
      if (geometry) {
        const key = `${generation}:${geometry.cols}:${geometry.rows}`;
        if (key !== sentGeometry) {
          deps.send({ type: 'resize', ...geometry, generation });
          sentGeometry = key;
        }
      }
      while (outbox.length) {
        const room = limit - bytes;
        let budget = Math.min(Math.max(room, 0), CHUNK_TARGET_BYTES);
        if (budget === 0) {
          if (bytes !== 0) break; // window full; wait for acks to free space
          budget = CHUNK_TARGET_BYTES; // empty window, tiny limit: still progress
        }
        const head = outbox[0];
        const piece = chunkByUtf8Bytes(head, budget)[0];
        const pieceSize = utf8Len(piece);
        // A single code point can exceed the window; only force it out when
        // nothing is outstanding, else wait for acks to widen the window.
        if (pieceSize > room && bytes !== 0) break;
        if (piece.length === head.length) outbox.shift();
        else outbox[0] = head.slice(piece.length);
        const id = ++seq;
        pending.set(id, pieceSize);
        bytes += pieceSize;
        deps.send({ type: 'input', data: piece, generation, seq: id });
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
      outbox.push(data);
      pump();
    },
    resize(cols: number, rows: number) {
      geometry = { cols, rows };
      pump();
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
        report();
        pump();
      } else if (message.type === 'ack' && message.generation === generation) {
        const size = pending.get(message.seq);
        if (size === undefined) return;
        pending.delete(message.seq);
        bytes -= size;
        if (message.outcome !== 'written') fail(`${message.outcome}: ${message.reason}`);
        else pump();
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

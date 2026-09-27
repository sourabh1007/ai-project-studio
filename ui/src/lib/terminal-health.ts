import type { ClientMessage, ServerMessage } from './terminal-protocol.js';

export interface TerminalHealth {
  connection: 'checking' | 'live' | 'unresponsive' | 'unsupported';
  heartbeatAgeSeconds: number | null;
  outputAgeSeconds: number;
  inputAgeSeconds: number | null;
  pendingInputSeconds: number | null;
  quiet: boolean;
}

/** Transport evidence only: neither a PTY write nor a redraw proves model progress. */
export function createTerminalHealth(now: () => number) {
  let generation = 0;
  let supported = false;
  let connectedAt = now();
  let outputAt = connectedAt;
  let inputAt: number | null = null;
  let heartbeatAt: number | null = null;
  let ping: { seq: number; sentAt: number } | null = null;
  let sequence = 0;
  const pending = new Map<number, number>();
  const age = (time: number) => Math.max(0, Math.floor((now() - time) / 1000));
  return {
    resume() {
      heartbeatAt = null;
      ping = null;
    },
    receive(message: ServerMessage) {
      if (message.type === 'state') {
        supported = message.heartbeat === true;
        if (generation !== message.generation) {
          generation = message.generation;
          connectedAt = now();
          outputAt = connectedAt;
          inputAt = null;
          heartbeatAt = null;
          ping = null;
          pending.clear();
        }
      } else if (message.type === 'output' && message.data.length > 0) {
        outputAt = now();
      } else if (message.type === 'pong' && message.generation === generation && message.seq === ping?.seq) {
        heartbeatAt = now();
        ping = null;
      } else if (message.type === 'ack' && message.generation === generation) {
        pending.delete(message.seq);
      }
    },
    sent(message: ClientMessage) {
      if (message.type === 'input') {
        inputAt = now();
        pending.set(message.seq, inputAt);
      }
    },
    probe(): ClientMessage | null {
      if (!supported || ping || (heartbeatAt !== null && now() - heartbeatAt < 5000)) return null;
      ping = { seq: ++sequence, sentAt: now() };
      return { type: 'ping', generation, seq: ping.seq };
    },
    snapshot(): TerminalHealth {
      const firstPending = pending.values().next().value as number | undefined;
      const heartbeatAgeSeconds = heartbeatAt === null ? null : age(heartbeatAt);
      return {
        connection: !supported ? 'unsupported' : ping && age(ping.sentAt) >= 20 ? 'unresponsive'
          : heartbeatAt === null ? 'checking' : 'live',
        heartbeatAgeSeconds,
        outputAgeSeconds: age(outputAt),
        inputAgeSeconds: inputAt === null ? null : age(inputAt),
        pendingInputSeconds: firstPending === undefined ? null : age(firstPending),
        quiet: age(outputAt) >= 30,
      };
    },
  };
}

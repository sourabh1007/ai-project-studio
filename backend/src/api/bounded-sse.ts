import type { Logger } from '../kernel/logger.js';
import { sseConfigSchema, type SseConfig } from './sse-config.js';

export interface SseTransport {
  readonly writableLength: number;
  write(frame: string): boolean;
  end(): void;
  destroy(): void;
  on(event: 'drain' | 'close' | 'error', listener: () => void): unknown;
  off(event: 'drain' | 'close' | 'error', listener: () => void): unknown;
}

export interface SseConnection {
  send(event: string | null, data: unknown): void;
  comment(text: string): void;
  end(): void;
}

interface ConnectionState {
  bufferedBytes(): number;
  close(): void;
}

/** Shares byte/admission budgets across all SSE endpoints, including native write buffers. */
export function createBoundedSse(deps: { config: SseConfig; logger: Pick<Logger, 'warn'> }) {
  const config = sseConfigSchema.parse(deps.config);
  const connections = new Set<ConnectionState>();
  let accepting = true;
  const bufferedBytes = () => [...connections].reduce((total, item) => total + item.bufferedBytes(), 0);

  return {
    stats: () => ({ connections: connections.size, bufferedBytes: bufferedBytes() }),
    close(): void {
      accepting = false;
      for (const connection of connections) connection.close();
    },
    open(transport: SseTransport, onClose: () => void): SseConnection | null {
      if (!accepting || connections.size >= config.maxConnections) {
        deps.logger.warn('SSE connection admission rejected');
        return null;
      }
      const queue = new Map<number, { text: string; bytes: number }>();
      let sequence = 0;
      let queuedBytes = 0;
      let blocked = false;
      let closed = false;
      let finishing = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clearTimer = () => {
        clearTimeout(timer);
        timer = undefined;
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearTimer();
        queue.clear();
        queuedBytes = 0;
        connections.delete(state);
        transport.off('close', cleanup);
        transport.off('drain', flush);
        transport.off('error', transportError);
        onClose();
      };
      const fail = (reason: string, error?: unknown) => {
        if (closed) return;
        deps.logger.warn('SSE connection closed; client must refresh authoritative state', { reason, error });
        cleanup();
        transport.destroy();
      };
      const write = (text: string): boolean => {
        try {
          if (transport.write(text)) return true;
        } catch (error) {
          fail('write-failed', error);
          return false;
        }
        blocked = true;
        timer = setTimeout(() => fail('backpressure-timeout'), config.blockedTimeoutMs);
        return false;
      };
      const flush = () => {
        if (closed) return;
        blocked = false;
        clearTimer();
        for (const [id, frame] of queue) {
          queue.delete(id);
          queuedBytes -= frame.bytes;
          if (!write(frame.text)) return;
        }
        if (finishing) transport.end();
      };
      const transportError = () => fail('transport-error');
      const state: ConnectionState = {
        bufferedBytes: () => queuedBytes + transport.writableLength,
        close: () => fail('server-shutdown'),
      };
      const enqueue = (text: string): void => {
        if (closed || finishing) return;
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > config.maxFrameBytes ||
            state.bufferedBytes() + bytes > config.maxConnectionBytes ||
            bufferedBytes() + bytes > config.maxTotalBytes) {
          fail('buffer-limit');
          return;
        }
        if (blocked) {
          queue.set(sequence++, { text, bytes });
          queuedBytes += bytes;
        } else {
          write(text);
        }
      };
      connections.add(state);
      transport.on('close', cleanup);
      transport.on('drain', flush);
      transport.on('error', transportError);
      return {
        send(event, data) {
          if (closed || finishing) return;
          enqueue(`${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`);
        },
        comment(text) { enqueue(`: ${text}\n\n`); },
        end() {
          if (closed || finishing) return;
          finishing = true;
          if (!blocked) transport.end();
        },
      };
    },
  };
}

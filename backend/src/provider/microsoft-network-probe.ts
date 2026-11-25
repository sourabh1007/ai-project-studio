import { createConnection } from 'node:net';

/** Connects to an internal host without sending credentials or HTTP requests. */
export function probeMicrosoftNetwork(
  options: { host: string; port: number; timeoutMs: number },
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createConnection({ host: options.host, port: options.port });
    let finished = false;
    const finish = (available: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve(available);
    };
    const abort = () => finish(false);
    const timer = setTimeout(abort, options.timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => finish(true));
    socket.once('error', abort);
    socket.once('close', abort);
  });
}

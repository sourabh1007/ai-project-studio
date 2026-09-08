import { ConfigError } from '../kernel/error-types.js';

export interface ShutdownCompleteMessage {
  type: 'shutdown-complete';
  nonce: string;
}

export type ShutdownMessageSender = (
  message: ShutdownCompleteMessage,
  callback: (error: Error | null) => void,
) => void;

export function isDesktopShutdownRequest(message: unknown, nonce: string | undefined): boolean {
  return nonce !== undefined && nonce.length > 0 &&
    typeof message === 'object' && message !== null &&
    'type' in message && message.type === 'shutdown-request' &&
    'nonce' in message && message.nonce === nonce;
}

/** Invoke only after owned work, transport and storage have finished closing. */
export async function acknowledgeDesktopShutdown(
  nonce: string | undefined,
  send: ShutdownMessageSender | undefined,
): Promise<void> {
  if (nonce === undefined) return;
  if (nonce.trim().length === 0 || !send) {
    throw new ConfigError('Desktop shutdown acknowledgement requires a nonce and IPC channel');
  }
  await new Promise<void>((resolve, reject) => {
    send({ type: 'shutdown-complete', nonce }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

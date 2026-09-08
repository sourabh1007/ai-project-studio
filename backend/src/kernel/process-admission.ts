import { processAdmissionConfigSchema, type ProcessAdmissionConfig } from './process-admission-config.js';

export class ProcessAdmissionError extends Error {
  constructor(readonly kind: 'queue-full' | 'cancelled' | 'closed') {
    super(`AI process admission ${kind}`);
    this.name = 'ProcessAdmissionError';
  }
}

export interface ProcessPermit {
  /** Native exit, or confirmed failure before native spawn, is required. */
  release(): void;
  /** Warm owners retire idle clients immediately and busy clients on safe release. */
  onRetire(handler: () => void): void;
}
export interface QueuePermit { release(): void }
export interface ProcessAdmission {
  canAcquireWarm(): boolean;
  limits(): ProcessAdmissionConfig;
  acquireCold(signal?: AbortSignal): Promise<ProcessPermit>;
  tryAcquireWarm(): ProcessPermit | null;
  reserveQueue(onClose: () => void): QueuePermit;
  onCapacityChange(handler: () => void): () => void;
  reconfigure(config: ProcessAdmissionConfig): void;
  close(): void;
  stats(): { processes: number; warmProcesses: number; queued: number; closed: boolean };
}

interface Reservation { warm: boolean; retiring: boolean; onRetire?: () => void }
interface Waiter {
  resolve(permit: ProcessPermit): void;
  reject(error: Error): void;
  queue: QueuePermit;
  signal?: AbortSignal;
  abort: () => void;
}

export function createProcessAdmission(initial: ProcessAdmissionConfig): ProcessAdmission {
  let config = processAdmissionConfigSchema.parse(initial);
  let closed = false;
  const reservations = new Set<Reservation>();
  const queue = new Set<() => void>();
  const cold: Waiter[] = [];
  const listeners = new Set<() => void>();
  const warmCount = () => [...reservations].filter((entry) => entry.warm).length;
  const canAcquireWarm = () =>
    !closed && cold.length === 0 && reservations.size < config.maxProcesses && warmCount() < config.maxWarmProcesses;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const remove = (waiter: Waiter) => {
    const index = cold.indexOf(waiter);
    if (index !== -1) cold.splice(index, 1);
    waiter.signal?.removeEventListener('abort', waiter.abort);
    waiter.queue.release();
  };
  const pump = () => {
    while (!closed && cold.length > 0 && reservations.size < config.maxProcesses) {
      const waiter = cold[0];
      remove(waiter);
      waiter.resolve(reserve(false));
    }
  };
  const reserve = (warm: boolean): ProcessPermit => {
    const entry: Reservation = { warm, retiring: false };
    reservations.add(entry);
    return {
      release() {
        if (!reservations.delete(entry)) return;
        pump();
        notify();
      },
      onRetire(handler) {
        entry.onRetire = handler;
        if (reservations.has(entry) && entry.retiring) handler();
      },
    };
  };
  const reserveQueue = (onClose: () => void): QueuePermit => {
    if (closed) throw new ProcessAdmissionError('closed');
    if (queue.size >= config.maxQueued) throw new ProcessAdmissionError('queue-full');
    // Each reservation has independent identity, even if callers reuse a callback.
    const cancel = () => { queue.delete(cancel); onClose(); };
    queue.add(cancel);
    return { release: () => { queue.delete(cancel); } };
  };

  return {
    canAcquireWarm,
    limits: () => ({ ...config }),
    reserveQueue,
    acquireCold(signal) {
      if (closed) return Promise.reject(new ProcessAdmissionError('closed'));
      if (signal?.aborted) return Promise.reject(new ProcessAdmissionError('cancelled'));
      if (cold.length === 0 && reservations.size < config.maxProcesses) return Promise.resolve(reserve(false));
      return new Promise((resolve, reject) => {
        let waiter: Waiter;
        const cancel = (kind: 'closed' | 'cancelled') => {
          remove(waiter);
          reject(new ProcessAdmissionError(kind));
        };
        const ticket = reserveQueue(() => cancel('closed'));
        waiter = { resolve, reject, queue: ticket, signal, abort: () => cancel('cancelled') };
        cold.push(waiter);
        signal?.addEventListener('abort', waiter.abort, { once: true });
      });
    },
    tryAcquireWarm() {
      if (!canAcquireWarm()) return null;
      return reserve(true);
    },
    onCapacityChange(handler) {
      listeners.add(handler);
      return () => { listeners.delete(handler); };
    },
    reconfigure(next) {
      config = processAdmissionConfigSchema.parse(next);
      const warms = [...reservations].filter((entry) => entry.warm);
      const coldCount = reservations.size - warms.length;
      const keep = Math.max(0, Math.min(config.maxWarmProcesses, config.maxProcesses - coldCount));
      for (const entry of warms.slice(keep)) {
        if (entry.retiring) continue;
        entry.retiring = true;
        entry.onRetire?.();
      }
      pump();
      notify();
    },
    close() {
      closed = true;
      for (const cancel of [...queue]) cancel();
      listeners.clear();
    },
    stats: () => ({ processes: reservations.size, warmProcesses: warmCount(), queued: queue.size, closed }),
  };
}

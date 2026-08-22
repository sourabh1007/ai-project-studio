import type { HttpProbe } from './automation-ports.js';

/**
 * Real {@link HttpProbe} backed by the global `fetch`. Thin IO adapter (excluded
 * from unit coverage); the check runner that consumes it is fully tested against
 * the port. Network failures are surfaced as a synthetic 0 status so a monitor
 * records the failed poll rather than throwing.
 */
export function createHttpProbe(timeoutMs: number): HttpProbe {
  return {
    async fetch(url, method, signal) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await fetch(url, {
          method,
          signal: controller.signal,
        });
        const body = await response.text();
        return { status: response.status, body };
      } catch (error) {
        return {
          status: 0,
          body: error instanceof Error ? error.message : 'Request failed',
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

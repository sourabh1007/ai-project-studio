import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import type { McpAuthenticationJob, McpServerEntry } from '../../lib/types.js';

export function useMcpAuthentication(providerId: string, serverName: string, callbacks: {
  onCompleted: (server: McpServerEntry) => void;
  onBackgroundError: (message: string) => void;
}) {
  const api = useApi();
  const [job, setJob] = useState<McpAuthenticationJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const current = useRef<McpAuthenticationJob | null>(null);
  const epoch = useRef(0);
  const locked = useRef(false);
  const handlers = useRef(callbacks);
  handlers.current = callbacks;

  useEffect(() => {
    setJob(null);
    setError(null);
    setBusy(false);
    locked.current = false;
    return () => {
      epoch.current += 1;
      const pending = current.current;
      current.current = null;
      if (pending?.status === 'pending') {
        void api.cancelMcpAuthentication(providerId, serverName, pending.id).catch(() => {
          handlers.current.onBackgroundError(`Could not confirm cancellation of ${serverName} sign-in. The attempt remains bounded by its expiry.`);
        });
      }
    };
  }, [api, providerId, serverName]);

  const accept = useCallback((result: McpAuthenticationJob) => {
    current.current = result;
    setJob(result);
    if (result.status === 'completed') {
      if (result.server) handlers.current.onCompleted(result.server);
      else setError('The connection ended without a verified tool inventory. Refresh tools to check again.');
    } else if (result.status === 'failed') {
      setError(result.message);
    }
  }, []);

  useEffect(() => {
    setExpired(false);
    if (!job || job.status !== 'pending') return;
    const remaining = Date.parse(job.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [job?.id, job?.expiresAt, job?.status]);

  useEffect(() => {
    if (!job || job.status !== 'pending' || busy || error || expired) return;
    const request = epoch.current;
    let active = true;
    const timer = setTimeout(() => {
      void api.getMcpAuthentication(providerId, serverName, job.id)
        .then((result) => {
          if (active && epoch.current === request) accept(result);
        })
        .catch((err: unknown) => {
          if (active && epoch.current === request) {
            setError(`Could not refresh sign-in status: ${err instanceof Error ? err.message : String(err)}. Retry status or cancel; sign-in is not confirmed.`);
          }
        });
    }, 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [api, providerId, serverName, job, busy, error, expired, accept]);

  async function start() {
    if (locked.current || current.current?.status === 'pending') return;
    locked.current = true;
    const request = ++epoch.current;
    setBusy(true);
    setError(null);
    setJob(null);
    current.current = null;
    try {
      const result = await api.startMcpAuthentication(providerId, serverName);
      if (epoch.current !== request) {
        if (result.status === 'pending') {
          await api.cancelMcpAuthentication(providerId, serverName, result.id).catch(() => {
            handlers.current.onBackgroundError(`Could not confirm cancellation of ${serverName} sign-in after its dialog closed. The attempt remains bounded by its expiry.`);
          });
        }
        return;
      }
      accept(result);
    } catch (err) {
      if (epoch.current === request) setError(`${err instanceof Error ? err.message : String(err)}. Sign-in was not confirmed; a server-side attempt may remain until expiry.`);
    } finally {
      if (epoch.current === request) {
        locked.current = false;
        setBusy(false);
      }
    }
  }

  async function cancel() {
    const pending = current.current;
    if (locked.current || pending?.status !== 'pending') return;
    locked.current = true;
    const request = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api.cancelMcpAuthentication(providerId, serverName, pending.id);
      if (epoch.current === request) accept(result);
    } catch (err) {
      if (epoch.current === request) setError(`Cancellation was not confirmed: ${err instanceof Error ? err.message : String(err)}. The attempt remains bounded by its expiry.`);
    } finally {
      if (epoch.current === request) {
        locked.current = false;
        setBusy(false);
      }
    }
  }

  return { job, busy, error, expired, start, cancel, retryStatus: () => setError(null) };
}

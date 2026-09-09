import { useEffect, useRef, useState } from 'react';
import { useApi } from '../app/api-context.js';
import { desktopBridge } from '../lib/desktop-bridge.js';
import {
  deriveConnectionStatus,
  type ConnectionStatus,
  type ProbeOutcome,
} from '../lib/connection-status.js';

/** How often to poll the backend `/health` probe while the app is online. */
const POLL_INTERVAL_MS = 15000;

function readBrowserOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

/**
 * Tracks the app's connectivity by combining `navigator.onLine` with periodic
 * polling of the backend `/health` probe, and returns a derived banner state.
 * Pure derivation lives in `lib/connection-status`; this hook only supplies the
 * live inputs and timers.
 */
export function useConnectionStatus(): ConnectionStatus {
  const api = useApi();
  const [browserOnline, setBrowserOnline] = useState(readBrowserOnline);
  const [lastProbe, setLastProbe] = useState<ProbeOutcome>('unknown');
  const [backendUnavailable, setBackendUnavailable] = useState(false);
  const cancelled = useRef(false);

  // The shell knows something polling cannot: that the backend is gone for
  // good. Without this the banner would keep implying recovery is under way.
  useEffect(() => desktopBridge()?.onBackendUnavailable?.(
    () => setBackendUnavailable(true),
  ), []);

  useEffect(() => {
    const onOnline = () => setBrowserOnline(true);
    const onOffline = () => setBrowserOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    cancelled.current = false;
    let inFlight = false;
    const probe = async () => {
      if (!readBrowserOnline() || inFlight) return;
      inFlight = true;
      try {
        await api.checkHealth();
        if (!cancelled.current) setLastProbe('ok');
      } catch {
        if (!cancelled.current) setLastProbe('error');
      } finally {
        inFlight = false;
      }
    };
    void probe();
    const timer = window.setInterval(() => void probe(), POLL_INTERVAL_MS);
    return () => {
      cancelled.current = true;
      window.clearInterval(timer);
    };
  }, [api]);

  return deriveConnectionStatus({ browserOnline, lastProbe, backendUnavailable });
}

import { useEffect, useState } from 'react';
import { useApi } from '../app/api-context.js';
import { desktopBridge } from '../lib/desktop-bridge.js';
import type { ResourceSnapshot } from '../lib/types.js';
import {
  deriveConnectionStatus,
  trackProbe,
  INITIAL_PROBE,
  type ConnectionStatus,
  type ProbeTracker,
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
export interface MeasuredConnectionStatus extends ConnectionStatus {
  resources?: ResourceSnapshot;
  probeFailed: boolean;
}

export function useConnectionStatus(): MeasuredConnectionStatus {
  const api = useApi();
  const [browserOnline, setBrowserOnline] = useState(readBrowserOnline);
  const [probe, setProbe] = useState<ProbeTracker>(INITIAL_PROBE);
  const [backendUnavailable, setBackendUnavailable] = useState(false);
  const [resources, setResources] = useState<ResourceSnapshot>();
  const [probeFailed, setProbeFailed] = useState(false);

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
    let cancelled = false;
    let inFlight = false;
    const probe = async () => {
      if (!readBrowserOnline() || inFlight) return;
      inFlight = true;
      try {
        const health = await api.checkHealth();
        if (!cancelled) {
          setProbe((prev) => trackProbe(prev, 'ok'));
          setResources(health.resources);
          setProbeFailed(false);
        }
      } catch {
        if (!cancelled) {
          setProbe((prev) => trackProbe(prev, 'error'));
          setResources(undefined);
          setProbeFailed(true);
        }
      } finally {
        inFlight = false;
      }
    };
    void probe();
    const timer = window.setInterval(() => void probe(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api]);

  return { ...deriveConnectionStatus({
    browserOnline,
    lastProbe: probe.outcome,
    backendUnavailable,
  }), resources, probeFailed };
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deriveUpdateUi,
  initialUpdateState,
  mergeUpdateState,
  type UpdateSnapshot,
  type UpdateState,
  type UpdateUi,
} from '../lib/update-state.js';

/**
 * The slice of the Electron preload bridge this hook talks to. Defined locally
 * (each feature keeps its own bridge shape) so the UI has no hard dependency on
 * the desktop shell — in a plain browser the bridge is simply absent.
 */
interface UpdatesBridge {
  getState(): Promise<UpdateSnapshot>;
  check(): Promise<UpdateSnapshot | void>;
  download(): Promise<UpdateSnapshot | void>;
  install(): Promise<void>;
  onEvent(cb: (type: string, payload?: UpdateSnapshot) => void): () => void;
}

function updatesBridge(): UpdatesBridge | undefined {
  return (window as unknown as { desktop?: { updates?: UpdatesBridge } }).desktop?.updates;
}

export interface UseAppUpdates {
  state: UpdateState;
  ui: UpdateUi;
  /** True when running inside the desktop shell (bridge present). */
  supported: boolean;
  check(): void;
  download(): void;
  install(): void;
}

/**
 * Subscribes to auto-update events from the Electron main process, seeds from
 * the current state, and exposes actions. Degrades to an inert no-op when the
 * desktop bridge is unavailable (e.g. running the UI in a browser).
 */
export function useAppUpdates(): UseAppUpdates {
  const bridge = useMemo(updatesBridge, []);
  const [state, setState] = useState<UpdateState>(initialUpdateState);
  // Keep a ref so the event handler always merges onto the latest state without
  // needing to re-subscribe on every change.
  const stateRef = useRef(state);
  stateRef.current = state;

  const apply = useCallback((snapshot: UpdateSnapshot | null | undefined) => {
    setState((prev) => mergeUpdateState(prev, snapshot));
  }, []);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    let active = true;
    bridge
      .getState()
      .then((snapshot) => {
        if (active) {
          apply(snapshot);
        }
      })
      .catch(() => {
        /* ignore — stay in the default state */
      });

    const unsubscribe = bridge.onEvent((type, payload) => {
      if (type === 'event') {
        apply(payload);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge, apply]);

  const check = useCallback(() => {
    bridge?.check().then((s) => apply(s ?? undefined)).catch(() => {});
  }, [bridge, apply]);

  const download = useCallback(() => {
    bridge?.download().then((s) => apply(s ?? undefined)).catch(() => {});
  }, [bridge, apply]);

  const install = useCallback(() => {
    bridge?.install().catch(() => {});
  }, [bridge]);

  const ui = useMemo(() => deriveUpdateUi(state), [state]);

  return {
    state,
    ui,
    supported: Boolean(bridge),
    check,
    download,
    install,
  };
}

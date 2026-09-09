import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deriveUpdateUi,
  initialUpdateState,
  mergeUpdateState,
  type UpdateSnapshot,
  type UpdateState,
  type UpdateUi,
} from '../lib/update-state.js';
import {
  desktopUpdatesBridge,
  type DesktopUpdatesBridge as UpdatesBridge,
} from '../lib/desktop-bridge.js';

function updatesBridge(): UpdatesBridge | undefined {
  return desktopUpdatesBridge();
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
      .getState?.()
      ?.then((snapshot) => {
        if (active) {
          apply(snapshot);
        }
      })
      .catch(() => {
        /* ignore — stay in the default state */
      });

    const unsubscribe = bridge.onEvent?.((type, payload) => {
      if (type === 'event') {
        apply(payload);
      }
    });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bridge, apply]);

  const check = useCallback(() => {
    bridge?.check?.()?.then((s) => apply(s ?? undefined)).catch(() => {});
  }, [bridge, apply]);

  const download = useCallback(() => {
    bridge?.download?.()?.then((s) => apply(s ?? undefined)).catch(() => {});
  }, [bridge, apply]);

  const install = useCallback(() => {
    const failed = () => apply({
      status: stateRef.current.status === 'downloaded' ? 'downloaded' : 'error',
      error: stateRef.current.canAutoInstall
        ? 'Update not installed. Wait for active work to finish, then retry installation or quit again.'
        : 'Could not open the release page. No installer was started. Retry opening the release page.',
    });
    const started = bridge?.install?.();
    // A shell without an installer must report failure, not silently do nothing.
    if (!started) {
      failed();
      return;
    }
    started.then((installed) => { if (installed !== true) failed(); }).catch(failed);
  }, [bridge, apply]);

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

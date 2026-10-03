import { useEffect, useSyncExternalStore } from 'react';
import { useApi } from '../app/api-context.js';
import {
  getMicrosoftSignedIn,
  setMicrosoftSignedIn,
  subscribeMicrosoftSignedIn,
} from '../lib/microsoft-identity.js';

/**
 * Window event dispatched by the Azure status badge whenever the signed-in
 * state flips (explicit sign-in/out, or a polled change). The identity sync
 * listens for it so Agency appears/disappears immediately rather than waiting
 * for the next poll tick.
 */
export const AZURE_AUTH_CHANGED_EVENT = 'azure-auth-changed';

/** Subscribe a component to the shared Microsoft sign-in state. */
export function useMicrosoftSignedIn(): boolean | undefined {
  return useSyncExternalStore(
    subscribeMicrosoftSignedIn,
    getMicrosoftSignedIn,
    getMicrosoftSignedIn,
  );
}

/**
 * Drives the shared Microsoft-identity store from the provider bootstrap: once
 * on mount, on an interval, and whenever an `azure-auth-changed` event fires.
 * Mounted once (in `App`) so every consumer of `useMicrosoftSignedIn` reflects
 * sign-in/out live without a reload.
 */
export function useMicrosoftIdentitySync(intervalMs = 30_000): void {
  const api = useApi();
  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      void api
        .getProviderBootstrap()
        .then((info) => {
          if (!cancelled) {
            setMicrosoftSignedIn(info.microsoftSignedIn);
          }
        })
        .catch(() => {
          /* transient bootstrap errors keep the last known state */
        });
    };
    refresh();
    const id = window.setInterval(refresh, intervalMs);
    window.addEventListener(AZURE_AUTH_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener(AZURE_AUTH_CHANGED_EVENT, refresh);
    };
  }, [api, intervalMs]);
}

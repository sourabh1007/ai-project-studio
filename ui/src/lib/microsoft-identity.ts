/**
 * Shared Microsoft-identity signal for the UI. The backend reports whether the
 * user is signed in with a Microsoft identity (Azure DevOps) via the provider
 * bootstrap; this tiny observable store fans that value out to every component
 * that must hide or show Agency — an internal Microsoft tool — live as the user
 * signs in or out, with no reload. `undefined` means "not yet known": callers
 * treat it as "show" so nothing flickers before the first fetch resolves.
 */
let signedIn: boolean | undefined;
const listeners = new Set<(value: boolean | undefined) => void>();

/** The last known Microsoft sign-in state, or `undefined` before first fetch. */
export function getMicrosoftSignedIn(): boolean | undefined {
  return signedIn;
}

/** Records the latest state, notifying subscribers only on a real change. */
export function setMicrosoftSignedIn(value: boolean | undefined): void {
  if (value === signedIn) {
    return;
  }
  signedIn = value;
  for (const listener of listeners) {
    listener(signedIn);
  }
}

/** Subscribes to state changes; returns an unsubscribe function. */
export function subscribeMicrosoftSignedIn(
  listener: (value: boolean | undefined) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether Agency (and any Microsoft-only surface) must be hidden. Hidden only
 * once the backend has positively reported a signed-out state — an unknown
 * (`undefined`) state keeps Agency visible to avoid flicker on first paint.
 */
export function isAgencyHidden(value: boolean | undefined): boolean {
  return value === false;
}

/**
 * Provider ids that are exposed only to Microsoft-signed-in users. Mirrors the
 * backend `MICROSOFT_ONLY_PROVIDER_IDS` so the UI never surfaces an internal
 * Microsoft tool (Agency) to users who are signed out.
 */
export const MICROSOFT_ONLY_PROVIDER_IDS = new Set(['agency']);

/**
 * Whether a provider should be shown given the current sign-in state. Non
 * Microsoft-only providers are always shown; Microsoft-only providers are shown
 * unless the user is positively signed out.
 */
export function isProviderExposed(
  providerId: string,
  signedIn: boolean | undefined,
): boolean {
  if (!MICROSOFT_ONLY_PROVIDER_IDS.has(providerId)) {
    return true;
  }
  return !isAgencyHidden(signedIn);
}

/** Test-only reset of the module-level state between cases. */
export function resetMicrosoftSignedIn(): void {
  signedIn = undefined;
  listeners.clear();
}

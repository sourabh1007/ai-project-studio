/**
 * Live Microsoft-identity state: true when the user is signed in to Azure
 * DevOps (an Entra/Microsoft identity). This gates whether the Agency CLI — an
 * internal Microsoft tool that must leave no trace outside Microsoft — is
 * exposed anywhere in the IDE (provider pickers, usage, quota, settings, MCP,
 * metasession). Held as a small in-memory store updated by the Azure DevOps
 * auth flows (status / sign-in / sign-out) and the background credential warm
 * loop, so Agency appears and disappears live as the user signs in or out, with
 * no IDE restart. Pure and side-effect free; all IO stays at the edges.
 */
export interface MicrosoftIdentity {
  /** True when signed in with a Microsoft identity (Azure DevOps authenticated). */
  isSignedIn(): boolean;
  /**
   * Records the latest sign-in state. Listeners registered via
   * {@link onChange} fire only when the value actually changed.
   */
  set(signedIn: boolean): void;
  /** Registers a listener invoked with the new state after a real change. */
  onChange(listener: (signedIn: boolean) => void): void;
}

/** Creates the runtime Microsoft-identity store (signed out until proven in). */
export function createMicrosoftIdentity(initial = false): MicrosoftIdentity {
  let signedIn = initial;
  const listeners: Array<(signedIn: boolean) => void> = [];
  return {
    isSignedIn: () => signedIn,
    set(next) {
      if (next === signedIn) {
        return;
      }
      signedIn = next;
      for (const listener of listeners) {
        listener(signedIn);
      }
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

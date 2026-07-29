import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { AzureDevOpsStatus } from '../../lib/types.js';

/**
 * Sidebar badge for IDE-level Azure DevOps auth. Mirrors Visual Studio: the WAM
 * broker is enabled at startup for silent SSO, and clicking "sign in" runs the
 * interactive Microsoft sign-in once to prime Git Credential Manager's cache.
 * After that, every spawned session authenticates silently against Azure
 * DevOps, so this is a status indicator plus a one-time sign-in trigger.
 */
export function AzureStatusBadge() {
  const api = useApi();
  const { data, loading, reload } = useAsync<AzureDevOpsStatus>(
    () => api.getAzureStatus(),
    [],
  );
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    const interval = window.setInterval(reload, 30_000);
    window.addEventListener('focus', reload);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', reload);
    };
  }, [reload]);

  const authenticated = data?.authenticated ?? false;
  const state = signingIn
    ? 'checking'
    : data
      ? authenticated
        ? 'on'
        : 'off'
      : loading
        ? 'checking'
        : 'off';

  const signIn = async () => {
    if (signingIn) {
      return;
    }
    setSigningIn(true);
    try {
      await api.azureSignIn();
    } finally {
      setSigningIn(false);
      reload();
    }
  };

  const label = signingIn
    ? 'Azure DevOps · signing in…'
    : state === 'checking'
      ? 'Azure DevOps · checking…'
      : authenticated
        ? `Azure DevOps · ${data?.account ?? 'signed in'}`
        : 'Azure DevOps · sign in';

  return (
    <button
      type="button"
      className={`gh-status gh-status-${state}`}
      onClick={authenticated ? reload : signIn}
      disabled={loading || signingIn}
      title={
        authenticated
          ? 'Signed in to Azure DevOps. All sessions inherit this login automatically. Click to re-check.'
          : 'Click to sign in to Azure DevOps once (Microsoft SSO). All sessions will then authenticate automatically for dev.azure.com and *.visualstudio.com.'
      }
    >
      <span className="gh-status-dot" aria-hidden="true" />
      <span className="gh-status-label">{label}</span>
    </button>
  );
}

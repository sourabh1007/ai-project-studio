import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { AzureDevOpsStatus } from '../../lib/types.js';
import { Spinner } from '../../components/loading.js';

const ORG_STORAGE_KEY = 'azureDevOpsOrg';

function readSavedOrg(): string {
  try {
    return window.localStorage.getItem(ORG_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Sidebar control for IDE-level Azure DevOps auth. Azure DevOps requires the
 * organization to mint a token, so the user provides their org (or a repo URL)
 * once; clicking "sign in" runs GCM's interactive browser sign-in, and after
 * that every spawned session authenticates silently for that account. The org
 * is remembered so the status pill can re-check on its own.
 */
export function AzureStatusBadge() {
  const api = useApi();
  const [org, setOrg] = useState(readSavedOrg);
  const [draft, setDraft] = useState(org);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, loading, reload } = useAsync<AzureDevOpsStatus>(
    () => api.getAzureStatus(org || undefined),
    [org],
  );

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
    const target = draft.trim();
    if (signingIn || !target) {
      return;
    }
    try {
      window.localStorage.setItem(ORG_STORAGE_KEY, target);
    } catch {
      /* storage unavailable; sign-in still works for this session */
    }
    setOrg(target);
    setSigningIn(true);
    setError(null);
    try {
      const result = await api.azureSignIn(target);
      if (!result.authenticated) {
        setError(result.message ?? 'Sign-in did not complete. Please try again.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setSigningIn(false);
      reload();
    }
  };

  if (authenticated) {
    return (
      <button
        type="button"
        className="gh-status gh-status-on"
        onClick={reload}
        disabled={loading}
        title="Signed in to Azure DevOps. All sessions inherit this login automatically. Click to re-check."
      >
        <span className="gh-status-dot" aria-hidden="true" />
        <span className="gh-status-label">
          Azure DevOps · {org || data?.account || 'signed in'}
        </span>
      </button>
    );
  }

  return (
    <div className="az-signin-wrap">
      <div className={`gh-status gh-status-${state} az-signin`}>
        <span className="gh-status-dot" aria-hidden="true" />
        <input
          className="az-org-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void signIn();
            }
          }}
          placeholder="Azure DevOps org or repo URL"
          spellCheck={false}
          disabled={signingIn}
          aria-label="Azure DevOps organization or repository URL"
        />
        <button
          type="button"
          className="az-signin-btn"
          onClick={() => void signIn()}
          disabled={signingIn || !draft.trim()}
          title="Sign in to Azure DevOps once via the browser; all sessions then authenticate automatically."
        >
          {signingIn ? <Spinner size={13} label="Signing in" /> : 'Sign in'}
        </button>
      </div>
      {error && <p className="az-signin-error">{error}</p>}
    </div>
  );
}

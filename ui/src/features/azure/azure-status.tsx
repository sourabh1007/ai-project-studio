import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { AzureDevOpsStatus } from '../../lib/types.js';
import { describeAzureConnection } from '../../lib/azure.js';
import { Spinner } from '../../components/loading.js';

const ORG_STORAGE_KEY = 'azureDevOpsOrg';
const ACCOUNT_STORAGE_KEY = 'azureDevOpsAccount';

function readSavedOrg(): string {
  try {
    return window.localStorage.getItem(ORG_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function readSavedAccount(): string {
  try {
    return window.localStorage.getItem(ACCOUNT_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function persist(key: string, value: string): void {
  try {
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* storage unavailable; the badge still works for this session */
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
  const [savedAccount, setSavedAccount] = useState(readSavedAccount);
  const [signingIn, setSigningIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoDetectedRef = useRef(false);

  const { data, loading, reload } = useAsync<AzureDevOpsStatus>(
    () => api.getAzureStatus(org || undefined),
    [org],
  );

  // Auto-detect the organization from an Azure DevOps repo already added to the
  // workspace, so a user who authenticated through a session/PR sees the pill
  // resolve on its own instead of being asked to type an org. Runs once, only
  // when nothing was previously saved, and never overrides an explicit entry.
  useEffect(() => {
    if (org || autoDetectedRef.current) {
      return;
    }
    autoDetectedRef.current = true;
    let cancelled = false;
    void api
      .listRepos()
      .then((repos) => {
        if (cancelled) {
          return;
        }
        const azure = repos.find((repo) => repo.provider === 'azure-devops');
        const derived = azure ? azure.remoteUrl : '';
        if (derived) {
          persist(ORG_STORAGE_KEY, derived);
          setOrg(derived);
          setDraft(derived);
        }
      })
      .catch(() => {
        /* repos unavailable; the user can still type an org manually */
      });
    return () => {
      cancelled = true;
    };
  }, [org, api]);

  useEffect(() => {
    const interval = window.setInterval(reload, 30_000);
    window.addEventListener('focus', reload);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', reload);
    };
  }, [reload]);

  // Remember the signed-in account username so the pill can show it (like the
  // GitHub badge) even on a later silent re-check that omits the username.
  useEffect(() => {
    if (data?.authenticated && data.account) {
      setSavedAccount(data.account);
      persist(ACCOUNT_STORAGE_KEY, data.account);
    }
  }, [data?.authenticated, data?.account]);

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
    persist(ORG_STORAGE_KEY, target);
    setOrg(target);
    setSigningIn(true);
    setError(null);
    try {
      const result = await api.azureSignIn(target);
      if (result.authenticated) {
        if (result.account) {
          setSavedAccount(result.account);
          persist(ACCOUNT_STORAGE_KEY, result.account);
        }
      } else {
        setError(result.message ?? 'Sign-in did not complete. Please try again.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setSigningIn(false);
      reload();
    }
  };

  const signOut = async () => {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    setError(null);
    try {
      const result = await api.azureSignOut(org || undefined);
      if (result.message) {
        setError(result.message);
      }
      setSavedAccount('');
      persist(ACCOUNT_STORAGE_KEY, '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-out failed.');
    } finally {
      setSigningOut(false);
      reload();
    }
  };

  if (authenticated) {
    const connection = describeAzureConnection(org).label;
    const username = data?.account || savedAccount;
    const connectedLabel = username || connection || 'signed in';
    const tooltip = [
      'Signed in to Azure DevOps',
      username ? ` as ${username}` : '',
      connection ? ` · ${connection}` : '',
      '. All sessions inherit this login automatically. Click to re-check.',
    ].join('');
    return (
      <div className="gh-status-wrap">
        <button
          type="button"
          className="gh-status gh-status-on"
          onClick={reload}
          disabled={loading}
          title={tooltip}
        >
          <span className="gh-status-dot" aria-hidden="true" />
          <span className="gh-status-label">
            Azure DevOps · {connectedLabel}
          </span>
        </button>
        <button
          type="button"
          className="az-signin-btn gh-signout-btn"
          onClick={() => void signOut()}
          disabled={signingOut}
          title="Sign out of Azure DevOps on this device"
        >
          {signingOut ? <Spinner size={12} label="Signing out" /> : 'Sign out'}
        </button>
        {error && <p className="az-signin-error">{error}</p>}
      </div>
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

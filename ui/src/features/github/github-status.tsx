import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { GithubStatus } from '../../lib/types.js';
import { GithubSignInModal } from './github-signin.js';

/**
 * Sidebar badge showing the IDE's single GitHub login. Authentication is done
 * once (via `gh`/agency) and every spawned session inherits it automatically,
 * so this is a live status indicator rather than a per-session control.
 *
 * The status is re-checked on an interval and whenever the window regains
 * focus, so a login/logout that happens outside the IDE is reflected without a
 * restart (and a transient failure during startup self-heals).
 */
export function GithubStatusBadge() {
  const api = useApi();
  const [signInOpen, setSignInOpen] = useState(false);
  const { data, loading, reload } = useAsync<GithubStatus>(
    () => api.getGithubStatus(),
    [],
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
  const state = data ? (authenticated ? 'on' : 'off') : loading ? 'checking' : 'off';

  const label =
    state === 'checking'
      ? 'GitHub · checking…'
      : authenticated
        ? `GitHub · ${data?.login ?? 'signed in'}`
        : 'GitHub · sign in required';

  return (
    <div className="gh-status-wrap">
      <button
        type="button"
        className={`gh-status gh-status-${state}`}
        onClick={reload}
        disabled={loading}
        title={
          authenticated
            ? 'Signed in to GitHub. All sessions inherit this login automatically. Click to re-check.'
            : 'Not signed in. Click “Sign in” to authorize this device, or re-check if you signed in elsewhere.'
        }
      >
        <span className="gh-status-dot" aria-hidden="true" />
        <span className="gh-status-label">{label}</span>
      </button>
      {!authenticated && state !== 'checking' && (
        <button
          type="button"
          className="az-signin-btn gh-signin-btn"
          onClick={() => setSignInOpen(true)}
          title="Sign in to GitHub on this device"
        >
          Sign in
        </button>
      )}
      {signInOpen && (
        <GithubSignInModal
          onClose={() => setSignInOpen(false)}
          onAuthenticated={() => {
            setSignInOpen(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

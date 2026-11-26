import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { Spinner } from '../../components/loading.js';
import { Avatar } from '../../components/avatar.js';
import { SignInIcon, SignOutIcon } from '../../components/icons.js';
import { GITHUB_AUTH_CHANGED_EVENT, githubAvatarUrl } from '../../hooks/use-github-identity.js';
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
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const { data, loading, error, reload } = useAsync<GithubStatus>(
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

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      const result = await api.githubSignOut();
      if (result.authenticated) setSignOutError('GitHub sign-out did not complete. Retry signing out.');
    } catch (err) {
      setSignOutError(err instanceof Error ? err.message : 'GitHub sign-out failed.');
    } finally {
      setSigningOut(false);
      reload();
      window.dispatchEvent(new Event(GITHUB_AUTH_CHANGED_EVENT));
    }
  };

  const label =
    error && !data
      ? 'GitHub · status unavailable'
      : state === 'checking'
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
          error
            ? 'GitHub status could not be checked. Click to retry; existing account state was preserved.'
            : authenticated
            ? 'Signed in to GitHub. New sessions inherit the current credential; existing sessions may need restarting. Click to re-check.'
            : 'Not signed in. Click “Sign in” to authorize this device, or re-check if you signed in elsewhere.'
        }
      >
        {authenticated && data?.login ? (
          <Avatar
            name={data.login}
            avatarUrl={githubAvatarUrl(data.login)}
            size={18}
          />
        ) : (
          <span className="gh-status-dot" aria-hidden="true" />
        )}
        <span className="gh-status-label">{label}</span>
      </button>
      {authenticated && (
        <button
          type="button"
          className="az-signin-btn gh-signout-btn"
          onClick={signOut}
          disabled={signingOut}
          title="Sign out of GitHub on this device"
        >
          {signingOut ? (
            <Spinner size={12} label="Signing out" />
          ) : (
            <><SignOutIcon size={12} /> Sign out</>
          )}
        </button>
      )}
      {!authenticated && !error && state !== 'checking' && (
        <button
          type="button"
          className="az-signin-btn gh-signin-btn"
          onClick={() => setSignInOpen(true)}
          title="Sign in to GitHub on this device"
        >
          <SignInIcon size={12} /> Sign in
        </button>
      )}
      {signInOpen && (
        <GithubSignInModal
          onClose={() => setSignInOpen(false)}
          onAuthenticated={() => {
            setSignInOpen(false);
            reload();
            window.dispatchEvent(new Event(GITHUB_AUTH_CHANGED_EVENT));
          }}
        />
      )}
      {(signOutError || error) && <p className="az-signin-error" role="alert">{signOutError || error}</p>}
    </div>
  );
}

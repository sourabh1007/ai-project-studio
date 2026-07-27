import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { GithubStatus } from '../../lib/types.js';

/**
 * Sidebar badge showing the IDE's single GitHub login. Authentication is done
 * once (via `gh`/agency) and every spawned session inherits it automatically,
 * so this is a status indicator rather than a per-session control.
 */
export function GithubStatusBadge() {
  const api = useApi();
  const { data } = useAsync<GithubStatus>(() => api.getGithubStatus(), []);
  const authenticated = data?.authenticated ?? false;

  return (
    <div
      className={`gh-status ${authenticated ? 'gh-status-on' : 'gh-status-off'}`}
      title={
        authenticated
          ? 'Signed in to GitHub. All sessions inherit this login automatically.'
          : 'Not signed in. Run `gh auth login` (or start an agency session) once; all sessions will then authenticate automatically.'
      }
    >
      <span className="gh-status-dot" aria-hidden="true" />
      <span className="gh-status-label">
        {authenticated
          ? `GitHub · ${data?.login ?? 'signed in'}`
          : 'GitHub · sign in required'}
      </span>
    </div>
  );
}

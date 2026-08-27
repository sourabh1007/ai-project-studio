import { useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { ApiError } from '../../lib/api.js';
import type {
  RemoteRepo,
  RepoProvider,
  RepoProvisionMode,
  Repository,
} from '../../lib/types.js';
import { Button, EmptyState, ErrorText, Modal } from '../../components/ui.js';
import { Loader, Spinner } from '../../components/loading.js';
import { RepoIcon } from '../../components/icons.js';
import { GithubSignInModal } from '../github/github-signin.js';

const ORG_STORAGE_KEY = 'azureDevOpsOrg';

function readSavedOrg(): string {
  try {
    return window.localStorage.getItem(ORG_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Suggests a local checkout folder name from a "owner/name" style repo name so
 * the user only has to pick a parent directory rather than type the leaf.
 */
function repoLeaf(name: string): string {
  const parts = name.split('/');
  return parts[parts.length - 1] || name;
}

/**
 * Modal for adding a repository to the workspace. The user browses the
 * repositories available from a provider (GitHub or Azure DevOps), picks one,
 * then either clones it to a folder or points at an existing local checkout.
 * The resulting {@link Repository} becomes a top-level node that features and
 * their sessions are organized under.
 */
export function RepoPicker({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (repo: Repository) => void;
}) {
  const api = useApi();
  const [provider, setProvider] = useState<RepoProvider>('github');
  const [org, setOrg] = useState(readSavedOrg);
  const [orgDraft, setOrgDraft] = useState(org);
  const [selected, setSelected] = useState<RemoteRepo | null>(null);
  const [filter, setFilter] = useState('');
  const [githubSignin, setGithubSignin] = useState(false);
  const [azureSigningIn, setAzureSigningIn] = useState(false);
  const [azureSigninError, setAzureSigninError] = useState<string | null>(null);

  const remote = useAsync<RemoteRepo[]>(
    () =>
      provider === 'github'
        ? api.listGithubRepos()
        : org
          ? api.listAzureRepos(org)
          : Promise.resolve([]),
    [provider, org],
  );

  // A 401 from the repo listing means the provider login is missing/expired —
  // show a sign-in prompt instead of a raw "Internal server error".
  const authRequired =
    remote.cause instanceof ApiError && remote.cause.status === 401;

  async function signInAzure() {
    const target = (org || orgDraft).trim();
    if (azureSigningIn || !target) {
      return;
    }
    setAzureSigningIn(true);
    setAzureSigninError(null);
    try {
      const result = await api.azureSignIn(target);
      if (result.authenticated) {
        setOrg(target);
        remote.reload();
      } else {
        setAzureSigninError(
          result.message ?? 'Sign-in did not complete. Please try again.',
        );
      }
    } catch (err) {
      setAzureSigninError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setAzureSigningIn(false);
    }
  }

  function loadAzure() {
    const next = orgDraft.trim();
    if (!next) {
      return;
    }
    try {
      window.localStorage.setItem(ORG_STORAGE_KEY, next);
    } catch {
      /* storage unavailable; listing still works for this session */
    }
    setFilter('');
    setOrg(next);
  }

  if (selected) {
    return (
      <ProvisionForm
        repo={selected}
        onBack={() => setSelected(null)}
        onClose={onClose}
        onAdded={onAdded}
      />
    );
  }

  const query = filter.trim().toLowerCase();
  const filtered = query
    ? (remote.data ?? []).filter((repo) => repo.name.toLowerCase().includes(query))
    : (remote.data ?? []);

  return (
    <Modal title="Add repository" onClose={onClose}>
      <div className="repo-picker">
        <div className="repo-provider-tabs" role="tablist" aria-label="Provider">
          <button
            type="button"
            role="tab"
            aria-selected={provider === 'github'}
            className={`repo-provider-tab ${provider === 'github' ? 'is-active' : ''}`.trim()}
            onClick={() => {
              setProvider('github');
              setSelected(null);
              setFilter('');
            }}
          >
            GitHub
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={provider === 'azure-devops'}
            className={`repo-provider-tab ${provider === 'azure-devops' ? 'is-active' : ''}`.trim()}
            onClick={() => {
              setProvider('azure-devops');
              setSelected(null);
              setFilter('');
            }}
          >
            Azure DevOps
          </button>
        </div>

        {provider === 'azure-devops' && (
          <div className="repo-org-row">
            <input
              className="input"
              value={orgDraft}
              onChange={(e) => setOrgDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  loadAzure();
                }
              }}
              placeholder="Azure DevOps organization"
              aria-label="Azure DevOps organization"
              spellCheck={false}
            />
            <Button onClick={loadAzure} disabled={!orgDraft.trim()}>
              Load
            </Button>
          </div>
        )}

        {(remote.data?.length ?? 0) > 0 && (
          <div className="repo-search">
            <input
              className="input"
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search repositories"
              aria-label="Search repositories"
              spellCheck={false}
            />
          </div>
        )}

        <div className="repo-list">
          {remote.loading && <Loader label="Loading repositories" />}
          {!remote.loading && authRequired && (
            <RepoAuthPrompt
              provider={provider}
              message={remote.error}
              azureSigningIn={azureSigningIn}
              azureSigninError={azureSigninError}
              onGithubSignIn={() => setGithubSignin(true)}
              onAzureSignIn={() => void signInAzure()}
            />
          )}
          {!remote.loading && !authRequired && (
            <>
              <ErrorText error={remote.error} />
              {provider === 'azure-devops' && !org && (
                <EmptyState message="Enter an organization to list repositories." />
              )}
              {(remote.data?.length ?? 0) === 0 &&
                !remote.error &&
                (org || provider === 'github') && (
                  <EmptyState message="No repositories found." />
                )}
              {(remote.data?.length ?? 0) > 0 && filtered.length === 0 && (
                <EmptyState message="No repositories match your search." />
              )}
              {filtered.map((repo) => (
                <button
                  type="button"
                  key={`${repo.provider}:${repo.remoteUrl}`}
                  className="repo-list-item"
                  onClick={() => setSelected(repo)}
                  title={repo.remoteUrl}
                >
                  <RepoIcon size={14} />
                  <span className="repo-list-name">{repo.name}</span>
                  {repo.defaultBranch && (
                    <span className="repo-list-branch">{repo.defaultBranch}</span>
                  )}
                </button>
              ))}
            </>
          )}
        </div>
      </div>
      {githubSignin && (
        <GithubSignInModal
          onClose={() => setGithubSignin(false)}
          onAuthenticated={() => {
            setGithubSignin(false);
            remote.reload();
          }}
        />
      )}
    </Modal>
  );
}

/**
 * Shown when the repo listing fails with a 401 (the GitHub or Azure DevOps
 * login is missing or expired). Explains that the provider isn't configured and
 * offers a one-click sign-in instead of a bare error string.
 */
function RepoAuthPrompt({
  provider,
  message,
  azureSigningIn,
  azureSigninError,
  onGithubSignIn,
  onAzureSignIn,
}: {
  provider: RepoProvider;
  message: string | null;
  azureSigningIn: boolean;
  azureSigninError: string | null;
  onGithubSignIn: () => void;
  onAzureSignIn: () => void;
}) {
  const label = provider === 'github' ? 'GitHub' : 'Azure DevOps';
  return (
    <div className="repo-auth-prompt" role="status">
      <RepoIcon size={20} />
      <p className="repo-auth-title">{label} isn’t connected</p>
      <p className="repo-auth-message">
        {message ??
          `Sign in to ${label} to browse and add your repositories.`}
      </p>
      {provider === 'github' ? (
        <Button onClick={onGithubSignIn}>Sign in to GitHub</Button>
      ) : (
        <>
          <Button onClick={onAzureSignIn} disabled={azureSigningIn}>
            {azureSigningIn ? (
              <Spinner size={13} label="Signing in" />
            ) : (
              'Sign in to Azure DevOps'
            )}
          </Button>
          {azureSigninError && (
            <p className="repo-auth-error">{azureSigninError}</p>
          )}
        </>
      )}
    </div>
  );
}

function ProvisionForm({
  repo,
  onBack,
  onClose,
  onAdded,
}: {
  repo: RemoteRepo;
  onBack: () => void;
  onClose: () => void;
  onAdded: (repo: Repository) => void;
}) {
  const api = useApi();
  const [mode, setMode] = useState<RepoProvisionMode>('clone');
  const [localPath, setLocalPath] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const path = localPath.trim();
    if (!path) {
      setError('A local folder path is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const added = await api.addRepo({
        provider: repo.provider,
        remoteUrl: repo.remoteUrl,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        localPath: path,
        mode,
      });
      onAdded(added);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Add ${repo.name}`} onClose={onClose}>
      <div className="repo-provision">
        <div className="repo-mode" role="radiogroup" aria-label="How to set up the checkout">
          <label className={`repo-mode-option ${mode === 'clone' ? 'is-active' : ''}`.trim()}>
            <input
              type="radio"
              name="repo-mode"
              checked={mode === 'clone'}
              onChange={() => setMode('clone')}
            />
            <span className="repo-mode-title">Clone to folder</span>
            <span className="repo-mode-hint">
              Clone {repo.remoteUrl} into a new folder.
            </span>
          </label>
          <label className={`repo-mode-option ${mode === 'existing' ? 'is-active' : ''}`.trim()}>
            <input
              type="radio"
              name="repo-mode"
              checked={mode === 'existing'}
              onChange={() => setMode('existing')}
            />
            <span className="repo-mode-title">Use existing checkout</span>
            <span className="repo-mode-hint">
              Point at a folder where this repo is already cloned.
            </span>
          </label>
        </div>

        <div className="field">
          <label htmlFor="repo-local-path">
            {mode === 'clone' ? 'New folder path' : 'Existing checkout path'}
          </label>
          <input
            id="repo-local-path"
            className="input"
            autoFocus
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void submit();
              }
            }}
            placeholder={
              mode === 'clone'
                ? `C:\\repos\\${repoLeaf(repo.name)}`
                : `C:\\repos\\${repoLeaf(repo.name)}`
            }
            spellCheck={false}
          />
        </div>

        <ErrorText error={error} />

        <div className="row modal-actions">
          <Button variant="ghost" onClick={onBack} disabled={submitting}>
            Back
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting
              ? mode === 'clone'
                ? 'Cloning…'
                : 'Adding…'
              : mode === 'clone'
                ? 'Clone & add'
                : 'Add repository'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

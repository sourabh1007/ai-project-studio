import { useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type {
  RemoteRepo,
  RepoProvider,
  RepoProvisionMode,
  Repository,
} from '../../lib/types.js';
import { Button, EmptyState, ErrorText, Modal } from '../../components/ui.js';
import { RepoIcon } from '../../components/icons.js';

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

  const remote = useAsync<RemoteRepo[]>(
    () =>
      provider === 'github'
        ? api.listGithubRepos()
        : org
          ? api.listAzureRepos(org)
          : Promise.resolve([]),
    [provider, org],
  );

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

        <div className="repo-list">
          {remote.loading && <EmptyState message="Loading repositories…" />}
          <ErrorText error={remote.error} />
          {provider === 'azure-devops' && !org && !remote.loading && (
            <EmptyState message="Enter an organization to list repositories." />
          )}
          {!remote.loading && (remote.data?.length ?? 0) === 0 && (org || provider === 'github') && (
            <EmptyState message="No repositories found." />
          )}
          {remote.data?.map((repo) => (
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
        </div>
      </div>
    </Modal>
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

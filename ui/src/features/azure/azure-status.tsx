import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import type { AzureDevOpsStatus } from '../../lib/types.js';
import { azureOrganization as organization, parseAzureOrganizations, AZURE_ORGANIZATIONS_STORAGE_KEY as CONNECTIONS_STORAGE_KEY } from '../../lib/azure.js';
import { Spinner } from '../../components/loading.js';
import { Avatar } from '../../components/avatar.js';
import { PlusIcon } from '../../components/icons.js';
import { Modal } from '../../components/ui.js';
import { AZURE_AUTH_CHANGED_EVENT } from '../../hooks/use-microsoft-identity.js';
import './azure-status.css';

const ORG_STORAGE_KEY = 'azureDevOpsOrg';
const ACCOUNT_STORAGE_KEY = 'azureDevOpsAccount';

function read(key: string): string {
  try { return window.localStorage.getItem(key) ?? ''; } catch { return ''; }
}

function persist(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch { /* Connections remain usable for this window when storage is unavailable. */ }
}

function savedOrganizations(): string[] {
  return parseAzureOrganizations(read(CONNECTIONS_STORAGE_KEY), read(ORG_STORAGE_KEY));
}

function savedAccount(org: string): string | null {
  return read(`${ACCOUNT_STORAGE_KEY}:${org}`)
    || (organization(read(ORG_STORAGE_KEY)) === org ? read(ACCOUNT_STORAGE_KEY) : '') || null;
}

interface ConnectionState {
  data: AzureDevOpsStatus | null;
  loading: boolean;
  error: string | null;
}

/** Multiple organization targets share the native Microsoft-account credential cache. */
export function AzureStatusBadge() {
  const api = useApi();
  const [orgs, setOrgs] = useState(savedOrganizations);
  const [discover] = useState(() => !read(CONNECTIONS_STORAGE_KEY));
  const [states, setStates] = useState<Record<string, ConnectionState>>({});
  const [adding, setAdding] = useState(() => savedOrganizations().length === 0);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { persist(CONNECTIONS_STORAGE_KEY, JSON.stringify(orgs)); }, [orgs]);
  useEffect(() => {
    const sync = () => {
      const saved = savedOrganizations();
      setOrgs((existing) => saved.length === existing.length && saved.every((org, index) => org === existing[index]) ? existing : saved);
    };
    window.addEventListener(AZURE_AUTH_CHANGED_EVENT, sync);
    return () => window.removeEventListener(AZURE_AUTH_CHANGED_EVENT, sync);
  }, []);
  useEffect(() => {
    if (!discover) return;
    let active = true;
    void api.listRepos().then((repos) => {
      if (!active) return;
      const detected = repos.filter((repo) => repo.provider === 'azure-devops')
        .map((repo) => organization(repo.remoteUrl)).filter((org): org is string => Boolean(org));
      setOrgs((existing) => detected.every((org) => existing.includes(org)) ? existing : [...new Set([...existing, ...detected])]);
    }).catch(() => { /* An explicit organization can still be added if repository discovery fails. */ });
    return () => { active = false; };
  }, [api, discover]);

  useEffect(() => {
    if (busy) return;
    let active = true;
    // Sequential checks avoid flooding the backend's bounded native credential runner.
    void (async () => {
      for (const org of orgs) {
        if (!active || busyRef.current) return;
        setStates((previous) => ({
          ...previous, [org]: { data: previous[org]?.data ?? null, loading: true, error: null },
        }));
        try {
          const result = await api.getAzureStatus(org);
          if (!active || busyRef.current) return;
          if (result.authenticated && result.account) persist(`${ACCOUNT_STORAGE_KEY}:${org}`, result.account);
          setStates((previous) => ({
            ...previous, [org]: {
              data: { ...result, account: result.account || previous[org]?.data?.account || savedAccount(org) },
              loading: false, error: null,
            },
          }));
        } catch (err) {
          if (!active || busyRef.current) return;
          setStates((previous) => ({
            ...previous, [org]: {
              data: previous[org]?.data ?? null, loading: false,
              error: err instanceof Error ? err.message : 'Account check failed.',
            },
          }));
        }
      }
    })();
    return () => { active = false; };
  }, [api, orgs, refresh, busy]);

  useEffect(() => {
    const timer = window.setInterval(reload, 30_000);
    window.addEventListener('focus', reload);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', reload); };
  }, [reload]);

  const authenticated = Object.values(states).some((state) => state.data?.authenticated);
  const lastAuth = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (Object.keys(states).length && lastAuth.current !== authenticated) {
      lastAuth.current = authenticated;
      window.dispatchEvent(new Event(AZURE_AUTH_CHANGED_EVENT));
    }
  }, [states, authenticated]);

  const signIn = async (input: string) => {
    if (busyRef.current) return;
    const org = organization(input);
    if (!org) { setError('Enter an Azure DevOps organization or a full HTTPS dev.azure.com / visualstudio.com repository URL.'); return; }
    busyRef.current = true;
    setBusy(org);
    setError(null);
    setOrgs((existing) => existing.includes(org) ? existing : [...existing, org]);
    if (!read(ORG_STORAGE_KEY)) persist(ORG_STORAGE_KEY, org);
    try {
      const result = await api.azureSignIn(org);
      if (!mounted.current) return;
      setStates((previous) => ({
        ...previous, [org]: {
          data: result, loading: false,
          error: result.authenticated ? null : result.message ?? 'Sign-in did not complete. Please try again.',
        },
      }));
      if (result.authenticated) {
        if (result.account) persist(`${ACCOUNT_STORAGE_KEY}:${org}`, result.account);
        setAdding(false);
        setDraft('');
      } else setError(`${org}: ${result.message ?? 'Sign-in did not complete. Please try again.'}`);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      busyRef.current = false;
      if (mounted.current) { setBusy(null); reload(); }
    }
  };

  const signOut = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('signout');
    setConfirmSignOut(false);
    setError(null);
    const failures: string[] = [];
    try {
      for (const org of orgs) {
        try {
          const result = await api.azureSignOut(org);
          if (result.message) failures.push(`${org}: ${result.message}`);
          else persist(`${ACCOUNT_STORAGE_KEY}:${org}`, '');
          if (mounted.current) setStates((previous) => ({
            ...previous, [org]: { data: result, loading: false, error: result.message ?? null },
          }));
        } catch (err) {
          failures.push(`${org}: ${err instanceof Error ? err.message : 'Sign-out failed.'}`);
        }
      }
      if (!failures.length) persist(ACCOUNT_STORAGE_KEY, '');
      if (mounted.current && failures.length) setError(failures.join(' '));
    } finally {
      busyRef.current = false;
      window.dispatchEvent(new Event(AZURE_AUTH_CHANGED_EVENT));
      if (mounted.current) { setBusy(null); reload(); }
    }
  };

  const forget = (org: string) => {
    if (busyRef.current) return;
    const remaining = orgs.filter((entry) => entry !== org);
    setOrgs(remaining);
    setStates((previous) => {
      const next = { ...previous };
      delete next[org];
      return next;
    });
    persist(`${ACCOUNT_STORAGE_KEY}:${org}`, '');
    if (organization(read(ORG_STORAGE_KEY)) === org) {
      persist(ORG_STORAGE_KEY, remaining[0] ?? '');
      persist(ACCOUNT_STORAGE_KEY, '');
    }
    if (!remaining.length) setAdding(true);
  };

  return <div className="az-connections">
    <div className="az-connections-heading">
      <strong>Azure DevOps <span>{orgs.length ? `(${orgs.length})` : ''}</span></strong>
      {!adding && <button type="button" className="az-signin-btn" disabled={Boolean(busy)} onClick={() => { setAdding(true); setError(null); }}>
        <PlusIcon size={12} /> Add organization
      </button>}
    </div>
    <p className="az-connections-hint">One Microsoft account, multiple organizations. Access is checked separately for each organization.</p>
    {orgs.map((org) => {
      const state = states[org];
      const connected = state?.data?.authenticated ?? false;
      const account = state?.data?.account || savedAccount(org);
      return <section className="az-connection" key={org} aria-label={`Azure DevOps organization ${org}`}>
        <div className="az-connection-row">
          <button type="button" className={`gh-status gh-status-${connected ? 'on' : state?.loading ? 'checking' : 'off'}`} onClick={reload}
            disabled={Boolean(busy) || state?.loading} title={`Re-check Azure DevOps access for ${org}`}>
            {connected && account ? <Avatar name={account} size={22} /> : <span className="gh-status-dot" aria-hidden="true" />}
            <span className="az-connection-identity"><strong>{org}</strong><span>Azure DevOps · {connected ? account || org : state?.error ? 'Status unavailable' : !state || state.loading ? 'Checking...' : 'Sign-in required'}</span></span>
          </button>
          <div className="az-connection-actions">
            {state?.data && !connected && <button type="button" className="az-signin-btn" disabled={Boolean(busy)} onClick={() => void signIn(org)}>
              {busy === org ? <Spinner size={12} label="Signing in" /> : 'Sign in'}
            </button>}
            <button type="button" className="az-signin-btn" disabled={Boolean(busy)} onClick={() => forget(org)}
              aria-label={`Forget ${org}`} title="Remove from this list only. Does not erase shared Microsoft credentials.">Forget</button>
          </div>
        </div>
        {state?.error && <>
          <p className="az-signin-error" role="alert">{state.error}</p>
          <button type="button" className="az-signin-btn" disabled={Boolean(busy) || state.loading} onClick={reload}>Retry account check</button>
        </>}
      </section>;
    })}
    {adding && <form className="az-add-organization" onSubmit={(event) => { event.preventDefault(); void signIn(draft); }}>
      <label htmlFor="azure-organization-add">Add an organization</label>
      <div>
        <input id="azure-organization-add" className="az-org-input" value={draft} onChange={(event) => setDraft(event.target.value)}
          placeholder="Organization or full repository URL" spellCheck={false} disabled={Boolean(busy)}
          aria-label="Azure DevOps organization or repository URL" />
        <button type="submit" className="az-signin-btn" disabled={Boolean(busy) || !draft.trim()}>
          {busy && busy !== 'signout' ? <Spinner size={13} label="Signing in" /> : 'Sign in'}
        </button>
        {orgs.length > 0 && <button type="button" className="az-signin-btn" disabled={Boolean(busy)} onClick={() => { setAdding(false); setError(null); }}>Cancel</button>}
      </div>
      <p className="az-connections-hint">Use the organization, not the project. A full repository URL fills in the correct organization.</p>
    </form>}
    {error && <p className="az-signin-error" role="alert">{error}</p>}
    {authenticated && !confirmSignOut && <div className="az-connections-footer">
      <span>Forgetting an entry does not sign out your Microsoft account.</span>
      <button type="button" className="az-signin-btn" disabled={Boolean(busy)} onClick={() => {
        if (orgs.length > 1) setConfirmSignOut(true);
        else void signOut();
      }}>{busy === 'signout' ? <Spinner size={12} label="Signing out" /> : orgs.length > 1 ? 'Sign out saved organizations' : 'Sign out'}</button>
    </div>}
    {confirmSignOut && <Modal title="Sign out Azure DevOps" onClose={() => setConfirmSignOut(false)}>
      <p>These organizations share your Microsoft account credentials. Signing out may also affect other Azure DevOps organizations and new CLI sessions on this device. Existing sessions may need restarting.</p>
      <button type="button" className="az-signin-btn" onClick={() => void signOut()}>Confirm sign out</button>
      <button type="button" className="az-signin-btn" onClick={() => setConfirmSignOut(false)}>Cancel</button>
    </Modal>}
  </div>;
}

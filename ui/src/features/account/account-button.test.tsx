import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { GithubStatus } from '../../lib/types.js';
import { GITHUB_AUTH_CHANGED_EVENT, githubAvatarUrl, useGithubIdentity } from '../../hooks/use-github-identity.js';
import { AccountButton } from './account-button.js';

vi.mock('../azure/azure-status.js', () => ({ AzureStatusBadge: () => <p>Azure DevOps accounts</p> }));

afterEach(cleanup);

function client(status: () => Promise<GithubStatus>): ApiClient {
  return {
    getGithubStatus: vi.fn(status),
    githubSignOut: vi.fn().mockResolvedValue({ authenticated: false }),
  } as unknown as ApiClient;
}

function IdentityLogin() {
  const identity = useGithubIdentity();
  return <span>{identity.checked ? identity.login ?? 'signed out' : 'unchecked'}</span>;
}

describe('AccountButton', () => {
  it('shows the GitHub profile picture and opens the accounts dialog', async () => {
    const api = client(async () => ({ authenticated: true, login: 'octo cat' }));
    render(<ApiProvider value={api}><AccountButton /></ApiProvider>);
    const button = await screen.findByRole('button', { name: 'Accounts: signed in to GitHub as octo cat' });
    expect(button.querySelector('img')).toHaveAttribute('src', 'https://github.com/octo%20cat.png?size=96');
    fireEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Accounts' })).toBeInTheDocument();
    expect(screen.getByText('GitHub account used by every new CLI session')).toBeInTheDocument();
    expect(screen.getByText('Azure DevOps accounts')).toBeInTheDocument();
  });

  it('falls back to initials when the picture cannot load', async () => {
    const api = client(async () => ({ authenticated: true, login: 'octocat' }));
    render(<ApiProvider value={api}><AccountButton /></ApiProvider>);
    const button = await screen.findByRole('button', { name: /signed in to GitHub as octocat/ });
    fireEvent.error(button.querySelector('img')!);
    expect(button.querySelector('img')).toBeNull();
    expect(button).toHaveTextContent('OC');
  });

  it('shows a sign-in cue when signed out and keeps the last identity on failures', async () => {
    let status: () => Promise<GithubStatus> = async () => ({ authenticated: false, login: null });
    const api = client(() => status());
    render(<ApiProvider value={api}><AccountButton /></ApiProvider>);
    expect(screen.getByRole('button', { name: 'Accounts: checking sign-in' })).toBeInTheDocument();
    const button = await screen.findByRole('button', { name: 'Accounts: not signed in to GitHub' });
    expect(button.querySelector('.account-button-badge')).not.toBeNull();
    status = async () => { throw new Error('offline'); };
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(screen.getByRole('button', { name: 'Accounts: not signed in to GitHub' })).toBeInTheDocument();
    status = async () => ({ authenticated: true, login: 'mona' });
    await act(async () => { window.dispatchEvent(new Event(GITHUB_AUTH_CHANGED_EVENT)); });
    expect(await screen.findByRole('button', { name: 'Accounts: signed in to GitHub as mona' })).toBeInTheDocument();
  });
});

describe('useGithubIdentity', () => {
  it('shares one status request between consumers and stops polling when unused', async () => {
    vi.useFakeTimers();
    try {
      const api = client(async () => ({ authenticated: true, login: 'hubot' }));
      const view = render(<ApiProvider value={api}><IdentityLogin /><IdentityLogin /></ApiProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getAllByText('hubot')).toHaveLength(2);
      expect(api.getGithubStatus).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(api.getGithubStatus).toHaveBeenCalledTimes(2);
      view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(api.getGithubStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds a stable avatar URL for a login', async () => {
    expect(githubAvatarUrl('octocat')).toBe('https://github.com/octocat.png?size=96');
    const api = client(async () => ({ authenticated: false, login: 'ignored' }));
    render(<ApiProvider value={api}><IdentityLogin /></ApiProvider>);
    await waitFor(() => expect(screen.getByText('signed out')).toBeInTheDocument());
  });
});

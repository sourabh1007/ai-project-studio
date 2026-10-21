import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileApp, { type MobileChat } from './mobile-app.js';

const terminal = vi.hoisted(() => ({ detach: vi.fn(), mount: vi.fn() }));
vi.mock('../components/terminal-view.js', async () => {
  const { useEffect } = await import('react');
  return { TerminalView: ({ sessionId, apiBase }: { sessionId: string; apiBase: string }) => {
    useEffect(() => {
      terminal.mount(sessionId, apiBase);
      return () => terminal.detach(sessionId);
    }, [sessionId, apiBase]);
    return <p>Live terminal {sessionId}</p>;
  } };
});

function makeChat(overrides: Partial<MobileChat> = {}): MobileChat {
  return {
    id: 'chat-1', repoId: 'repo-1', featureId: 'feature-1', attachmentId: 'attachment-1',
    title: 'Build a useful feature', status: 'plan-ready',
    messages: [{ id: 'message-1', role: 'assistant', text: 'Here is the **plan**.', at: '2026-10-21' }],
    run: { plan: '# Plan\n\n1. Implement\n2. Test', branch: 'feature/mobile', agents: [], planLog: [] },
    planHash: 'exact-plan-hash', proposal: null, files: [], approval: null,
    terminalSessionId: null, terminalRunning: false, error: null,
    createdAt: '2026-10-21', updatedAt: '2026-10-21', ...overrides,
  };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const flush = () => act(async () => {});
let current: MobileChat;
let chats: MobileChat[];
let intercept: ((url: string, init?: RequestInit) => Response | Promise<Response> | undefined) | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  current = makeChat();
  chats = [current];
  intercept = undefined;
  terminal.mount.mockClear();
  terminal.detach.mockClear();
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = intercept?.(url, init);
    if (custom) return await custom;
    if (url === '/api/mobile/bootstrap') return json({
      repositories: [{ id: 'repo-1', name: 'My repository', defaultBranch: 'main' }], chats,
    });
    if (url === '/api/mobile/chats/chat-1' && !init?.method) return json(current);
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountChat() {
  render(<MobileApp />);
  await flush();
  fireEvent.change(screen.getByRole('combobox', { name: 'Open chat' }), { target: { value: 'chat-1' } });
  await flush();
}
async function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
  await flush();
}
const mutations = () => fetchMock.mock.calls.filter(([, init]) => Boolean(init?.method));
async function mountRepositoryForm() {
  render(<MobileApp />);
  await flush();
  fireEvent.click(screen.getByText('Add a GitHub repository on the host'));
}

describe('Mobile chat-first workspace', () => {
  it('shows sign-in and explicit authentication errors without storing access keys', async () => {
    intercept = (url) => url === '/api/mobile/bootstrap'
      ? json({ error: 'Authentication required' }, 401)
      : url === '/mobile/login' ? json({ error: 'Invalid access key' }, 403) : undefined;
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    render(<MobileApp />);
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('Authentication required');
    const input = screen.getByLabelText('Access key');
    expect(input.getAttribute('type')).toBe('password');
    fireEvent.change(input, { target: { value: 'never-save-this-secret' } });
    await click('Sign in');
    expect(screen.getByRole('alert').textContent).toContain('Invalid access key');
    expect((input as HTMLInputElement).value).toBe('');
    expect(fetchMock).toHaveBeenCalledWith('/mobile/login', expect.objectContaining({
      credentials: 'same-origin', method: 'POST', body: JSON.stringify({ key: 'never-save-this-secret' }),
    }));
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });

  it('shows host failures rather than an empty successful bootstrap', async () => {
    intercept = () => json({ error: 'Host database unavailable' }, 500);
    render(<MobileApp />);
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('Host database unavailable');
    expect(screen.getByRole('heading', { name: 'Connect to your workspace' })).toBeTruthy();
  });

  it('signs in with a same-origin cookie, then explicitly signs out', async () => {
    let signedIn = false;
    intercept = (url) => {
      if (url === '/api/mobile/bootstrap' && !signedIn) return json({ error: 'Sign in required' }, 401);
      if (url === '/mobile/login') { signedIn = true; return json({ ok: true }); }
      if (url === '/mobile/logout') return new Response(null, { status: 204 });
      return undefined;
    };
    render(<MobileApp />);
    await flush();
    fireEvent.change(screen.getByLabelText('Access key'), { target: { value: 'key' } });
    await click('Sign in');
    expect(screen.getByRole('button', { name: 'Create plan' })).toBeTruthy();
    await click('Sign out');
    expect(screen.getByRole('heading', { name: 'Connect to your workspace' })).toBeTruthy();
    expect(fetchMock.mock.calls.every(([, init]) => init.credentials === 'same-origin')).toBe(true);
  });

  it('requires explicit host clone confirmation and refreshes/selects the imported repository', async () => {
    const repository = { id: 'imported-repo', name: 'owner/project', remoteUrl: 'https://github.com/owner/project.git', defaultBranch: 'main' };
    let imported = false;
    intercept = (url, init) => {
      if (url === '/api/mobile/repositories') {
        expect(init?.method).toBe('POST');
        expect(init?.credentials).toBe('same-origin');
        expect(JSON.parse(init!.body as string)).toEqual({ name: 'owner/project', confirmed: true });
        imported = true;
        return json(repository);
      }
      if (url === '/api/mobile/bootstrap' && imported) return json({ repositories: [repository], chats });
      return undefined;
    };
    await mountRepositoryForm();
    fireEvent.change(screen.getByLabelText('GitHub owner/repository'), { target: { value: 'owner/project' } });
    const clone = screen.getByRole('button', { name: 'Clone on host' }) as HTMLButtonElement;
    expect(clone.disabled).toBe(true);
    expect(mutations()).toHaveLength(0);
    fireEvent.click(screen.getByRole('checkbox', { name: 'I confirm this repository may be cloned or reused on my host.' }));
    expect(clone.disabled).toBe(false);
    expect(mutations()).toHaveLength(0);
    await click('Clone on host');
    expect(mutations()).toHaveLength(1);
    expect((screen.getByLabelText('Repository') as HTMLSelectElement).value).toBe('imported-repo');
    expect(screen.getByRole('option', { name: 'owner/project' })).toBeTruthy();
    expect((screen.getByLabelText('GitHub owner/repository') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/mobile/bootstrap')).toHaveLength(2);
  });

  it('accepts only owner/repository and resets confirmation when the destination changes', async () => {
    await mountRepositoryForm();
    const input = screen.getByLabelText('GitHub owner/repository');
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    const clone = screen.getByRole('button', { name: 'Clone on host' }) as HTMLButtonElement;
    for (const value of ['https://github.com/owner/project', 'C:\\repos\\project', '../project', 'owner/../project']) {
      fireEvent.change(input, { target: { value } });
      expect(checkbox.disabled).toBe(true);
      expect(clone.disabled).toBe(true);
    }
    fireEvent.change(input, { target: { value: 'owner/project' } });
    fireEvent.click(checkbox);
    expect(clone.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'owner/another-project' } });
    expect(checkbox.checked).toBe(false);
    expect(clone.disabled).toBe(true);
    expect(mutations()).toHaveLength(0);
  });

  it('keeps a slow host clone pending for up to 120 seconds without resubmitting', async () => {
    let complete: (response: Response) => void = () => {};
    intercept = (url) => url === '/api/mobile/repositories'
      ? new Promise<Response>((resolve) => { complete = resolve; }) : undefined;
    await mountRepositoryForm();
    fireEvent.change(screen.getByLabelText('GitHub owner/repository'), { target: { value: 'owner/project' } });
    fireEvent.click(screen.getByRole('checkbox'));
    await click('Clone on host');
    expect(screen.getByRole('status').textContent).toContain('may take up to 120 seconds');
    expect((screen.getByRole('button', { name: 'Clone on host' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(119000); });
    expect(mutations()).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/mobile/bootstrap')).toHaveLength(1);
    await act(async () => { complete(json({ id: 'repo-1', name: 'My repository', defaultBranch: 'main' })); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(mutations()).toHaveLength(1);
  });

  it('requires a repository-list refresh after an ambiguous clone and never retries on reconnect', async () => {
    const repository = { id: 'imported', name: 'owner/project', defaultBranch: 'main' };
    let accepted = false;
    intercept = (url) => {
      if (url === '/api/mobile/repositories') {
        accepted = true;
        return Promise.reject(new Error('Connection lost while cloning'));
      }
      if (url === '/api/mobile/bootstrap' && accepted) return json({ repositories: [repository], chats });
      return undefined;
    };
    await mountRepositoryForm();
    fireEvent.change(screen.getByLabelText('GitHub owner/repository'), { target: { value: 'owner/project' } });
    fireEvent.click(screen.getByRole('checkbox'));
    await click('Clone on host');
    expect(screen.getByRole('alert').textContent).toContain('Connection lost while cloning');
    expect(screen.getByText(/Host checkout outcome is unconfirmed/)).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    await act(async () => { window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(16000); });
    expect(screen.getByText(/Host checkout outcome is unconfirmed/)).toBeTruthy();
    expect(mutations()).toHaveLength(1);
    await click('Refresh repository list');
    expect(screen.queryByText(/Host checkout outcome is unconfirmed/)).toBeNull();
    expect(screen.getByRole('option', { name: 'owner/project' })).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
    expect(mutations()).toHaveLength(1);
  });

  it('shows an explicit rejected clone error without claiming success', async () => {
    intercept = (url) => url === '/api/mobile/repositories' ? json({ error: 'GitHub repository access denied' }, 400) : undefined;
    await mountRepositoryForm();
    fireEvent.change(screen.getByLabelText('GitHub owner/repository'), { target: { value: 'owner/project' } });
    fireEvent.click(screen.getByRole('checkbox'));
    await click('Clone on host');
    expect(screen.getByRole('alert').textContent).toContain('GitHub repository access denied');
    expect(screen.queryByRole('option', { name: 'owner/project' })).toBeNull();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    await act(async () => { window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(16000); });
    expect(mutations()).toHaveLength(1);
  });

  it.each(['failed', 'interrupted'] as const)('retries a missing %s plan only after an explicit user action', async (status) => {
    current = makeChat({ status, run: null, planHash: null });
    chats = [current];
    intercept = (url, init) => {
      if (url.endsWith('/retry-plan')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(init!.body as string)).toEqual({});
        current = makeChat({ status: 'planning', run: null, planHash: null });
        return json(current);
      }
      return undefined;
    };
    await mountChat();
    expect(screen.getByRole('button', { name: 'Retry planning' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
    await act(async () => { window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(4000); });
    expect(mutations()).toHaveLength(0);
    await click('Retry planning');
    expect(screen.getByText('Planning')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry planning' })).toBeNull();
    expect(mutations()).toHaveLength(1);
  });

  it('does not offer plan retry if a failed task already has a plan', async () => {
    current = makeChat({ status: 'failed' });
    chats = [current];
    await mountChat();
    expect(screen.queryByRole('button', { name: 'Retry planning' })).toBeNull();
    expect(mutations()).toHaveLength(0);
  });

  it('creates a plan, polls planning to ready, and requires the exact hash for implementation', async () => {
    chats = [];
    intercept = (url, init) => {
      if (url === '/api/mobile/chats' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body.id).toMatch(/^[a-f0-9-]{36}$/);
        expect(body.repoId).toBe('repo-1');
        expect(body.problem).toBe('Please fix the problem');
        current = makeChat({ status: 'planning' });
        chats = [current];
        return json(current);
      }
      if (url.endsWith('/implement')) {
        expect(JSON.parse(init!.body as string)).toEqual({ planHash: 'exact-plan-hash' });
        current = makeChat({ status: 'implementing' });
        return json(current);
      }
      return undefined;
    };
    render(<MobileApp />);
    await flush();
    fireEvent.change(screen.getByLabelText('Problem'), { target: { value: 'Please fix the problem' } });
    await click('Create plan');
    expect(screen.getByText('Planning')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve plan & implement locally' })).toBeNull();
    current = makeChat();
    await act(async () => { vi.advanceTimersByTime(2000); });
    const approve = screen.getByRole('button', { name: 'Approve plan & implement locally' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type the exact plan hash to approve local implementation'), { target: { value: 'wrong' } });
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type the exact plan hash to approve local implementation'), { target: { value: 'exact-plan-hash' } });
    await click('Approve plan & implement locally');
    expect(screen.getByText('Implementing locally')).toBeTruthy();
    expect(mutations()).toHaveLength(2);
    current = makeChat({ status: 'review-changes', files: [{ path: 'src/a.ts', changeType: 'modified' }] });
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText('Review changes before publication')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prepare publication preview' })).toBeTruthy();
  });

  it('applies only the exact stored proposal explicitly before approval', async () => {
    current = makeChat({ proposal: '# Revised plan\n\nTest more thoroughly.' });
    chats = [current];
    intercept = (url, init) => {
      if (url.endsWith('/apply-plan')) {
        expect(init?.method).toBe('PUT');
        expect(JSON.parse(init!.body as string)).toEqual({ plan: '# Revised plan\n\nTest more thoroughly.' });
        current = makeChat({ planHash: 'new-hash', run: { plan: '# Revised plan\n\nTest more thoroughly.' } });
        return json(current);
      }
      return undefined;
    };
    await mountChat();
    fireEvent.change(screen.getByLabelText('Type the exact plan hash to approve local implementation'), { target: { value: 'exact-plan-hash' } });
    expect((screen.getByRole('button', { name: 'Approve plan & implement locally' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText('Revised plan')).toBeNull();
    await click('Apply revised plan');
    expect(screen.getByText('new-hash')).toBeTruthy();
    expect((screen.getByLabelText('Type the exact plan hash to approve local implementation') as HTMLInputElement).value).toBe('');
  });

  it('requires an authoritative publication preview and sends only its approval ID', async () => {
    current = makeChat({ status: 'review-changes' });
    chats = [current];
    intercept = (url, init) => {
      if (url.endsWith('/publication-preview')) {
        current = makeChat({ status: 'review-changes', approval: {
          id: 'approval-1', head: 'abc123exacthead', remoteUrl: 'https://github.com/owner/project.git', repoId: 'repo-1', branch: 'feature/mobile', baseBranch: 'main',
          title: 'A reviewed feature', body: '## Verified publication body', expiresAt: '2099-01-01T00:00:00Z',
        } });
        return json(current);
      }
      if (url.endsWith('/publish')) {
        expect(JSON.parse(init!.body as string)).toEqual({ approvalId: 'approval-1' });
        current = makeChat({ status: 'pr-created', run: { prUrl: 'https://example.org/pull/42', prNumber: 42 } });
        return json(current);
      }
      return undefined;
    };
    await mountChat();
    expect(screen.queryByRole('button', { name: 'Approve push & create draft PR' })).toBeNull();
    expect(mutations()).toHaveLength(0);
    await click('Prepare publication preview');
    const preview = screen.getByRole('region', { name: 'Publication approval' });
    expect(within(preview).getByText('abc123exacthead')).toBeTruthy();
    expect(within(preview).getByText('https://github.com/owner/project.git')).toBeTruthy();
    expect(within(preview).getByText('repo-1')).toBeTruthy();
    expect(within(preview).getByText('feature/mobile')).toBeTruthy();
    expect(within(preview).getByText('main')).toBeTruthy();
    expect(within(preview).getByText('A reviewed feature')).toBeTruthy();
    expect(within(preview).getByText('Verified publication body')).toBeTruthy();
    await click('Approve push & create draft PR');
    expect(screen.getByRole('link', { name: 'Open draft pull request #42' }).getAttribute('href')).toBe('https://example.org/pull/42');
    expect(mutations()).toHaveLength(2);
  });

  it('never publishes an expired preview', async () => {
    current = makeChat({ status: 'review-changes', approval: {
      id: 'expired', head: 'head', remoteUrl: 'https://github.com/owner/project.git', repoId: 'repo-1', branch: 'branch', baseBranch: 'main', title: 'Title', body: 'Body', expiresAt: '2000-01-01',
    } });
    chats = [current];
    await mountChat();
    expect((screen.getByRole('button', { name: 'Approve push & create draft PR' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('expired');
    expect(mutations()).toHaveLength(0);
  });

  it('reports an ambiguous send, only refreshes on reconnect, and never automatically retries mutations', async () => {
    let accepted = false;
    intercept = (url) => {
      if (url.endsWith('/messages')) {
        accepted = true;
        current = makeChat({ messages: [...current.messages, { id: 'accepted', role: 'user', text: 'Refine this', at: 'now' }] });
        return Promise.reject(new Error('Connection lost after request'));
      }
      return undefined;
    };
    await mountChat();
    fireEvent.change(screen.getByLabelText('Discuss or refine'), { target: { value: 'Refine this' } });
    await click('Send message');
    expect(accepted).toBe(true);
    expect(screen.getByText(/Request outcome is unconfirmed/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
    const body = JSON.parse(mutations()[0][1].body);
    expect(body.id).toMatch(/^[a-f0-9-]{36}$/);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      vi.advanceTimersByTime(16000);
    });
    expect(mutations()).toHaveLength(1);
    expect(screen.getByText(/Request outcome is unconfirmed/)).toBeTruthy();
    await click('Refresh state');
    expect(screen.queryByText(/Request outcome is unconfirmed/)).toBeNull();
    expect(within(screen.getByLabelText('Messages')).getByText('Refine this')).toBeTruthy();
    expect(mutations()).toHaveLength(1);
  });

  it('shows pending requests and prevents duplicate manual submissions', async () => {
    let resolve: (value: Response) => void = () => {};
    intercept = (url) => url.endsWith('/messages') ? new Promise<Response>((done) => { resolve = done; }) : undefined;
    await mountChat();
    fireEvent.change(screen.getByLabelText('Discuss or refine'), { target: { value: 'Please refine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(screen.getByRole('status').textContent).toContain('Waiting for server confirmation');
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(16000); });
    expect(mutations()).toHaveLength(1);
    await act(async () => { resolve(json(makeChat({ status: 'discussing' }))); });
    expect(screen.getByText('Discussing your revision')).toBeTruthy();
  });

  it('requires terminal warning confirmation, detaches on tab switch, and explicitly ends the terminal', async () => {
    intercept = (url, init) => {
      if (url.endsWith('/terminal/close')) {
        current = makeChat();
        return json(current);
      }
      if (url.endsWith('/terminal') && init?.method === 'POST') {
        expect(JSON.parse(init.body as string)).toEqual({ confirmed: true });
        current = makeChat({ terminalRunning: true, terminalSessionId: 'real-session-id' });
        return json(current);
      }
      return undefined;
    };
    await mountChat();
    await click('Terminal');
    expect(screen.queryByText('Live terminal real-session-id')).toBeNull();
    await click('Open terminal…');
    expect(screen.getByText(/Direct commands are not subject/)).toBeTruthy();
    expect(mutations()).toHaveLength(0);
    await click('I understand — start terminal');
    expect(terminal.mount).toHaveBeenCalledWith('real-session-id', '/api');
    await click('Chat');
    expect(terminal.detach).toHaveBeenCalledWith('real-session-id');
    expect(mutations()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Type the exact plan hash to approve local implementation'), { target: { value: 'exact-plan-hash' } });
    expect((screen.getByRole('button', { name: 'Approve plan & implement locally' }) as HTMLButtonElement).disabled).toBe(true);
    await click('Terminal');
    expect(terminal.mount).toHaveBeenCalledTimes(2);
    await click('End terminal');
    expect(screen.queryByText('Live terminal real-session-id')).toBeNull();
    expect(mutations()).toHaveLength(2);
  });

  it('blocks publication while a terminal is live', async () => {
    current = makeChat({ status: 'review-changes', terminalRunning: true, terminalSessionId: 'terminal' });
    chats = [current];
    await mountChat();
    expect((screen.getByRole('button', { name: 'Prepare publication preview' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'End terminal' })).toBeTruthy();
  });

  it('treats terminal session reservation as active even before the PTY is running', async () => {
    current = makeChat({ terminalRunning: false, terminalSessionId: 'reserved-session' });
    chats = [current];
    await mountChat();
    fireEvent.change(screen.getByLabelText('Type the exact plan hash to approve local implementation'), { target: { value: 'exact-plan-hash' } });
    expect((screen.getByRole('button', { name: 'Approve plan & implement locally' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'End terminal' })).toBeTruthy();
  });

  it('explains that published tasks cannot start a new terminal', async () => {
    current = makeChat({ status: 'pr-created' });
    chats = [current];
    await mountChat();
    await click('Terminal');
    expect(screen.getByText(/This published task is frozen/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open terminal…' })).toBeNull();
    expect(mutations()).toHaveLength(0);
  });

  it('renders diff text safely and reports diff-loading failures', async () => {
    current = makeChat({ status: 'review-changes', files: [
      { path: 'src/<unsafe>.tsx', changeType: 'modified' }, { path: 'missing.ts', changeType: 'deleted' },
    ] });
    chats = [current];
    intercept = (url) => {
      if (url.includes('/diff?path=src%2F%3Cunsafe%3E.tsx')) return json({ path: 'src/<unsafe>.tsx', diff: '+<script>alert("x")</script>', content: '<div>safe text</div>' });
      if (url.includes('/diff?path=missing.ts')) return json({ error: 'Diff unavailable' }, 500);
      return undefined;
    };
    await mountChat();
    await click('Changes');
    await click('src/<unsafe>.tsx modified');
    expect(screen.getByLabelText('Unified diff').textContent).toBe('+<script>alert("x")</script>');
    expect(document.querySelector('script')).toBeNull();
    await click('missing.ts deleted');
    expect(screen.getByRole('alert').textContent).toContain('Diff unavailable');
  });

  it('restores interrupted tasks without spinning or restarting them', async () => {
    current = makeChat({ status: 'interrupted', error: 'Host restarted' });
    chats = [current];
    await mountChat();
    expect(screen.getByText('Interrupted — action required')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Host restarted');
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => { window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(2000); });
    expect(mutations()).toHaveLength(0);
  });

  it('does not keep loading or restore stale results after returning to New chat', async () => {
    let complete: (response: Response) => void = () => {};
    intercept = (url, init) => url === '/api/mobile/chats/chat-1' && !init?.method
      ? new Promise<Response>((resolve) => { complete = resolve; }) : undefined;
    await mountChat();
    expect(screen.getByText('Loading chat…')).toBeTruthy();
    await click('New');
    expect(screen.queryByText('Loading chat…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create plan' })).toBeTruthy();
    await act(async () => { complete(json(current)); });
    expect(screen.queryByRole('heading', { name: current.title })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create plan' })).toBeTruthy();
  });

  it.each(['failed', 'plan-ready'] as const)('loads the full %s record before showing actions for a bootstrap summary', async (status) => {
    current = makeChat({ status });
    chats = [{ ...current, messages: [], run: null, files: [], proposal: null, approval: null }];
    let complete: (response: Response) => void = () => {};
    intercept = (url, init) => url === '/api/mobile/chats/chat-1' && !init?.method
      ? new Promise<Response>((resolve) => { complete = resolve; }) : undefined;
    await mountChat();
    expect(fetchMock).toHaveBeenCalledWith('/api/mobile/chats/chat-1', { credentials: 'same-origin' });
    expect(screen.getByText('Loading chat…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry planning' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve plan & implement locally' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Current plan' })).toBeNull();
    await act(async () => { complete(json(current)); });
    expect(screen.queryByText('Loading chat…')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Current plan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry planning' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
    if (status === 'plan-ready') {
      expect((screen.getByRole('button', { name: 'Approve plan & implement locally' }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(mutations()).toHaveLength(0);
  });
});

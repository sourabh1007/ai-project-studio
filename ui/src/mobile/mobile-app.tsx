import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { TerminalView } from '../components/terminal-view.js';
import { AiChatIcon, FilesIcon, PlusIcon, RefreshIcon, SessionIcon, WarningIcon } from '../components/icons.js';
import { renderMarkdownComment } from '../lib/markdown.js';
import './mobile.css';

interface Repository {
  id: string;
  name: string;
  remoteUrl?: string;
  defaultBranch?: string;
}

export interface MobileChat {
  id: string;
  repoId: string;
  featureId: string;
  attachmentId: string;
  title: string;
  status: 'planning' | 'plan-ready' | 'discussing' | 'implementing' | 'review-changes' | 'publishing' | 'pr-created' | 'failed' | 'interrupted';
  messages: { id: string; role: 'user' | 'assistant' | 'system'; text: string; at: string }[];
  run: {
    plan?: string | null;
    branch?: string | null;
    prUrl?: string | null;
    prNumber?: number | null;
    agents?: { title: string; status: string; credits?: number; inputTokens?: number; outputTokens?: number }[];
    planLog?: string[];
  } | null;
  planHash: string | null;
  proposal: string | null;
  files: { path: string; changeType: string }[];
  approval: null | { id: string; head: string; remoteUrl: string; repoId: string; branch: string; baseBranch: string; title: string; body: string; expiresAt: string };
  terminalSessionId: string | null;
  terminalRunning: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Bootstrap { repositories: Repository[]; chats: MobileChat[] }
type Tab = 'Chat' | 'Changes' | 'Terminal';
const activeStatuses: string[] = ['planning', 'discussing', 'implementing', 'publishing'];
const statusLabels: Record<MobileChat['status'], string> = {
  planning: 'Planning', 'plan-ready': 'Plan ready for approval', discussing: 'Discussing your revision',
  implementing: 'Implementing locally', 'review-changes': 'Review changes before publication',
  publishing: 'Publishing approved changes', 'pr-created': 'Pull request created',
  failed: 'Failed — action required', interrupted: 'Interrupted — action required',
};

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function Markdown({ text }: { text: string }) {
  return <div className="mobile-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdownComment(text) }} />;
}

export default function MobileApp() {
  const [auth, setAuth] = useState<'checking' | 'signed-out' | 'signed-in'>('checking');
  const [key, setKey] = useState('');
  const [data, setData] = useState<Bootstrap>({ repositories: [], chats: [] });
  const [chat, setChat] = useState<MobileChat | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [repoId, setRepoId] = useState('');
  const [repositoryName, setRepositoryName] = useState('');
  const [cloneConfirmed, setCloneConfirmed] = useState(false);
  const [cloneUnconfirmed, setCloneUnconfirmed] = useState(false);
  const [problem, setProblem] = useState('');
  const [message, setMessage] = useState('');
  const [approvedHash, setApprovedHash] = useState('');
  const [tab, setTab] = useState<Tab>('Chat');
  const [terminalWarning, setTerminalWarning] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const [filePath, setFilePath] = useState('');
  const [file, setFile] = useState<{ path: string; diff: string; content: string } | null>(null);
  const [fileError, setFileError] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const busy = useRef(false);
  const version = useRef(0);
  const selected = useRef<string | null>(null);
  const createId = useRef<string | null>(null);
  const messageId = useRef<string | null>(null);
  const mounted = useRef(true);

  const request = useCallback(async <T,>(path: string, body?: unknown, method = 'POST'): Promise<T> => {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...(body === undefined ? {} : {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    });
    if (!response.ok) {
      if ((response.status === 401 || response.status === 403) && mounted.current) {
        version.current++;
        setAuth('signed-out');
        setChat(null);
        setData({ repositories: [], chats: [] });
        setKey('');
      }
      let detail = '';
      const text = await response.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: string | { message?: string }; message?: string };
          detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message ?? '';
        } catch {
          detail = `HTTP ${response.status}`;
        }
      }
      throw new RequestError(detail || `Request failed (HTTP ${response.status}).`, response.status);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }, []);

  const report = useCallback((cause: unknown) => {
    if (mounted.current) setError(cause instanceof Error ? cause.message : 'Request failed.');
  }, []);

  const storeChat = useCallback((value: MobileChat) => {
    setChat(value);
    setData((previous) => ({
      ...previous,
      chats: [value, ...previous.chats.filter((entry) => entry.id !== value.id)],
    }));
  }, []);

  const refreshList = useCallback(async () => {
    const snapshot = version.current;
    const value = await request<Bootstrap>('/api/mobile/bootstrap');
    if (mounted.current && version.current === snapshot) {
      setData(value);
      setAuth('signed-in');
      setRepoId((current) => current || value.repositories[0]?.id || '');
    }
  }, [request]);

  const readChat = useCallback(async (id: string) => {
    const snapshot = version.current;
    const value = await request<MobileChat>(`/api/mobile/chats/${encodeURIComponent(id)}`);
    if (mounted.current && version.current === snapshot && selected.current === id) storeChat(value);
  }, [request, storeChat]);

  useEffect(() => {
    mounted.current = true;
    void refreshList().catch((cause) => {
      if (mounted.current) { setAuth('signed-out'); report(cause); }
    });
    return () => { mounted.current = false; version.current++; };
  }, [refreshList, report]);

  useEffect(() => {
    if (auth !== 'signed-in') return;
    const poll = window.setInterval(() => {
      setNow(Date.now());
      if (!busy.current && selected.current) void readChat(selected.current).catch(report);
    }, 2000);
    const listPoll = window.setInterval(() => {
      if (!busy.current) void refreshList().catch(report);
    }, 15000);
    const reconnect = () => {
      if (busy.current) return;
      void refreshList().catch(report);
      if (selected.current) void readChat(selected.current).catch(report);
    };
    window.addEventListener('online', reconnect);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(listPoll);
      window.removeEventListener('online', reconnect);
    };
  }, [auth, readChat, refreshList, report]);

  useEffect(() => {
    setApprovedHash('');
  }, [chat?.id, chat?.planHash]);

  useEffect(() => {
    if (!chat || !filePath || tab !== 'Changes') return;
    let disposed = false;
    setFile(null);
    setFileError('');
    setFileLoading(true);
    void request<{ path: string; diff: string; content: string }>(
      `/api/mobile/chats/${encodeURIComponent(chat.id)}/diff?path=${encodeURIComponent(filePath)}`,
    ).then((value) => { if (!disposed) setFile(value); }).catch((cause) => {
      if (!disposed) setFileError(cause instanceof Error ? cause.message : 'Could not load diff.');
    }).finally(() => { if (!disposed) setFileLoading(false); });
    return () => { disposed = true; };
  }, [chat?.id, chat?.updatedAt, filePath, tab, request]);

  const chooseChat = async (id: string | null) => {
    if (busy.current || unknown) return;
    version.current++;
    selected.current = id;
    setSelectedId(id);
    setChat(null);
    setTab('Chat');
    setTerminalWarning(false);
    setFilePath('');
    setFile(null);
    setMessage('');
    setLoadingChat(Boolean(id));
    messageId.current = null;
    setError('');
    if (!id) return;
    try { await readChat(id); } catch (cause) { report(cause); }
    finally { if (selected.current === id) setLoadingChat(false); }
  };

  const refresh = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending('Refreshing state');
    setError('');
    try {
      await refreshList();
      if (selected.current) await readChat(selected.current);
      setUnknown(false);
      setCloneUnconfirmed(false);
    } catch (cause) { report(cause); }
    finally { busy.current = false; setPending(''); }
  };

  const login = async (event: FormEvent) => {
    event.preventDefault();
    if (busy.current || !key.trim()) return;
    busy.current = true;
    setPending('Signing in');
    setError('');
    const accessKey = key;
    setKey('');
    try {
      await request('/mobile/login', { key: accessKey });
      await refreshList();
      setUnknown(false);
      setCloneUnconfirmed(false);
      if (selected.current) await readChat(selected.current);
    } catch (cause) { report(cause); }
    finally { busy.current = false; setPending(''); }
  };

  const logout = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending('Signing out');
    setError('');
    try {
      await request('/mobile/logout', {});
      version.current++;
      selected.current = null;
      setSelectedId(null);
      setChat(null);
      setData({ repositories: [], chats: [] });
      setAuth('signed-out');
      setKey('');
      setProblem('');
      setMessage('');
      setRepositoryName('');
      setCloneConfirmed(false);
    } catch (cause) { report(cause); }
    finally { busy.current = false; setPending(''); }
  };

  const mutate = async (label: string, path: string, body: unknown, onSuccess?: () => void, method = 'POST') => {
    if (busy.current || unknown) return;
    busy.current = true;
    version.current++;
    setPending(label);
    setError('');
    try {
      const value = await request<MobileChat>(path, body, method);
      if (!mounted.current) return;
      selected.current = value.id;
      setSelectedId(value.id);
      storeChat(value);
      onSuccess?.();
      try { await refreshList(); } catch (cause) { report(cause); }
    } catch (cause) {
      if (mounted.current) {
        report(cause);
        setUnknown(true);
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPending('');
    }
  };

  const createChat = (event: FormEvent) => {
    event.preventDefault();
    if (!repoId || !problem.trim()) return;
    createId.current ??= crypto.randomUUID();
    const id = createId.current;
    selected.current = id;
    setSelectedId(id);
    void mutate('Requesting plan', '/api/mobile/chats', { id, repoId, problem: problem.trim() }, () => {
      createId.current = null;
      setProblem('');
    });
  };
  const cloneRepository = async (event: FormEvent) => {
    event.preventDefault();
    if (busy.current || unknown || !cloneConfirmed || !validRepositoryName) return;
    busy.current = true;
    version.current++;
    setPending('Cloning repository on host (may take up to 120 seconds)');
    setError('');
    setCloneConfirmed(false);
    try {
      const repository = await request<Repository>('/api/mobile/repositories', {
        name: repositoryName.trim(), confirmed: true,
      });
      if (!mounted.current) return;
      setData((previous) => ({
        ...previous, repositories: [...previous.repositories.filter((entry) => entry.id !== repository.id), repository],
      }));
      setRepoId(repository.id);
      setRepositoryName('');
      try { await refreshList(); } catch (cause) { report(cause); }
    } catch (cause) {
      if (mounted.current) {
        report(cause);
        if (!(cause instanceof RequestError) || cause.status >= 500) {
          setUnknown(true);
          setCloneUnconfirmed(true);
        }
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPending('');
    }
  };
  const sendMessage = (event: FormEvent) => {
    event.preventDefault();
    if (!chat || !message.trim()) return;
    messageId.current ??= crypto.randomUUID();
    void mutate('Sending message', `${chatPath}/messages`, { id: messageId.current, text: message.trim() }, () => {
      messageId.current = null;
      setMessage('');
    });
  };

  const disabled = Boolean(pending) || unknown;
  const validRepositoryName = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repositoryName.trim())
    && !['.', '..'].includes(repositoryName.trim().split('/')[1]);
  const chatPath = chat ? `/api/mobile/chats/${encodeURIComponent(chat.id)}` : '';
  const repository = data.repositories.find((entry) => entry.id === chat?.repoId);
  const running = chat ? activeStatuses.includes(chat.status) : false;
  const terminalActive = Boolean(chat?.terminalRunning || chat?.terminalSessionId);
  const ready = chat?.status === 'plan-ready';
  const review = chat?.status === 'review-changes';
  const approval = chat?.approval;
  const approvalExpired = approval ? !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= now : true;
  const canDiscuss = chat && Boolean(chat.run?.plan) && ['plan-ready', 'review-changes', 'failed', 'interrupted'].includes(chat.status);
  const canRetryPlan = chat && ['failed', 'interrupted'].includes(chat.status) && !chat.run?.plan;
  const prUrl = chat?.run?.prUrl;
  const safePrUrl = prUrl && /^https:\/\//i.test(prUrl) ? prUrl : null;

  return (
    <main className="mobile-app">
      <header className="mobile-header">
        <div><strong>AI Project Studio</strong><span>Mobile workspace</span></div>
        {auth === 'signed-in' && <button onClick={() => void logout()} disabled={Boolean(pending)}>Sign out</button>}
      </header>
      <div className="mobile-body">
        <aside className="mobile-warning"><WarningIcon size={18} /><p>Owner access: agents can change files and run tools with your host permissions. Studio workflow approvals separate local implementation from publication; they are not a security sandbox against hostile agents.</p></aside>
        {pending && <p role="status">{pending}… Waiting for server confirmation.</p>}
        {error && <div role="alert" className="mobile-error">{error}</div>}
        {unknown && <aside className="mobile-warning"><p>Request outcome is unconfirmed. It may have been accepted. Refresh state before another action; reconnecting never resends a job.</p></aside>}
        {cloneUnconfirmed && <aside className="mobile-warning"><p>Host checkout outcome is unconfirmed. Refresh the repository list before manually retrying; the repository may already be ready. Reconnecting never retries a clone.</p></aside>}
        {auth === 'checking' ? <p role="status">Checking sign-in…</p> : auth === 'signed-out' ? (
          <form className="mobile-card" onSubmit={(event) => void login(event)}>
            <h1>Connect to your workspace</h1>
            <p>Use the access key from your HTTPS host. The key is not saved on this device.</p>
            <label>Access key<input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} required /></label>
            <button type="submit" className="mobile-primary" disabled={Boolean(pending) || !key.trim()}>Sign in</button>
          </form>
        ) : (
          <>
            <nav className="mobile-toolbar" aria-label="Chat navigation">
              <label className="mobile-chat-picker">Chats<select aria-label="Open chat" value={selectedId ?? ''} disabled={disabled} onChange={(event) => void chooseChat(event.target.value || null)}>
                <option value="">New chat</option>
                {selectedId && !data.chats.some((entry) => entry.id === selectedId) && <option value={selectedId}>Pending chat</option>}
                {data.chats.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} — {statusLabels[entry.status] ?? entry.status}</option>)}
              </select></label>
              <button onClick={() => void chooseChat(null)} disabled={disabled}><PlusIcon size={18} />New</button>
              <button onClick={() => void refresh()} disabled={Boolean(pending)}><RefreshIcon size={18} />Refresh state</button>
            </nav>
            {loadingChat && <p role="status">Loading chat…</p>}
            {!chat && !loadingChat && !selectedId && <details className="mobile-card">
              <summary>Add a GitHub repository on the host</summary>
              <form onSubmit={(event) => void cloneRepository(event)}>
                <label>GitHub owner/repository<input value={repositoryName} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="owner/repository" onChange={(event) => { setRepositoryName(event.target.value); setCloneConfirmed(false); }} required /></label>
                <p>Use owner/repository, not a URL or filesystem path. The host uses its existing GitHub credentials and configured import folder. Existing checkouts are reused non-destructively; nothing is checked out on your phone.</p>
                <label className="mobile-clone-confirmation"><input type="checkbox" checked={cloneConfirmed} disabled={disabled || !validRepositoryName} onChange={(event) => setCloneConfirmed(event.target.checked)} />I confirm this repository may be cloned or reused on my host.</label>
                <button type="submit" className="mobile-primary" disabled={disabled || !validRepositoryName || !cloneConfirmed}>Clone on host</button>
                <button type="button" disabled={Boolean(pending)} onClick={() => void refresh()}>Refresh repository list</button>
              </form>
            </details>}
            {!chat && !loadingChat && !selectedId && (
              <form className="mobile-card" onSubmit={createChat}>
                <h1>What would you like to build?</h1>
                <p>Choose a host-registered GitHub repository and start with a problem. Review the complete plan before approving implementation. All checkouts and tools run on your host, not this phone.</p>
                <label>Repository<select value={repoId} onChange={(event) => setRepoId(event.target.value)} required>
                  <option value="">Choose a repository</option>
                  {data.repositories.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select></label>
                {data.repositories.length === 0 && <p>No repositories are configured on this host.</p>}
                <label>Problem<textarea rows={5} value={problem} onChange={(event) => setProblem(event.target.value)} required /></label>
                <button className="mobile-primary" disabled={disabled || !repoId || !problem.trim()}>Create plan</button>
              </form>
            )}
            {!chat && !loadingChat && selectedId && <p>Chat state has not been confirmed. Use Refresh state to retrieve it.</p>}
            {chat && (
              <>
                <header className="mobile-chat-header">
                  <h1>{chat.title}</h1>
                  <p>{repository?.name ?? chat.repoId} · {chat.run?.branch ?? repository?.defaultBranch ?? 'Branch not assigned'}</p>
                  <strong>{statusLabels[chat.status] ?? `Unknown state: ${chat.status}`}</strong>
                  {running && <p role="status">The host is working. You can leave and return without restarting the job.</p>}
                  {chat.error && <p role="alert" className="mobile-error">{chat.error}</p>}
                  {chat.status === 'interrupted' && <p>The host stopped before this task completed. Review its current state; no job has been restarted.</p>}
                  {canRetryPlan && <div className="mobile-card"><p>No plan is available. Retry planning explicitly; this does not approve implementation or publication.</p><button disabled={disabled || terminalActive} onClick={() => void mutate('Retrying plan', `${chatPath}/retry-plan`, {})}>Retry planning</button></div>}
                  {terminalActive && <aside className="mobile-warning"><p>Terminal access is reserved, even when disconnected or not started yet. End it before agent implementation or publication.</p><button disabled={disabled} onClick={() => void mutate('Ending terminal', `${chatPath}/terminal/close`, {})}>End terminal</button></aside>}
                </header>
                <nav className="mobile-tabs" aria-label="Chat views">
                  {(['Chat', 'Changes', 'Terminal'] as Tab[]).map((value) => <button key={value} aria-pressed={tab === value} onClick={() => { setTab(value); setTerminalWarning(false); }}>
                    {value === 'Chat' ? <AiChatIcon size={18} /> : value === 'Changes' ? <FilesIcon size={18} /> : <SessionIcon size={18} />}{value}
                  </button>)}
                </nav>
                {tab === 'Chat' && (
                  <section aria-label="Chat" className="mobile-chat">
                    <div className="mobile-messages" aria-label="Messages">
                      {chat.messages.map((entry) => <article key={entry.id} className={`mobile-bubble mobile-bubble-${entry.role}`}>
                        <strong>{entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'Assistant' : 'Host'}</strong>
                        <Markdown text={entry.text} />
                      </article>)}
                    </div>
                    {chat.run?.plan && <section className="mobile-card"><h2>Current plan</h2><Markdown text={chat.run.plan} /></section>}
                    {chat.run?.planLog && chat.run.planLog.length > 0 && <details className="mobile-card"><summary>Planner activity</summary>{chat.run.planLog.map((line, index) => <p key={index}>{line}</p>)}</details>}
                    {(ready || chat.proposal) && <section className="mobile-card">
                      <h2>Plan approval</h2>
                      <p>Discuss changes below to request a revision. Apply the host's exact revised proposal explicitly before approving its new hash.</p>
                      {chat.proposal && <><h3>Proposed revised plan</h3><Markdown text={chat.proposal} />
                        <button disabled={disabled || !ready || terminalActive} onClick={() => void mutate('Applying revised plan', `${chatPath}/apply-plan`, { plan: chat.proposal }, () => setApprovedHash(''), 'PUT')}>Apply revised plan</button></>}
                      {chat.planHash && <><p>Current plan hash</p><code className="mobile-hash">{chat.planHash}</code>
                        <label>Type the exact plan hash to approve local implementation<input autoComplete="off" value={approvedHash} onChange={(event) => setApprovedHash(event.target.value)} /></label>
                        <button className="mobile-primary" disabled={disabled || !ready || terminalActive || Boolean(chat.proposal) || approvedHash !== chat.planHash} onClick={() => void mutate('Approving implementation', `${chatPath}/implement`, { planHash: approvedHash }, () => setApprovedHash(''))}>Approve plan &amp; implement locally</button></>}
                    </section>}
                    {review && <section className="mobile-card">
                      <h2>Review changes</h2>
                      <p>Inspect the Changes tab and your host's verification results. Assistant prose is not proof that tests passed. Nothing is pushed until you approve publication.</p>
                      <button disabled={disabled} onClick={() => setTab('Changes')}>Inspect changes</button>
                      <button disabled={disabled || terminalActive} onClick={() => void mutate('Preparing publication preview', `${chatPath}/publication-preview`, {})}>Prepare publication preview</button>
                      {approval && <section aria-label="Publication approval" className="mobile-publication">
                        <h3>Exact publication preview</h3>
                        <dl><dt>HEAD SHA</dt><dd><code>{approval.head}</code></dd><dt>Push destination</dt><dd>{approval.remoteUrl}</dd><dt>Repository ID</dt><dd>{approval.repoId}</dd><dt>Push branch</dt><dd>{approval.branch}</dd><dt>PR base</dt><dd>{approval.baseBranch}</dd><dt>PR title</dt><dd>{approval.title}</dd><dt>Expires</dt><dd>{approval.expiresAt}</dd></dl>
                        <h3>PR body</h3><Markdown text={approval.body} />
                        <p>Push this exact HEAD to the displayed destination and create a draft pull request, not a ready-for-review PR. No merge or PR comments are authorized.</p>
                        {approvalExpired && <p role="alert">This approval expired. Prepare a fresh publication preview.</p>}
                        <button className="mobile-primary" disabled={disabled || terminalActive || approvalExpired} onClick={() => void mutate('Approving publication', `${chatPath}/publish`, { approvalId: approval.id })}>Approve push &amp; create draft PR</button>
                      </section>}
                    </section>}
                    {chat.status === 'pr-created' && <section className="mobile-card"><h2>Draft PR created</h2>{safePrUrl ? <a href={safePrUrl} target="_blank" rel="noopener noreferrer">Open draft pull request{chat.run?.prNumber ? ` #${chat.run.prNumber}` : ''}</a> : <p>The host reports that the draft pull request was created.</p>}</section>}
                    {chat.run?.agents && chat.run.agents.length > 0 && <details className="mobile-card"><summary>Provider-reported agent activity</summary>{chat.run.agents.map((agent, index) => <p key={index}>{agent.title} · {agent.status}{typeof agent.credits === 'number' && ` · ${agent.credits} credits`}{typeof agent.inputTokens === 'number' && ` · ${agent.inputTokens} input tokens`}{typeof agent.outputTokens === 'number' && ` · ${agent.outputTokens} output tokens`}</p>)}</details>}
                    {canDiscuss && <form onSubmit={sendMessage} className="mobile-card mobile-composer">
                      <label>Discuss or refine<textarea rows={3} value={message} onChange={(event) => setMessage(event.target.value)} /></label>
                      <button className="mobile-primary" disabled={disabled || terminalActive || !message.trim()}>Send message</button>
                    </form>}
                    {running && <button disabled={disabled} onClick={() => void mutate('Cancelling work', `${chatPath}/cancel`, {})}>Cancel current work</button>}
                  </section>
                )}
                {tab === 'Changes' && <section aria-label="Changes" className="mobile-card">
                  <h2>Changed files</h2>
                  {chat.files.length === 0 ? <p>No changed files reported by the host.</p> : <ul className="mobile-files">{chat.files.map((entry) => <li key={entry.path}><button aria-pressed={filePath === entry.path} onClick={() => setFilePath(entry.path)}>{entry.path} <span>{entry.changeType}</span></button></li>)}</ul>}
                  {fileLoading && <p role="status">Loading diff…</p>}
                  {fileError && <p role="alert" className="mobile-error">{fileError}</p>}
                  {file && <><h3>{file.path}</h3><pre aria-label="Unified diff">{file.diff || 'No textual diff available.'}</pre><details><summary>Current file content</summary><pre>{file.content}</pre></details></>}
                </section>}
                {tab === 'Terminal' && <section aria-label="Terminal" className="mobile-card">
                  <h2>Full host terminal</h2>
                  <p>Switching tabs disconnects this view, not the host terminal. Use End terminal to stop it.</p>
                  {terminalActive && chat.terminalSessionId ? <div className="mobile-terminal"><TerminalView sessionId={chat.terminalSessionId} apiBase="/api" onExit={() => void readChat(chat.id).catch(report)} /></div> : chat.status === 'pr-created' ? <p>This published task is frozen. Open its draft pull request from Chat to continue reviewing; a new terminal cannot be started for this task.</p> : terminalActive ? <p>Terminal access is reserved. Waiting for the host session; use End terminal to release it.</p> : <>
                    <p>Terminal access is optional and is not required to plan, implement, review, or publish.</p>
                    {!terminalWarning ? <button disabled={disabled || running} onClick={() => setTerminalWarning(true)}>Open terminal…</button> : <aside className="mobile-warning" role="alert">
                      <h3>Direct commands have host permissions</h3>
                      <p>Commands you type can modify files, access credentials, push branches, and create PRs. Direct commands are not subject to the agent publication gate. End the terminal before agent implementation or publication.</p>
                      <button disabled={disabled || running} onClick={() => void mutate('Opening terminal', `${chatPath}/terminal`, { confirmed: true }, () => setTerminalWarning(false))}>I understand — start terminal</button>
                      <button onClick={() => setTerminalWarning(false)}>Keep terminal closed</button>
                    </aside>}
                  </>}
                </section>}
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

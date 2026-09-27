import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText } from '../../components/ui.js';
import { Spinner } from '../../components/loading.js';
import { ToolsIcon } from '../../components/icons.js';
import type { McpServerEntry } from '../../lib/types.js';
import { useMcpAuthentication } from './use-mcp-authentication.js';

export function McpToolsView({ providerId, serverName, onOpenAuth, onBackgroundError, mode = 'tools', initialServer, onObserved, onRequestAuth }: {
  providerId: string;
  serverName: string;
  onOpenAuth: (url: string) => void;
  onBackgroundError: (message: string) => void;
  mode?: 'tools' | 'auth';
  initialServer?: McpServerEntry;
  onObserved?: (server: McpServerEntry) => void;
  onRequestAuth?: () => void;
}) {
  const api = useApi();
  const [server, setServer] = useState<McpServerEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const observed = useRef(onObserved);
  observed.current = onObserved;
  const initial = useRef(initialServer);
  initial.current = initialServer;
  const authentication = useMcpAuthentication(providerId, serverName, {
    onCompleted: (result) => {
      setServer(result);
      setError(null);
      setNotice('Connection ready.');
      observed.current?.(result);
    },
    onBackgroundError,
  });

  useEffect(() => {
    const request = ++epoch.current;
    if (mode === 'auth' && revision === 0 && initial.current?.authentication?.supported) {
      setServer(initial.current);
      setLoading(false);
      setError(null);
      return () => { epoch.current += 1; };
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    setServer(null);
    api.inspectMcpServer(providerId, serverName)
      .then((result) => {
        if (epoch.current === request) {
          setServer(result);
          observed.current?.(result);
        }
      })
      .catch((err: unknown) => {
        if (epoch.current === request) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (epoch.current === request) setLoading(false);
      });
    return () => { epoch.current += 1; };
  }, [api, providerId, serverName, revision, mode]);

  const discovery = server?.toolDiscovery;
  const tools = server?.tools ?? [];
  const failed = Boolean(error) || discovery?.status === 'failed';
  const authRequired = server?.authState
    ? server.authState.state === 'required' || server.authState.state === 'expired'
    : discovery?.authRequired === true;
  const showAuth = mode === 'auth';
  const canConnect = server?.authentication?.supported === true && authRequired;
  const authPending = authentication.job?.status === 'pending';
  const pendingPrompt = authPending && !authentication.busy && !authentication.error && !authentication.expired
    && authentication.job !== null && Date.parse(authentication.job.expiresAt) > Date.now();
  const reportedUrl = pendingPrompt ? authentication.job?.authUrl
    : !server?.builtinName && !authPending && !authentication.job ? discovery?.authUrl : null;
  let authUrl: string | null = null;
  if ((authRequired || pendingPrompt) && reportedUrl) {
    try {
      const url = new URL(reportedUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) authUrl = url.href;
    } catch {
      // Invalid server-provided links are never opened.
    }
  }

  return (
    <div className="mcp-tools-modal" aria-busy={loading || authentication.busy || authPending}>
      <div className="mcp-tools-modal-head">
        <div className="mcp-tools-status-main">
          <p className="mcp-tools-status" role="status">
            {loading ? showAuth ? 'Checking authentication...' : 'Loading tools...' : authPending ? 'Waiting for sign-in...'
              : authRequired ? 'Authentication required'
              : failed ? 'Tool discovery failed' : discovery?.status === 'ok'
                ? showAuth ? 'No sign-in needed for this check.' : 'Available tools'
                  : showAuth && canConnect ? 'Ready to connect' : 'Check unavailable'}
          </p>
          {!showAuth && !loading && tools.length > 0 && <span className="mcp-tools-count-chip">
            {tools.length} tool{tools.length === 1 ? '' : 's'}
          </span>}
        </div>
        <Button variant="ghost" disabled={loading || authentication.busy || authPending} onClick={() => setRevision((value) => value + 1)}>
          {failed ? 'Retry discovery' : showAuth ? 'Check again' : 'Refresh tools'}
        </Button>
      </div>
      {loading && <div className="mcp-operation-progress">
        <Spinner size={22} label={showAuth ? 'Checking authentication' : 'Loading tools'} />
        <div>
          <p>{showAuth ? 'Connecting to check sign-in' : 'Connecting and requesting tools/list'}</p>
          {(server?.commandPreview ?? initialServer?.commandPreview) && (
            <code>{server?.commandPreview ?? initialServer?.commandPreview}</code>
          )}
        </div>
      </div>}
      <ErrorText error={error} />
      <ErrorText error={authentication.error} />
      {server?.configurationConflict && <p className="field-hint">
        Global and resolved settings differ. This inventory uses resolved settings; editing is disabled to avoid changing the wrong configuration.
      </p>}
      {server?.configurationSources && server.configurationSources.length > 0 && (
        <details>
          <summary>Configuration sources</summary>
          {server.configurationSources.map((source) => (
            <div key={source.kind}>
              <p className="field-hint">{source.scope}: {source.source}</p>
              <pre className="mcp-setup-command">{JSON.stringify(source.spec, null, 2)}</pre>
            </div>
          ))}
        </details>
      )}
      {!loading && discovery?.message && <details open={failed || authRequired}><summary>Details</summary><p className="field-hint">{discovery.message}</p></details>}
      {showAuth && !loading && discovery?.status === 'ok' && !authRequired && (
        <p className="field-hint">No reauthentication needed now. Individual tools may require additional permissions.</p>
      )}
      {!showAuth && authRequired && onRequestAuth && <Button variant="danger" onClick={onRequestAuth}>Open authentication</Button>}
      {showAuth && canConnect && !authPending && (
        <Button variant="danger" loading={authentication.busy} onClick={() => void authentication.start()}>
          {authRequired ? 'Continue Agency sign-in' : 'Connect and authenticate'}
        </Button>
      )}
      {showAuth && server?.authentication?.reason && <p className="field-hint">{server.authentication.reason}</p>}
      {showAuth && authentication.job && <section className="mcp-auth-progress" aria-label="Sign-in progress">
        {authPending && <Spinner size={16} label="Waiting for Agency sign-in" />}
        <p role="status">{authentication.job.message}</p>
        {authPending && <p className="field-hint">Complete sign-in. Closing this window cancels the attempt.</p>}
        {authPending && (server?.commandPreview ?? initialServer?.commandPreview) && <code className="mcp-setup-command">{server?.commandPreview ?? initialServer?.commandPreview}</code>}
        {pendingPrompt && authentication.job.deviceCode && <p>Device code: <code>{authentication.job.deviceCode}</code></p>}
        {authentication.expired && authPending && <p role="status">This sign-in prompt has expired. Cancel this attempt, then check tools again; authentication is not confirmed.</p>}
        {authPending && <div className="row">
          <Button variant="ghost" loading={authentication.busy} onClick={() => void authentication.cancel()}>Cancel sign-in</Button>
          {authentication.error && <Button variant="ghost" disabled={authentication.busy} onClick={authentication.retryStatus}>Retry status</Button>}
        </div>}
      </section>}
      {showAuth && (authRequired || pendingPrompt) && <>
        {authUrl ? <Button variant="danger" onClick={() => {
          if (authPending && (!authentication.job || Date.parse(authentication.job.expiresAt) <= Date.now())) {
            setNotice('This sign-in prompt has expired. Check the final connection status before trying again.');
            return;
          }
          onOpenAuth(authUrl);
          setNotice(authPending
            ? 'Sign-in page opened. Waiting for the live connection to return its tool inventory.'
            : 'Sign-in page opened. Complete sign-in, then refresh tools to check the result.');
        }}>Authenticate</Button> : !server?.authentication?.supported && !authPending && <p className="field-hint">
          This server requested authentication but did not provide a usable browser sign-in link.
          {reportedUrl ? ' The supplied link could not be opened safely.' : ''}
        </p>}
      </>}
      {notice && <p className="mcp-notice" role="status">{notice}</p>}
      {!loading && discovery?.output && discovery.output.length > 0 && (
        <pre className="mcp-output">{discovery.output.join('\n')}</pre>
      )}
      {!showAuth && !loading && tools.length > 0 && (
        <ul className="mcp-tool-list" aria-label="Available tools">
          {tools.map((tool) => (
            <li key={tool.name} className="mcp-tool-row">
              <span className="mcp-tool-icon" aria-hidden="true"><ToolsIcon size={15} /></span>
              <span className="mcp-tool-text">
                <strong className="mcp-tool-name">{tool.name}</strong>
                {tool.description && <small className="mcp-tool-desc">{tool.description}</small>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!loading && failed && <p className="mcp-tools-empty">Check failed. Retry when ready.</p>}
      {!showAuth && !loading && !failed && tools.length === 0 && (
        <p className="mcp-tools-empty">{discovery?.status === 'ok'
          ? 'The server returned no tools.' : 'No verified tool inventory is available.'}</p>
      )}
    </div>
  );
}

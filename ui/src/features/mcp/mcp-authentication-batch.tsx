import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText, Modal } from '../../components/ui.js';
import type { McpServerEntry } from '../../lib/types.js';
import { useMcpAuthentication } from './use-mcp-authentication.js';

export interface McpAuthenticationBatchProps {
  providerId: string;
  servers: McpServerEntry[];
  onClose: () => void;
  onOpenAuth: (url: string) => void;
  onBackgroundError: (message: string) => void;
}

type Outcome = 'queued' | 'checking' | 'available' | 'required' | 'unknown' | 'failed' | 'disabled';
interface Row {
  server: McpServerEntry;
  outcome: Outcome;
  message: string | null;
  inspected: boolean;
}

const labels: Record<Outcome, string> = {
  queued: 'Queued',
  checking: 'Checking',
  available: 'Tool access verified',
  required: 'Sign-in required',
  unknown: 'Unknown',
  failed: 'Check failed — access unknown',
  disabled: 'Disabled — not checked',
};

function inspectedRow(server: McpServerEntry): Row {
  const discovery = server.toolDiscovery;
  return {
    server,
    outcome: discovery?.authRequired ? 'required' : discovery?.status === 'ok' ? 'available'
      : discovery?.status === 'failed' ? 'failed' : 'unknown',
    message: discovery?.message ?? null,
    inspected: true,
  };
}

function canAuthenticate(row: Row) {
  return row.inspected && row.server.enabled !== false
    && row.server.toolDiscovery?.authRequired === true
    && row.server.authentication?.supported === true;
}

function safeAuthUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function AuthenticationStep({ providerId, server, onCompleted, onStopped, onStopRequested, onExpired, onOpenAuth, onBackgroundError }: {
  providerId: string;
  server: McpServerEntry;
  onCompleted: (server: McpServerEntry) => void;
  onStopped: (message: string) => void;
  onStopRequested: () => void;
  onExpired: () => void;
  onOpenAuth: (url: string) => void;
  onBackgroundError: (message: string) => void;
}) {
  const auth = useMcpAuthentication(providerId, server.name, { onCompleted, onBackgroundError });
  const latest = useRef({ auth, onStopped, onExpired, onBackgroundError });
  latest.current = { auth, onStopped, onExpired, onBackgroundError };
  const reported = useRef<string | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let active = true;
    // Defer the mutation past StrictMode's setup/cleanup replay.
    void Promise.resolve().then(() => { if (active) void latest.current.auth.start(); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (auth.error && reported.current !== auth.error) {
      reported.current = auth.error;
      latest.current.onBackgroundError(`${server.name}: ${auth.error}`);
    }
    if (!auth.error) reported.current = null;
  }, [auth.error, server.name]);

  useEffect(() => {
    if (auth.job?.status === 'failed' || auth.job?.status === 'cancelled') {
      latest.current.onStopped(auth.job.message || 'Sign-in was not confirmed.');
    } else if (auth.job?.status === 'completed' && !auth.job.server) {
      latest.current.onStopped('Sign-in ended without a verified tool inventory. Access remains unknown.');
    }
  }, [auth.job]);

  useEffect(() => {
    if (auth.expired) latest.current.onExpired();
  }, [auth.expired]);

  const pending = auth.job?.status === 'pending';
  const live = pending && !stopping && !auth.expired && Date.parse(auth.job!.expiresAt) > Date.now();
  const url = live ? safeAuthUrl(auth.job!.authUrl) : null;

  return <section className="mcp-auth" aria-label={`Sign in to ${server.displayName ?? server.name}`}>
    <h3>{server.displayName ?? server.name}</h3>
    <p role="status">{auth.busy ? 'Updating sign-in…'
      : auth.expired ? 'Sign-in expired. Access is not confirmed. Cancel this attempt before starting another.'
        : auth.job?.message ?? (auth.error ? 'Sign-in status unknown.' : 'Starting sign-in…')}</p>
    <ErrorText error={auth.error} />
    {live && <>
      {url && <Button onClick={() => {
        if (latest.current.auth.job?.status === 'pending' && !latest.current.auth.expired
          && Date.parse(latest.current.auth.job.expiresAt) > Date.now()) onOpenAuth(url);
      }}>Open sign-in page</Button>}
      {auth.job?.deviceCode && <p>Device code: <code>{auth.job.deviceCode}</code></p>}
      {auth.job?.authUrl && !url && <p className="field-hint">The supplied sign-in link could not be opened safely.</p>}
    </>}
    {pending && auth.error && !auth.expired && <Button disabled={auth.busy} onClick={auth.retryStatus}>Retry status</Button>}
    <Button variant="ghost" disabled={auth.busy} onClick={() => {
      setStopping(true);
      onStopRequested();
      if (pending) void auth.cancel();
      else onStopped('Sign-in stopped. Access is not confirmed; any server-side attempt remains bounded by expiry.');
    }}>Stop reauthentication</Button>
  </section>;
}

export function McpAuthenticationBatch(props: McpAuthenticationBatchProps) {
  return <AuthenticationBatchSession key={props.providerId} {...props} />;
}

function AuthenticationBatchSession({ providerId, servers, onClose, onOpenAuth, onBackgroundError }: McpAuthenticationBatchProps) {
  const api = useApi();
  const [rows, setRows] = useState<Row[]>(() => servers
    .filter((server) => !server.catalog && Boolean(server.builtinName))
    .map((server) => ({
      server, outcome: server.enabled === false ? 'disabled' : 'queued', message: null, inspected: false,
    })));
  const initialRows = useRef(rows);
  const [checking, setChecking] = useState(true);
  const [closed, setClosed] = useState(false);
  const [active, setActive] = useState<{ server: McpServerEntry; run: number } | null>(null);
  const [authProgress, setAuthProgress] = useState<{ done: number; total: number } | null>(null);
  const epoch = useRef(0);
  const queue = useRef<McpServerEntry[]>([]);
  const locked = useRef(false);
  const run = useRef(0);
  const callbacks = useRef({ onBackgroundError });
  callbacks.current = { onBackgroundError };

  function update(name: string, change: (row: Row) => Row) {
    setRows((current) => current.map((row) => row.server.name === name ? change(row) : row));
  }

  useEffect(() => {
    const request = ++epoch.current;
    let mounted = true;
    void Promise.resolve().then(async () => {
      for (const row of initialRows.current) {
        if (!mounted || request !== epoch.current) return;
        if (row.outcome === 'disabled') continue;
        update(row.server.name, (previous) => ({ ...previous, outcome: 'checking' }));
        try {
          const server = await api.inspectMcpServer(providerId, row.server.name);
          if (!mounted || request !== epoch.current) return;
          update(row.server.name, () => inspectedRow(server));
        } catch (err) {
          if (!mounted || request !== epoch.current) return;
          const message = err instanceof Error ? err.message : String(err);
          update(row.server.name, (previous) => ({ ...previous, outcome: 'failed', message }));
          callbacks.current.onBackgroundError(`${row.server.name}: ${message}`);
        }
      }
      if (mounted && request === epoch.current) setChecking(false);
    });
    return () => { mounted = false; epoch.current += 1; };
  }, [api, providerId]);

  function stopChecking() {
    epoch.current += 1;
    setChecking(false);
    setRows((current) => current.map((row) => row.outcome === 'queued' || row.outcome === 'checking'
      ? { ...row, outcome: 'unknown', message: 'Checking stopped. Any in-flight bounded probe may still finish; its result will be ignored.' }
      : row));
  }

  function close() {
    stopChecking();
    queue.current = [];
    setActive(null);
    setClosed(true);
    onClose();
  }

  function startBatch() {
    if (locked.current || checking || closed) return;
    const required = rows.filter(canAuthenticate).map((row) => row.server);
    if (!required.length) return;
    locked.current = true;
    queue.current = required.slice(1);
    setAuthProgress({ done: 0, total: required.length });
    setActive({ server: required[0], run: ++run.current });
  }

  function stopAuthentication(message: string) {
    if (active) update(active.server.name, (row) => ({ ...row, message }));
    queue.current = [];
    locked.current = false;
    setActive(null);
  }

  function completeAuthentication(server: McpServerEntry) {
    if (!active) return;
    const result = inspectedRow(server);
    update(active.server.name, () => result);
    if (result.outcome !== 'available') {
      callbacks.current.onBackgroundError(`${active.server.name}: Sign-in did not return a verified tool inventory.`);
      stopAuthentication('Sign-in did not return a verified tool inventory. Access is not confirmed.');
      return;
    }
    setAuthProgress((previous) => previous && { ...previous, done: previous.done + 1 });
    const next = queue.current.shift();
    if (next) setActive({ server: next, run: ++run.current });
    else { locked.current = false; setActive(null); }
  }

  if (closed) return null;
  const verified = rows.filter((row) => row.outcome === 'available').length;
  const required = rows.filter((row) => row.outcome === 'required').length;
  const unknown = rows.filter((row) => row.outcome === 'unknown' || row.outcome === 'failed').length;
  const enabled = rows.filter((row) => row.outcome !== 'disabled');
  const checked = enabled.filter((row) => row.inspected || row.outcome === 'failed').length;
  const eligible = rows.filter(canAuthenticate).length;

  return <Modal title="Check configured Agency servers" onClose={close} size="lg">
    <div className="mcp-builtin-setup mcp-tools-modal">
      <p>Check each enabled, configured Agency server using its native MCP tool inventory.
        A check may trigger the server&apos;s own sign-in prompt. Stop checking to skip remaining servers.</p>
      <p className="field-hint">Agency may reuse credentials. Different servers can require separate audiences or permissions.
        Verified tool inventory does not guarantee authorization for every tool.</p>
      <p role="status">{checked} of {enabled.length} checks finished.
        {' '}{verified} tool access verified · {required} sign-in required · {unknown} unknown.</p>
      {checking && <Button variant="ghost" onClick={stopChecking}>Stop checking</Button>}
      {rows.length === 0 && <p>No configured Agency servers to check.</p>}
      <ul className="mcp-tool-list" aria-label="Server check results">
        {rows.map((row) => <li className="mcp-tool-row" key={row.server.name}>
          <div className="mcp-tool-text">
            <strong className="mcp-tool-name">{row.server.displayName ?? row.server.name}</strong>
            <span>{labels[row.outcome]}</span>
            {row.message && <p className="field-hint">{row.message}</p>}
            {row.outcome === 'required' && !row.server.authentication?.supported && <p className="field-hint">
              {row.server.authentication?.reason ?? 'Native sign-in continuation is unavailable for this server.'}
            </p>}
          </div>
        </li>)}
      </ul>
      <Button disabled={checking || Boolean(active) || eligible === 0} onClick={startBatch}>
        Reauthenticate required servers
      </Button>
      {authProgress && <p role="status">{authProgress.done} of {authProgress.total} sign-ins verified.</p>}
      {active && <AuthenticationStep key={active.run} providerId={providerId} server={active.server}
        onCompleted={completeAuthentication} onStopped={stopAuthentication}
        onStopRequested={() => { queue.current = []; }}
        onExpired={() => {
          queue.current = [];
          update(active.server.name, (row) => ({ ...row, message: 'Sign-in expired. Access is not confirmed.' }));
        }}
        onOpenAuth={onOpenAuth} onBackgroundError={onBackgroundError} />}
      <Button variant="ghost" onClick={close}>Close workflow</Button>
    </div>
  </Modal>;
}

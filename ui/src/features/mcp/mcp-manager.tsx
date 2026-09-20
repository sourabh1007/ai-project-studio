import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { McpServerEntry, McpServerStatus } from '../../lib/types.js';
import { desktopBridge } from '../../lib/desktop-bridge.js';
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  IconBadge,
  Modal,
} from '../../components/ui.js';
import { SkeletonCards } from '../../components/loading.js';
import {
  CheckIcon,
  McpIcon,
  PencilIcon,
  PlusIcon,
  RestartIcon,
  SignInIcon,
  ToolsIcon,
  WarningIcon,
} from '../../components/icons.js';
import { McpServerForm } from './mcp-server-form.js';

interface SaveDialogState {
  providerId: string;
  dialogId: number;
}

interface EditDialogState extends SaveDialogState {
  server: McpServerEntry;
}

interface ToolsDialogState {
  providerId: string;
  serverName: string;
}

interface ProviderMessage {
  providerId: string;
  text: string;
}

interface ProviderBusyState {
  providerId: string;
  key: string;
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Opens a URL in the user's default browser via the desktop bridge. */
function openExternal(url: string): void {
  const bridge = desktopBridge();
  if (bridge?.openExternal) {
    bridge.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function ModalErrorText({ error }: { error: string | null }) {
  if (!error) {
    return null;
  }
  return (
    <p className="error-text" role="alert">
      {error}
    </p>
  );
}

function useOwnedAsync<T>(
  ownerKey: string | null,
  loader: () => Promise<T>,
): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<{ ownerKey: string; value: T } | null>(null);
  const [error, setError] = useState<{ ownerKey: string; message: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const requestEpoch = useRef(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const hasResolvedOwner =
    data?.ownerKey === ownerKey || error?.ownerKey === ownerKey;

  useEffect(() => {
    if (!ownerKey) {
      requestEpoch.current += 1;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    const epoch = ++requestEpoch.current;
    setLoading(true);
    setError(null);
    setData((current) => (current?.ownerKey === ownerKey ? current : null));

    loader()
      .then((result) => {
        if (requestEpoch.current !== epoch) {
          return;
        }
        setData({ ownerKey, value: result });
      })
      .catch((loadError: unknown) => {
        if (requestEpoch.current !== epoch) {
          return;
        }
        setError({ ownerKey, message: normalizeError(loadError) });
      })
      .finally(() => {
        if (requestEpoch.current === epoch) {
          setLoading(false);
        }
      });
    return () => {
      requestEpoch.current += 1;
    };
  }, [ownerKey, loader, nonce]);

  return {
    data: data?.ownerKey === ownerKey ? data.value : null,
    error: error?.ownerKey === ownerKey ? error.message : null,
    loading: ownerKey ? loading || !hasResolvedOwner : false,
    reload,
  };
}

/** One-line human summary of a server spec for the card body. */
function describeSpec(spec: Record<string, unknown>): string {
  const url = spec.url;
  if (typeof url === 'string' && url) {
    return url;
  }
  const command = typeof spec.command === 'string' ? spec.command : '';
  const args = Array.isArray(spec.args) ? spec.args.join(' ') : '';
  const summary = `${command} ${args}`.trim();
  return summary || 'No command configured';
}

function specType(spec: Record<string, unknown>): string {
  return typeof spec.type === 'string' && spec.type ? spec.type : 'server';
}

function discoveryLabel(server: McpServerEntry): string {
  const discovery = server.toolDiscovery;
  if (!discovery) return 'Tool discovery has not run yet.';
  if (discovery.status === 'ok') return 'Tools discovered from a live MCP probe.';
  return discovery.message ?? 'Tool discovery did not complete.';
}

export function McpManager() {
  const api = useApi();
  const providers = useAsync(() => api.listMcpProviders(), []);
  const [providerId, setProviderId] = useState<string | null>(null);
  const selectedProviderRef = useRef<string | null>(null);
  const nextDialogIdRef = useRef(0);
  const managerActionEpochRef = useRef(0);

  selectedProviderRef.current = providerId;

  // Default to the first MCP-capable provider once the list resolves.
  useEffect(() => {
    const providerList = providers.data ?? [];
    if (providerList.length === 0) {
      if (!providers.loading) {
        setProviderId(null);
      }
      return;
    }
    if (providerId && providerList.some((provider) => provider.id === providerId)) {
      return;
    }
    setProviderId(providerList[0].id);
  }, [providerId, providers.data, providers.loading]);

  const loadConfig = useCallback(() => {
    if (!providerId) {
      throw new Error('Provider is required');
    }
    return api.getMcpServers(providerId);
  }, [api, providerId]);

  const config = useOwnedAsync(providerId, loadConfig);

  const [creating, setCreating] = useState<SaveDialogState | null>(null);
  const [editing, setEditing] = useState<EditDialogState | null>(null);
  const [toolsTarget, setToolsTarget] = useState<ToolsDialogState | null>(null);
  const [error, setError] = useState<ProviderMessage | null>(null);
  const [busyKey, setBusyKey] = useState<ProviderBusyState | null>(null);
  const [notice, setNotice] = useState<ProviderMessage | null>(null);

  useEffect(() => {
    managerActionEpochRef.current += 1;
    setCreating((current) =>
      current && current.providerId !== providerId ? null : current,
    );
    setEditing((current) =>
      current && current.providerId !== providerId ? null : current,
    );
    setToolsTarget((current) =>
      current && current.providerId !== providerId ? null : current,
    );
    setError((current) =>
      current && current.providerId !== providerId ? null : current,
    );
    setBusyKey((current) =>
      current && current.providerId !== providerId ? null : current,
    );
    setNotice((current) =>
      current && current.providerId !== providerId ? null : current,
    );
  }, [providerId]);

  const providerList = providers.data ?? [];
  const currentConfig = config.data;
  const list = currentConfig?.servers ?? [];
  const loadError = config.error;
  const currentBusyKey = busyKey?.providerId === providerId ? busyKey.key : null;
  const currentError = error?.providerId === providerId ? error.text : null;
  const currentNotice = notice?.providerId === providerId ? notice.text : null;
  const showSkeleton =
    providers.loading || (Boolean(providerId) && config.loading && !currentConfig);
  const showProviderLoadFailure =
    !providers.loading &&
    Boolean(providers.error) &&
    providerList.length === 0;
  const showNoProviders =
    !providers.loading &&
    !providers.error &&
    providerList.length === 0;
  const hasSuccessfulConfigForSelectedProvider =
    currentConfig?.providerId === providerId;
  const canMutateConfig = Boolean(
    providerId &&
      hasSuccessfulConfigForSelectedProvider &&
      !config.loading &&
      !loadError,
  );
  const showConfigLoadFailure =
    !config.loading &&
    Boolean(providerId) &&
    providerList.length > 0 &&
    Boolean(loadError) &&
    list.length === 0;
  const showConfigEmpty =
    !showProviderLoadFailure &&
    !showConfigLoadFailure &&
    !config.loading &&
    Boolean(hasSuccessfulConfigForSelectedProvider) &&
    list.length === 0;
  const headerError =
    currentError ??
    (showProviderLoadFailure ? null : providers.error) ??
    loadError;

  function nextDialogId() {
    nextDialogIdRef.current += 1;
    return nextDialogIdRef.current;
  }

  function openCreate() {
    if (!providerId || !canMutateConfig) {
      return;
    }
    setError(null);
    setNotice(null);
    setCreating({ providerId, dialogId: nextDialogId() });
  }

  function openEdit(server: McpServerEntry) {
    if (!providerId || !canMutateConfig) {
      return;
    }
    setError(null);
    setNotice(null);
    setEditing({ providerId, dialogId: nextDialogId(), server });
  }

  function openTools(serverName: string) {
    if (!providerId || !canMutateConfig) {
      return;
    }
    setError(null);
    setNotice(null);
    setToolsTarget({ providerId, serverName });
  }

  async function save(
    target: SaveDialogState,
    input: { name: string; spec: Record<string, unknown> },
  ) {
    setError(null);
    setNotice(null);
    await api.putMcpServer(target.providerId, input);
    setCreating((current) =>
      current &&
      current.providerId === target.providerId &&
      current.dialogId === target.dialogId
        ? null
        : current,
    );
    setEditing((current) =>
      current &&
      current.providerId === target.providerId &&
      current.dialogId === target.dialogId
        ? null
        : current,
    );
    if (selectedProviderRef.current === target.providerId) {
      config.reload();
    }
  }

  async function restart(server: McpServerEntry) {
    if (!providerId || !canMutateConfig) {
      return;
    }
    const actionEpoch = ++managerActionEpochRef.current;
    setBusyKey({ providerId, key: `restart:${server.name}` });
    setError(null);
    setNotice(null);
    try {
      const result = await api.restartMcpServer(providerId, server.name);
      if (
        managerActionEpochRef.current !== actionEpoch ||
        selectedProviderRef.current !== providerId
      ) {
        return;
      }
      const suffix =
        result.liveReloadCommand && result.liveReloadedSessions > 0
          ? ` Sent ${result.liveReloadCommand} to ${result.liveReloadedSessions} open session(s).`
          : ' No open sessions needed a live reload.';
      setNotice({ providerId, text: `Restarted ${server.name}.${suffix}` });
      config.reload();
    } catch (err) {
      if (
        managerActionEpochRef.current !== actionEpoch ||
        selectedProviderRef.current !== providerId
      ) {
        return;
      }
      setError({ providerId, text: normalizeError(err) });
    } finally {
      if (
        managerActionEpochRef.current === actionEpoch &&
        selectedProviderRef.current === providerId
      ) {
        setBusyKey(null);
      }
    }
  }

  return (
    <Card>
      <div className="page-header">
        <div className="page-header-main">
          <IconBadge icon={<McpIcon size={24} />} tone="accent" size="lg" />
          <div>
            <h2 className="page-title">MCP Servers</h2>
            <p className="page-subtitle">
              Model Context Protocol servers configured for the selected provider.
              The provider’s CLI reports where its config lives, so entries reflect
              the real file it uses.
            </p>
          </div>
        </div>
        <div className="row">
          {providerList.length > 1 && (
            <select
              className="input"
              aria-label="Provider"
              value={providerId ?? ''}
              onChange={(event) => setProviderId(event.target.value)}
            >
              {providerList.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.id}
                </option>
              ))}
            </select>
          )}
          <Button onClick={openCreate} disabled={!canMutateConfig}>
            <span className="btn-icon">
              <PlusIcon size={15} />
            </span>
            Add server
          </Button>
        </div>
      </div>

      <ErrorText error={headerError} />
      {currentNotice && <p className="mcp-notice">{currentNotice}</p>}

      {loadError && list.length > 0 && providerId && (
        <div className="row">
          <p className="field-hint">
            Showing the last loaded MCP configuration for {providerId}. Retry
            before making more changes.
          </p>
          <Button variant="ghost" onClick={config.reload} disabled={config.loading}>
            Retry load
          </Button>
        </div>
      )}

      {currentConfig?.configPath && (
        <p className="field-hint" title={currentConfig.configPath}>
          Config file: <code>{currentConfig.configPath}</code>
          {currentConfig.exists ? '' : ' (not created yet)'}
        </p>
      )}

      {showSkeleton && <SkeletonCards cards={3} />}

      {showProviderLoadFailure && (
        <EmptyState
          icon={<McpIcon size={20} />}
          title="Couldn't load MCP providers"
          description={providers.error ?? 'Retry loading MCP providers.'}
          action={{ label: 'Retry providers', onClick: providers.reload }}
        />
      )}

      {showNoProviders && (
        <EmptyState
          icon={<McpIcon size={20} />}
          title="No providers expose MCP configuration."
          description="Check again after installing or enabling an MCP-capable provider."
          action={{ label: 'Refresh providers', onClick: providers.reload }}
        />
      )}

      {showConfigLoadFailure && (
        <EmptyState
          icon={<McpIcon size={20} />}
          title="Couldn't load MCP servers"
          description="Retry the selected provider's MCP configuration before adding or editing servers."
          action={{ label: 'Retry load', onClick: config.reload }}
        />
      )}

      {showConfigEmpty && (
        <EmptyState
          icon={<McpIcon size={20} />}
          title="No MCP servers configured"
          description="MCP servers extend your sessions with external tools and context. Add your first server to make its tools available."
          action={{ label: 'Add server', onClick: openCreate }}
        />
      )}

      <div className="skill-list">
        {list.map((server) => (
          <McpServerCard
            key={server.name}
            providerId={providerId ?? ''}
            server={server}
            canMutateConfig={canMutateConfig}
            restartBusy={currentBusyKey === `restart:${server.name}`}
            onRestart={() => restart(server)}
            onEdit={() => openEdit(server)}
            onOpenTools={() => openTools(server.name)}
            onNotice={(text) =>
              setNotice({ providerId: providerId ?? '', text })
            }
          />
        ))}
      </div>

      {creating && creating.providerId === providerId && (
        <Modal title="Add MCP server" onClose={() => setCreating(null)}>
          <McpServerForm
            onSubmit={(input) => save(creating, input)}
            onCancel={() => setCreating(null)}
          />
        </Modal>
      )}
      {editing && editing.providerId === providerId && (
        <Modal
          title={`Edit ${editing.server.name}`}
          onClose={() => setEditing(null)}
        >
          <McpServerForm
            initial={editing.server}
            onSubmit={(input) => save(editing, input)}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
      {toolsTarget && toolsTarget.providerId === providerId && (
        <McpToolsModal
          providerId={toolsTarget.providerId}
          serverName={toolsTarget.serverName}
          onClose={() => setToolsTarget(null)}
          onChanged={() => config.reload()}
        />
      )}
    </Card>
  );
}

type StatusTone = 'ok' | 'auth' | 'error' | 'checking' | 'muted';

interface StatusView {
  label: string;
  tone: StatusTone;
}

/** Maps a live status probe to a card badge label + color tone. */
function statusView(
  status: McpServerStatus | null,
  loading: boolean,
  failed: boolean,
): StatusView {
  if (loading && !status) {
    return { label: 'Checking…', tone: 'checking' };
  }
  if (failed) {
    return { label: 'Status unavailable', tone: 'error' };
  }
  if (!status) {
    return { label: 'Not checked', tone: 'muted' };
  }
  switch (status.status) {
    case 'connected':
      return {
        label: `Connected · ${status.toolCount} tool${
          status.toolCount === 1 ? '' : 's'
        }`,
        tone: 'ok',
      };
    case 'auth-required':
      return { label: 'Auth required', tone: 'auth' };
    case 'disabled':
      return { label: 'Disabled', tone: 'muted' };
    case 'unsupported':
      return { label: 'Status unavailable', tone: 'muted' };
    case 'error':
    default:
      return { label: 'Connection failed', tone: 'error' };
  }
}

/**
 * One MCP server card. It probes the server's live connection status on mount
 * (a real spawn, so it happens per card, once, and again only on an explicit
 * restart/re-check) and surfaces connected/tool-count, an auth-required badge,
 * and a one-click sign-in when the server reports it needs authentication.
 */
function McpServerCard({
  providerId,
  server,
  canMutateConfig,
  restartBusy,
  onRestart,
  onEdit,
  onOpenTools,
  onNotice,
}: {
  providerId: string;
  server: McpServerEntry;
  canMutateConfig: boolean;
  restartBusy: boolean;
  onRestart: () => Promise<void>;
  onEdit: () => void;
  onOpenTools: () => void;
  onNotice: (text: string) => void;
}) {
  const api = useApi();
  const [status, setStatus] = useState<McpServerStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const epochRef = useRef(0);

  const probe = useCallback(() => {
    const epoch = ++epochRef.current;
    setLoading(true);
    setFailed(false);
    api
      .getMcpServerStatus(providerId, server.name)
      .then((result) => {
        if (epochRef.current === epoch) {
          setStatus(result);
        }
      })
      .catch(() => {
        if (epochRef.current === epoch) {
          setFailed(true);
        }
      })
      .finally(() => {
        if (epochRef.current === epoch) {
          setLoading(false);
        }
      });
  }, [api, providerId, server.name]);

  useEffect(() => {
    probe();
    return () => {
      epochRef.current += 1;
    };
  }, [probe]);

  async function handleRestart() {
    await onRestart();
    probe();
  }

  function authenticate() {
    if (status?.authUrl) {
      openExternal(status.authUrl);
      onNotice(
        `Opened the sign-in page for ${server.name}. Finish signing in, then re-check.`,
      );
      return;
    }
    onOpenTools();
    onNotice(
      `${server.name} needs authentication. Follow the sign-in steps it prints, then re-check.`,
    );
  }

  const view = statusView(status, loading, failed);
  const needsAuth = status?.status === 'auth-required';
  const canRecheck = !loading && (failed || status?.status === 'error' || needsAuth);

  return (
    <div className="skill-card">
      <div className="skill-card-head">
        <span className="skill-chip skill-chip-instruction">
          {specType(server.spec)}
        </span>
        <div className="skill-card-actions">
          <button
            type="button"
            className="tree-action"
            title="Restart server"
            aria-label={`Restart ${server.name}`}
            disabled={!canMutateConfig || restartBusy}
            onClick={() => void handleRestart()}
          >
            <RestartIcon />
          </button>
          <button
            type="button"
            className="tree-action"
            title="Edit"
            aria-label={`Edit ${server.name}`}
            disabled={!canMutateConfig}
            onClick={onEdit}
          >
            <PencilIcon />
          </button>
        </div>
      </div>
      <span className="skill-card-name" title={server.name}>
        {server.name}
      </span>
      <div className="mcp-status-row">
        <span
          className={`mcp-status mcp-status-${view.tone}`}
          role="status"
          title={status?.message ?? undefined}
        >
          <span className="mcp-status-dot" aria-hidden="true" />
          {view.label}
        </span>
        {canRecheck && (
          <button
            type="button"
            className="mcp-status-recheck"
            onClick={probe}
            aria-label={`Re-check ${server.name}`}
          >
            Re-check
          </button>
        )}
      </div>
      <p className="skill-card-body">{describeSpec(server.spec)}</p>
      {needsAuth && (
        <button
          type="button"
          className="mcp-auth-btn"
          onClick={authenticate}
          title="Authenticate this MCP server"
        >
          <SignInIcon size={14} />
          <span>Authenticate</span>
        </button>
      )}
      <button
        type="button"
        className="mcp-tools-btn"
        disabled={!canMutateConfig}
        onClick={onOpenTools}
        title="View and toggle this server's tools"
      >
        <ToolsIcon size={14} />
        <span>Tools</span>
      </button>
    </div>
  );
}


function McpToolsModal({
  providerId,
  serverName,
  onClose,
  onChanged,
}: {
  providerId: string;
  serverName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const api = useApi();
  const loadProbe = useCallback(
    () => api.inspectMcpServer(providerId, serverName),
    [api, providerId, serverName],
  );
  const probe = useOwnedAsync(`${providerId}\u0000${serverName}`, loadProbe);
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const actionEpochRef = useRef(0);

  useEffect(() => {
    return () => {
      actionEpochRef.current += 1;
    };
  }, [providerId, serverName]);

  const server = probe.data;
  const tools = server?.tools ?? [];
  const canMutateTools = Boolean(server && !probe.loading && !probe.error);
  const showProbeFailure = !probe.loading && Boolean(probe.error);

  async function toggle(toolName: string, enabled: boolean) {
    const actionEpoch = ++actionEpochRef.current;
    setBusyTool(toolName);
    setError(null);
    setNotice(null);
    try {
      const result = await api.setMcpToolEnabled(
        providerId,
        serverName,
        toolName,
        enabled,
      );
      if (actionEpochRef.current !== actionEpoch) {
        return;
      }
      const suffix =
        result.liveReloadCommand && result.liveReloadedSessions > 0
          ? ` Sent ${result.liveReloadCommand} to ${result.liveReloadedSessions} open session(s).`
          : ' It will apply to new sessions; no open sessions were reloaded.';
      setNotice(`${enabled ? 'Enabled' : 'Disabled'} ${toolName}.${suffix}`);
      onChanged();
      probe.reload();
    } catch (err) {
      if (actionEpochRef.current !== actionEpoch) {
        return;
      }
      setError(normalizeError(err));
    } finally {
      if (actionEpochRef.current === actionEpoch) {
        setBusyTool(null);
      }
    }
  }

  async function restart() {
    const actionEpoch = ++actionEpochRef.current;
    setRestarting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.restartMcpServer(providerId, serverName);
      if (actionEpochRef.current !== actionEpoch) {
        return;
      }
      const suffix =
        result.liveReloadCommand && result.liveReloadedSessions > 0
          ? ` Sent ${result.liveReloadCommand} to ${result.liveReloadedSessions} open session(s).`
          : ' No open sessions needed a live reload.';
      setNotice(`Restarted ${serverName}.${suffix}`);
      onChanged();
      probe.reload();
    } catch (err) {
      if (actionEpochRef.current !== actionEpoch) {
        return;
      }
      setError(normalizeError(err));
    } finally {
      if (actionEpochRef.current === actionEpoch) {
        setRestarting(false);
      }
    }
  }

  const status = probe.loading
    ? 'Discovering tools from a live MCP probe…'
    : probe.error
      ? 'Tool discovery is stale or unknown until the next successful probe.'
    : server
      ? discoveryLabel(server)
      : 'Tool discovery did not complete.';

  const tone: 'ok' | 'error' | 'checking' = probe.loading
    ? 'checking'
    : probe.error || server?.toolDiscovery?.status === 'failed'
      ? 'error'
      : server?.toolDiscovery?.status === 'ok'
        ? 'ok'
        : 'checking';
  const ToneIcon =
    tone === 'ok' ? CheckIcon : tone === 'error' ? WarningIcon : McpIcon;

  return (
    <Modal title={`${serverName} · tools`} onClose={onClose} size="lg">
      <div className="mcp-tools-modal">
        <div className="mcp-tools-modal-head">
          <div className="mcp-tools-status-wrap">
            <span
              className={`mcp-tools-status-badge tone-${tone}`}
              aria-hidden="true"
            >
              <ToneIcon size={16} />
            </span>
            <div className="mcp-tools-status-main">
              <p className="mcp-tools-status">{status}</p>
              {!probe.loading && tools.length > 0 && (
                <span className="mcp-tools-count-chip">
                  {tools.length} tool{tools.length === 1 ? '' : 's'} ·{' '}
                  {tools.filter((tool) => tool.enabled).length} enabled
                </span>
              )}
            </div>
          </div>
          <div className="mcp-tools-head-actions">
            <button
              type="button"
              className="ghost-button tone-accent"
              disabled={restarting || !canMutateTools}
              onClick={() => void restart()}
            >
              <RestartIcon size={14} />
              {restarting ? 'Restarting…' : 'Restart'}
            </button>
            {showProbeFailure && (
              <button
                type="button"
                className="ghost-button"
                onClick={probe.reload}
              >
                Retry discovery
              </button>
            )}
          </div>
        </div>
        <ModalErrorText error={error ?? probe.error} />
        {notice && <p className="mcp-notice">{notice}</p>}
        {probe.loading && <SkeletonCards cards={2} />}
        {server?.toolDiscovery?.output &&
          server.toolDiscovery.output.length > 0 && (
            <pre className="mcp-output">
              {server.toolDiscovery.output.join('\n')}
            </pre>
          )}
        {!probe.loading && tools.length > 0 && (
          <div className="mcp-tool-list">
            {tools.map((tool) => (
              <label
                key={tool.name}
                className={`mcp-tool-row${tool.enabled ? ' is-on' : ''}`}
              >
                <span className="mcp-tool-icon" aria-hidden="true">
                  <ToolsIcon size={15} />
                </span>
                <span className="mcp-tool-text">
                  <strong className="mcp-tool-name">{tool.name}</strong>
                  {tool.description && (
                    <small className="mcp-tool-desc">{tool.description}</small>
                  )}
                </span>
                <input
                  type="checkbox"
                  className="mcp-tool-toggle"
                  checked={tool.enabled}
                  disabled={!canMutateTools || busyTool === tool.name}
                  onChange={(event) =>
                    void toggle(tool.name, event.target.checked)
                  }
                />
              </label>
            ))}
          </div>
        )}
        {showProbeFailure && (
          <p className="mcp-tools-empty">
            Current tool availability is unknown. Retry discovery before changing
            tools.
          </p>
        )}
        {!probe.loading && !probe.error && tools.length === 0 && (
          <p className="mcp-tools-empty">
            No tools discovered. Restart to retry and surface any auth prompt.
          </p>
        )}
      </div>
    </Modal>
  );
}

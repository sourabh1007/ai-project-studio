import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { McpServerEntry } from '../../lib/types.js';
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
  McpIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  ToolsIcon,
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
          <div key={server.name} className="skill-card">
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
                  disabled={
                    !canMutateConfig ||
                    currentBusyKey === `restart:${server.name}`
                  }
                  onClick={() => void restart(server)}
                >
                  <RefreshIcon />
                </button>
                <button
                  type="button"
                  className="tree-action"
                  title="Edit"
                  aria-label={`Edit ${server.name}`}
                  disabled={!canMutateConfig}
                  onClick={() => openEdit(server)}
                >
                  <PencilIcon />
                </button>
              </div>
            </div>
            <span className="skill-card-name" title={server.name}>
              {server.name}
            </span>
            <p className="skill-card-body">{describeSpec(server.spec)}</p>
            <button
              type="button"
              className="mcp-tools-btn"
              disabled={!canMutateConfig}
              onClick={() => openTools(server.name)}
              title="View and toggle this server's tools"
            >
              <ToolsIcon size={14} />
              <span>Tools</span>
            </button>
          </div>
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

/**
 * Discovers one server's tools on demand. Tool discovery spawns the configured
 * MCP server, so it must never run while merely listing servers — it happens
 * here, only once the user opens a server, with a live loading state.
 */
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

  return (
    <Modal title={`${serverName} · tools`} onClose={onClose}>
      <div className="mcp-tools-modal">
        <div className="mcp-tools-modal-head">
          <p className="mcp-tools-status">{status}</p>
          <button
            type="button"
            className="ghost-button"
            disabled={restarting || !canMutateTools}
            onClick={() => void restart()}
          >
            <RefreshIcon size={13} />
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
              <label key={tool.name} className="mcp-tool-row">
                <input
                  type="checkbox"
                  checked={tool.enabled}
                  disabled={!canMutateTools || busyTool === tool.name}
                  onChange={(event) =>
                    void toggle(tool.name, event.target.checked)
                  }
                />
                <span className="mcp-tool-text">
                  <strong>{tool.name}</strong>
                  {tool.description && (
                    <small className="mcp-tool-desc">{tool.description}</small>
                  )}
                </span>
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

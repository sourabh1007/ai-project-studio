import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type {
  McpServerEntry,
  McpServerStatus,
  McpHealAttempt,
  McpCapabilities,
  McpCapability,
  McpOperation,
} from '../../lib/types.js';
import { desktopBridge } from '../../lib/desktop-bridge.js';
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  IconBadge,
  Modal,
} from '../../components/ui.js';
import { SkeletonCards, Spinner } from '../../components/loading.js';
import {
  CheckIcon,
  McpIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  RestartIcon,
  SignInIcon,
  ToolsIcon,
  TrashIcon,
  WarningIcon,
} from '../../components/icons.js';
import { McpServerForm } from './mcp-server-form.js';
import { McpBuiltinSetup } from './mcp-builtin-setup.js';
import { McpToolsView } from './mcp-tools-view.js';
import { McpAuthenticationBatch } from './mcp-authentication-batch.js';

const SERVER_SECTIONS = [
  { origin: 'app', title: 'App MCP servers', label: 'This app' },
  { origin: 'agency-built-in', title: 'Agency built-in MCP servers', label: 'Agency' },
  { origin: 'custom', title: 'Custom MCP servers', label: 'Custom' },
] as const;

interface SaveDialogState {
  providerId: string;
  dialogId: number;
}

interface EditDialogState extends SaveDialogState {
  server: McpServerEntry;
}

interface ToolsDialogState {
  providerId: string;
  requestProviderId?: string;
  serverName: string;
  displayName: string;
  mode: 'tools' | 'auth';
  server: McpServerEntry;
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

function isStudioBridge(server: McpServerEntry): boolean {
  return server.origin === 'app' && (server.displayName ?? server.name) === 'ai-project-studio';
}

const OPERATION_LABELS: Record<McpOperation, string> = {
  add: 'Add servers', edit: 'Edit configuration', remove: 'Remove configuration',
  toggle: 'Enable / disable', tools: 'Inspect tools', toolToggle: 'Enable / disable tools',
  restart: 'Reconnect live sessions',
};

function capability(operation: McpOperation, ...layers: (McpCapabilities | undefined)[]): McpCapability {
  for (const layer of layers) {
    if (layer?.[operation]) return layer[operation];
  }
  return { supported: false, reason: 'This source has not reported support for this operation.' };
}

function CapabilityDetails({ capabilities }: { capabilities?: McpCapabilities }) {
  return (
    <details className="mcp-capabilities">
      <summary>Supported operations and limitations</summary>
      <dl>
        {(Object.keys(OPERATION_LABELS) as McpOperation[]).map((operation) => {
          const entry = capability(operation, capabilities);
          return (
            <div key={operation}>
              <dt>{OPERATION_LABELS[operation]}</dt>
              <dd>{entry.supported ? 'Available' : 'Not available here'}{entry.reason ? ` - ${entry.reason}` : ''}</dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
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

export function McpManager() {
  const api = useApi();
  const providers = useAsync(() => api.listMcpProviders(), []);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
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
  const [removing, setRemoving] = useState<EditDialogState | null>(null);
  const [configuring, setConfiguring] = useState<EditDialogState | null>(null);
  const [toolsTarget, setToolsTarget] = useState<ToolsDialogState | null>(null);
  const [observations, setObservations] = useState<Record<string, McpServerEntry>>({});
  const [authenticationBatch, setAuthenticationBatch] = useState<{ providerId: string; servers: McpServerEntry[] } | null>(null);
  const [error, setError] = useState<ProviderMessage | null>(null);
  const [busyKey, setBusyKey] = useState<ProviderBusyState | null>(null);
  const [notice, setNotice] = useState<ProviderMessage | null>(null);

  useEffect(() => {
    managerActionEpochRef.current += 1;
    setSearch('');
    setCreating((current) =>
      current && current.providerId !== providerId ? null : current,
    );
    setEditing((current) =>
      current && current.providerId !== providerId ? null : current,
    );
    setRemoving((current) => current && current.providerId !== providerId ? null : current);
    setConfiguring((current) => current && current.providerId !== providerId ? null : current);
    setToolsTarget((current) =>
      current && current.providerId !== providerId ? null : current,
    );
    setAuthenticationBatch((current) => current && current.providerId !== providerId ? null : current);
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
  const selectedProvider = providerList.find((provider) => provider.id === providerId);
  const capabilities = currentConfig?.capabilities ?? selectedProvider?.capabilities;
  const categoryLabel = selectedProvider?.label ?? providerId ?? 'MCP servers';
  const documentationUrl = selectedProvider?.documentationUrl;
  const list = currentConfig?.servers ?? [];
  const configuredCount = list.filter((server) => !server.catalog).length;
  const catalogCount = list.length - configuredCount;
  const configuredBuiltins = list.filter((server) => !server.catalog
    && (server.origin === 'agency-built-in' || Boolean(server.builtinName)));
  const query = search.trim().toLowerCase();
  const visibleServers = list.filter((server) => [
    server.displayName ?? server.name, server.providerLabel, server.scope,
    typeof server.spec.description === 'string' ? server.spec.description : '',
  ].some((value) => value?.toLowerCase().includes(query)));
  const sourceNotices = [...new Set(currentConfig?.notices ?? [])];
  const sections = SERVER_SECTIONS.map((section) => ({
    ...section,
    servers: visibleServers.filter((server) =>
      (server.origin ?? (server.catalog ? 'agency-built-in' : selectedProvider?.kind === 'app' ? 'app' : 'custom')) === section.origin),
  })).filter((section) => section.servers.length > 0);
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
    if (!providerId || !canMutateConfig || !capability('add', capabilities).supported) {
      return;
    }
    setError(null);
    setNotice(null);
    setCreating({ providerId, dialogId: nextDialogId() });
  }

  function openEdit(server: McpServerEntry) {
    if (!providerId || !canMutateConfig || !capability('edit', server.capabilities, capabilities).supported) {
      return;
    }
    setError(null);
    setNotice(null);
    if (server.builtinName) {
      setConfiguring({ providerId, dialogId: nextDialogId(), server });
      return;
    }
    setEditing({ providerId, dialogId: nextDialogId(), server });
  }

  function openTools(server: McpServerEntry, mode: 'tools' | 'auth' = 'tools') {
    if (!providerId || !canMutateConfig || (!isStudioBridge(server) && !capability('tools', server.capabilities, capabilities).supported)) {
      return;
    }
    setError(null);
    setNotice(null);
    setToolsTarget({
      providerId, requestProviderId: isStudioBridge(server) ? 'studio' : providerId,
      serverName: isStudioBridge(server) ? 'ai-project-studio' : server.name, displayName: server.displayName ?? server.name,
      mode, server,
    });
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
      setNotice({ providerId: target.providerId, text: 'Configuration saved. Existing CLI sessions are unchanged; start a new session to load the changes.' });
    }
  }

  async function toggleServer(server: McpServerEntry, enabled: boolean) {
    if (!providerId || !capability('toggle', server.capabilities, capabilities).supported) return;
    await api.setMcpServerEnabled(providerId, server.name, enabled);
    if (selectedProviderRef.current === providerId) {
      config.reload();
      setNotice({ providerId, text: `${server.displayName ?? server.name} ${enabled ? 'enabled' : 'disabled'} in configuration. Existing CLI sessions are unchanged.` });
    }
  }

  async function restart(server: McpServerEntry) {
    if (!providerId || !canMutateConfig || !capability('restart', server.capabilities, capabilities).supported) {
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
          : ' No live CLI session was restarted.';
      setNotice({ providerId, text: result.message ?? `Operation completed for ${server.displayName ?? server.name}.${suffix}` });
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
    <Card className="mcp-manager">
      <div className="page-header">
        <div className="page-header-main">
          <IconBadge icon={<McpIcon size={24} />} tone="accent" size="lg" />
          <div>
            <h2 className="page-title">MCP Servers</h2>
            <p className="page-subtitle">
              Manage MCP configuration by CLI or app. Each source keeps its own
              settings, supported actions and session lifecycle.
            </p>
          </div>
        </div>
        <div className="row">
          {providerList.length > 0 && (
            <label className="mcp-category-select">
              Category
            <select
              className="select"
              aria-label="Provider"
              value={providerId ?? ''}
              onChange={(event) => setProviderId(event.target.value)}
            >
              {providerList.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label ?? provider.id}
                </option>
              ))}
            </select>
            </label>
          )}
          <Button onClick={openCreate} disabled={!canMutateConfig || !capability('add', capabilities).supported}
            title={capability('add', capabilities).reason ?? undefined}>
            <span className="btn-icon">
              <PlusIcon size={15} />
            </span>
            Add server
          </Button>
        </div>
      </div>

      {selectedProvider && (
        <section className="mcp-category-context" aria-label={`${categoryLabel} category`}>
          <h3>{categoryLabel}</h3>
          {selectedProvider.description && <p>{selectedProvider.description}</p>}
          <p className="field-hint">
            {config.loading ? 'Loading servers...' : `${configuredCount} configured ${configuredCount === 1 ? 'entry' : 'entries'}${catalogCount ? ` · ${catalogCount} available MCP servers` : ''}.`}
            {' '}{selectedProvider.kind === 'app'
              ? 'App-owned tool definitions are separate from CLI configuration.'
              : 'Connection checks are explicit, independent probes, not the status of an existing CLI session.'}
          </p>
          {documentationUrl && (
            <button type="button" className="mcp-doc-link" onClick={() => openExternal(documentationUrl)}>
              Official documentation
            </button>
          )}
          <CapabilityDetails capabilities={capabilities} />
        </section>
      )}
      <ErrorText error={headerError} />
      {currentNotice && <p className="mcp-notice">{currentNotice}</p>}
      {(sourceNotices.length > 0 || currentConfig?.configPath) && (
        <details className="mcp-source-details">
          <summary>Configuration sources and notes{sourceNotices.length ? ` (${sourceNotices.length})` : ''}</summary>
          {sourceNotices.map((text) => <p key={text} className="mcp-source-notice">{text}</p>)}
          {currentConfig?.configPath && (
            <p className="field-hint">
              Configuration source: <code>{currentConfig.configPath}</code>
              {currentConfig.exists ? '' : ' (not created yet)'}
            </p>
          )}
        </details>
      )}

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
          description="No entries were found in this source. Other scopes and running sessions may have additional servers; see the source limitations above."
          action={capability('add', capabilities).supported ? { label: 'Add server', onClick: openCreate } : undefined}
        />
      )}

      {list.length > 0 && (
        <div className="mcp-list-toolbar">
          <label htmlFor="mcp-server-search">MCP servers</label>
          <input id="mcp-server-search" className="input" type="search" value={search}
            onChange={(event) => setSearch(event.target.value)} placeholder="Filter servers..." />
          <span className="field-hint">{visibleServers.length} of {list.length}</span>
        </div>
      )}
      {list.length > 0 && visibleServers.length === 0 && <p role="status">No MCP servers match this filter.</p>}
      {sections.map((section) => (
        <section className="mcp-provider-section" key={section.origin} aria-label={section.title}>
          <div className="mcp-section-toolbar">
            <h3 className="mcp-provider-heading">{section.title} <span>{section.servers.length}</span></h3>
            {section.origin === 'agency-built-in' && configuredBuiltins.length > 0 && (
              <Button variant="ghost" disabled={!canMutateConfig}
                onClick={() => {
                  if (providerId) setAuthenticationBatch({ providerId, servers: configuredBuiltins });
                }}>Check all configured servers</Button>
            )}
          </div>
          <div className="skill-list">
        {section.servers.map((server) => (
          <McpServerCard
            key={`${providerId}:${server.name}`}
            providerId={providerId ?? ''}
            server={server}
            providerLabel={section.label}
            capabilities={server.capabilities ?? capabilities}
            canMutateConfig={canMutateConfig}
            restartBusy={currentBusyKey === `restart:${server.name}`}
            onRestart={() => restart(server)}
            onEdit={() => openEdit(server)}
            onOpenTools={() => openTools(server)}
            onOpenAuth={() => openTools(server, 'auth')}
            observed={observations[`${providerId}:${server.name}:${JSON.stringify(server.spec)}`]}
            onToggle={(enabled) => toggleServer(server, enabled)}
            onConfigure={() => {
              if (providerId && capability('add', server.capabilities, capabilities).supported) {
                setConfiguring({ providerId, server, dialogId: nextDialogId() });
              }
            }}
            onRemove={() => {
              if (providerId && capability('remove', server.capabilities, capabilities).supported) {
                setRemoving({ providerId, server, dialogId: nextDialogId() });
              }
            }}
            onNotice={(text) =>
              setNotice({ providerId: providerId ?? '', text })
            }
          />
        ))}
          </div>
        </section>
      ))}

      {configuring && configuring.providerId === providerId && (
        <McpBuiltinSetup
          key={`${configuring.providerId}:${configuring.dialogId}`}
          providerId={configuring.providerId}
          server={configuring.server}
          onClose={() => setConfiguring(null)}
          onConfigured={() => {
            if (selectedProviderRef.current === configuring.providerId) {
              config.reload();
              setNotice({ providerId: configuring.providerId, text: `${configuring.server.displayName ?? configuring.server.name} configured and verified.` });
            }
          }}
        />
      )}
      {creating && creating.providerId === providerId && (
        <Modal title="Add MCP server" onClose={() => setCreating(null)}>
          <McpServerForm
            categoryLabel={categoryLabel}
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
            categoryLabel={categoryLabel}
            onSubmit={(input) => save(editing, input)}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
      {removing && removing.providerId === providerId && (
        <RemoveMcpServerDialog
          target={removing}
          categoryLabel={categoryLabel}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving((current) => current?.dialogId === removing.dialogId ? null : current);
            if (selectedProviderRef.current === removing.providerId) config.reload();
          }}
        />
      )}
      {toolsTarget && toolsTarget.providerId === providerId && (
        <Modal title={`${toolsTarget.displayName} · ${toolsTarget.mode === 'auth' ? 'authentication' : 'tools'}`} onClose={() => setToolsTarget(null)} size="lg">
          <McpToolsView providerId={toolsTarget.requestProviderId ?? toolsTarget.providerId} serverName={toolsTarget.serverName}
            key={`${toolsTarget.providerId}:${toolsTarget.serverName}:${toolsTarget.mode}`}
            mode={toolsTarget.mode} initialServer={observations[`${toolsTarget.providerId}:${toolsTarget.server.name}:${JSON.stringify(toolsTarget.server.spec)}`] ?? toolsTarget.server}
            onRequestAuth={() => setToolsTarget({ ...toolsTarget, mode: 'auth' })}
            onObserved={(entry) => setObservations((current) => ({
              ...current, [`${toolsTarget.providerId}:${toolsTarget.server.name}:${JSON.stringify(toolsTarget.server.spec)}`]: entry,
            }))}
            onOpenAuth={openExternal}
            onBackgroundError={(text) => setError({ providerId: selectedProviderRef.current ?? toolsTarget.providerId, text })} />
        </Modal>
      )}
      {authenticationBatch && authenticationBatch.providerId === providerId && (
        <McpAuthenticationBatch
          providerId={authenticationBatch.providerId}
          servers={authenticationBatch.servers}
          onClose={() => setAuthenticationBatch(null)}
          onOpenAuth={openExternal}
          onBackgroundError={(text) => setError({ providerId: selectedProviderRef.current ?? authenticationBatch.providerId, text })}
        />
      )}
    </Card>
  );
}

type StatusTone = 'ok' | 'auth' | 'error' | 'checking' | 'muted';

function RemoveMcpServerDialog({ target, categoryLabel, onClose, onRemoved }: {
  target: EditDialogState;
  categoryLabel: string;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const remove = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.removeMcpServer(target.providerId, target.server.name);
      onRemoved();
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal title="Remove MCP configuration" onClose={() => { if (!locked.current) onClose(); }}>
      <p>Remove <strong>{target.server.displayName ?? target.server.name}</strong> from {categoryLabel}?</p>
      {target.server.source && <p className="field-hint">{target.server.source}</p>}
      <p>This removes this configuration entry, not the server software. Running sessions are unchanged.
        Stored authentication may need separate cleanup in the CLI.</p>
      <ModalErrorText error={error} />
      <div className="row modal-actions">
        <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={busy} onClick={() => void remove()}>Remove configuration</Button>
      </div>
    </Modal>
  );
}

interface StatusView {
  label: string;
  tone: StatusTone;
}

/** Maps a live status probe to a card badge label + color tone. */
function statusView(
  status: McpServerStatus | null,
  loading: boolean,
  failed: boolean,
  healing: boolean,
): StatusView {
  if (loading && healing) {
    return { label: 'Self-healing…', tone: 'checking' };
  }
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
        label: `Probe succeeded · ${status.toolCount} tool${
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
 * Listing a card never starts a process or authentication flow. Checks are
 * user-initiated and describe only this app's independent probe.
 */
function McpServerCard({
  providerId,
  providerLabel,
  server,
  capabilities,
  canMutateConfig,
  restartBusy,
  onRestart,
  onEdit,
  onOpenTools,
  onOpenAuth,
  observed,
  onToggle,
  onRemove,
  onConfigure,
  onNotice,
}: {
  providerId: string;
  providerLabel: string;
  server: McpServerEntry;
  capabilities?: McpCapabilities;
  canMutateConfig: boolean;
  restartBusy: boolean;
  onRestart: () => Promise<void>;
  onEdit: () => void;
  onOpenTools: () => void;
  onOpenAuth: () => void;
  observed?: McpServerEntry;
  onToggle: (enabled: boolean) => Promise<void>;
  onRemove: () => void;
  onConfigure: () => void;
  onNotice: (text: string) => void;
}) {
  const api = useApi();
  const [status, setStatus] = useState<McpServerStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const actionLock = useRef(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const epochRef = useRef(0);
  const appChecks = useRef(0);
  const displayName = server.displayName ?? server.name;
  const studioBridge = isStudioBridge(server);
  const enabled = server.enabled ?? server.spec.enabled !== false;

  const probe = useCallback(() => {
    const epoch = ++epochRef.current;
    setLoading(true);
    setFailed(false);
    setProbeError(null);
    api
      .getMcpServerStatus(studioBridge ? 'studio' : providerId, studioBridge ? 'ai-project-studio' : server.name)
      .then((result) => {
        if (epochRef.current === epoch) {
          setStatus(result);
        }
      })
      .catch((err) => {
        if (epochRef.current === epoch) {
          setFailed(true);
          setProbeError(normalizeError(err));
        }
      })
      .finally(() => {
        if (epochRef.current === epoch) {
          setLoading(false);
        }
      });
  }, [api, providerId, server.name, studioBridge]);

  useEffect(() => {
    epochRef.current += 1;
    setStatus(null);
    setFailed(false);
    setProbeError(null);
    setLoading(false);
    return () => {
      epochRef.current += 1;
    };
  }, [providerId, server.name, server.spec]);

  useEffect(() => {
    if (studioBridge) {
      appChecks.current = 1;
      probe();
    }
  }, [studioBridge, probe, server.spec]);

  useEffect(() => {
    if (!studioBridge || loading || appChecks.current >= 3 || (!failed && status?.status !== 'error')) return;
    const timer = setTimeout(() => {
      appChecks.current += 1;
      probe();
    }, 1500);
    return () => clearTimeout(timer);
  }, [studioBridge, loading, failed, status, probe]);

  async function handleRestart() {
    await onRestart();
  }

  async function toggleEnabled() {
    if (actionLock.current || !capability('toggle', capabilities).supported) return;
    actionLock.current = true;
    setUpdating(true);
    setProbeError(null);
    try {
      await onToggle(!enabled);
    } catch (err) {
      setProbeError(normalizeError(err));
    } finally {
      actionLock.current = false;
      setUpdating(false);
    }
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

  const healing = loading && (failed || status?.status === 'error');
  const view = statusView(status, loading, failed, healing);
  if (studioBridge && status?.status === 'connected' && !loading && !failed) {
    view.label = `Online · ${status.toolCount} tools`;
  }
  const needsAuth = status?.status === 'auth-required';
  const observedAuth = observed?.authState;
  const sourceAuth = server.authState;
  const auth = observedAuth && (!sourceAuth
    || Date.parse(observedAuth.checkedAt ?? '1970-01-01') >= Date.parse(sourceAuth.checkedAt ?? '1970-01-01'))
    ? observedAuth : sourceAuth;
  const discovery = observed?.toolDiscovery ?? server.toolDiscovery;
  const needsSignIn = auth ? auth.state === 'expired' || auth.state === 'required' : discovery?.authRequired === true;
  const ready = auth ? auth.state === 'ready' : discovery?.status === 'ok' && !discovery.authRequired;
  const reauth = auth?.state === 'expired';
  const authTitle = ready ? 'No sign-in needed at the last check. Refresh Tools to check again.'
    : needsSignIn ? auth?.message ?? 'Sign-in required.'
      : 'Sign-in requirement unknown. Use Tools to check.';
  const canRecheck = !server.catalog && !loading && enabled && (studioBridge || capability('tools', capabilities).supported);
  const healAttempts =
    status?.status === 'error' ? (status.healAttempts ?? []) : [];
  const hasHealDetails =
    status?.status === 'error' &&
    (healAttempts.length > 0 || Boolean(status.message));

  if (server.origin === 'agency-built-in' || server.builtinName || server.catalog) {
    return (
      <div className="skill-card mcp-server-card mcp-builtin-card">
        <strong className="skill-card-name">{displayName}</strong>
        <p className="skill-card-body">{server.description
          ?? (typeof server.spec.description === 'string' ? server.spec.description : 'Agency built-in MCP server.')}</p>
        <div className="row mcp-builtin-actions">
              <Button onClick={onOpenTools} ariaLabel={`Tools for ${displayName}`}
                disabled={!canMutateConfig || !capability('tools', capabilities).supported}
                title={capability('tools', capabilities).reason ?? 'List available tools'}>
                Tools
              </Button>
              <Button variant={needsSignIn ? 'danger' : 'ghost'} onClick={onOpenAuth}
                ariaLabel={`${reauth ? 'Reauth' : 'Auth'} ${displayName}`}
                title={authTitle}
                disabled={!canMutateConfig || !enabled || !needsSignIn || !capability('tools', capabilities).supported}>
                {reauth ? 'Reauth' : 'Auth'}
              </Button>
              <Button variant="ghost" onClick={server.catalog ? onConfigure : onEdit}
                ariaLabel={server.catalog ? `Configure ${displayName}` : `Edit ${displayName}`}
                title={capability(server.catalog ? 'add' : 'edit', capabilities).reason ?? undefined}
                disabled={!canMutateConfig || !capability(server.catalog ? 'add' : 'edit', capabilities).supported}>Configure</Button>
        </div>
        {!server.catalog && !capability('tools', capabilities).supported && (
          <p className="field-hint">{capability('tools', capabilities).reason}</p>
        )}
      </div>
    );
  }

  return (
    <div className="skill-card mcp-server-card">
      <div className="skill-card-head">
        <span className="skill-chip skill-chip-instruction">
          {server.catalog ? 'server' : specType(server.spec)}
        </span>
        <span className="mcp-provider-tag">{providerLabel}</span>
        {!server.catalog && <div className="skill-card-actions">
          <button
            type="button"
            className="tree-action"
            title={capability('restart', capabilities).reason ?? 'Reconnect live sessions'}
            aria-label={`Restart ${displayName}`}
            disabled={!canMutateConfig || restartBusy || !capability('restart', capabilities).supported}
            onClick={() => void handleRestart()}
          >
            <RestartIcon />
          </button>
          <button
            type="button"
            className="tree-action"
            title={capability('edit', capabilities).reason ?? 'Edit'}
            aria-label={`Edit ${displayName}`}
            disabled={!canMutateConfig || !capability('edit', capabilities).supported}
            onClick={onEdit}
          >
            <PencilIcon />
          </button>
          <button type="button" className="tree-action"
            title={capability('remove', capabilities).reason ?? 'Remove configuration'}
            aria-label={`Remove ${displayName}`}
            disabled={!canMutateConfig || updating || !capability('remove', capabilities).supported}
            onClick={onRemove}>
            <TrashIcon />
          </button>
        </div>}
      </div>
      <span className="skill-card-name" title={displayName}>
        {displayName}
      </span>
      {server.scope && <span className="mcp-source-scope">{server.scope}</span>}
      {server.source && <p className="mcp-entry-source" title={server.source}>{server.source}</p>}
      <div className="mcp-status-row">
        {hasHealDetails ? (
          <button
            type="button"
            className={`mcp-status mcp-status-${view.tone} mcp-status-clickable`}
            title="Show what self-healing tried"
            aria-label={`Show why ${server.name} failed`}
            onClick={() => setDetailsOpen(true)}
          >
            {loading ? <Spinner size={12} label="Checking connection" /> : <span className="mcp-status-dot" aria-hidden="true" />}
            {server.catalog ? 'Available · not configured' : enabled ? view.label : 'Disabled in configuration'}
            <InfoIcon size={12} />
          </button>
        ) : (
          <span
            className={`mcp-status mcp-status-${view.tone}`}
            role="status"
            title={status?.message ?? undefined}
          >
            {loading ? <Spinner size={12} label="Checking connection" /> : <span className="mcp-status-dot" aria-hidden="true" />}
            {server.catalog ? 'Available · not configured' : enabled ? view.label : 'Disabled in configuration'}
          </span>
        )}
        {canRecheck && (
          <button
            type="button"
            className="mcp-status-recheck"
            onClick={probe}
            aria-label={`Re-check ${displayName}`}
          >
            {status || failed ? 'Re-check' : 'Check connection'}
          </button>
        )}
      </div>
      <ModalErrorText error={probeError} />
      {status?.message && !hasHealDetails && <p className="field-hint">{status.message}</p>}
      <p className="skill-card-body">{server.catalog && typeof server.spec.description === 'string'
        ? server.spec.description : server.builtinName
          ? 'Native Agency built-in; launch details are managed by Agency.' : describeSpec(server.spec)}</p>
      {!server.catalog && <Button variant="ghost" loading={updating}
        disabled={!canMutateConfig || !capability('toggle', capabilities).supported}
        title={capability('toggle', capabilities).reason ?? 'Applies to future sessions'}
        ariaLabel={`${enabled ? 'Disable' : 'Enable'} ${displayName}`}
        onClick={() => void toggleEnabled()}>
        {enabled ? 'Disable' : 'Enable'}
      </Button>}
      {needsAuth && !studioBridge && (
        <Button
          variant="danger"
          onClick={authenticate}
          disabled={!canMutateConfig || !enabled || !capability('tools', capabilities).supported}
          title="Authenticate this MCP server"
        >
          <SignInIcon size={14} />
          <span>Authenticate</span>
        </Button>
      )}
      {(!needsAuth || studioBridge) && !server.catalog && <Button variant={needsSignIn && !studioBridge ? 'danger' : 'ghost'}
        onClick={onOpenAuth} ariaLabel={`${reauth ? 'Reauth' : 'Auth'} ${displayName}`}
        title={studioBridge ? 'Uses the IDE connection; no separate sign-in is needed.' : authTitle}
        disabled={studioBridge || !canMutateConfig || !enabled || !capability('tools', capabilities).supported
          || !needsSignIn}>
        {reauth ? 'Reauth' : 'Auth'}
      </Button>}
      {studioBridge && <p className="field-hint">Authentication is managed by the IDE.</p>}
      {!server.catalog && <button
        type="button"
        className="mcp-tools-btn"
        disabled={!canMutateConfig || (!studioBridge && !capability('tools', capabilities).supported)}
        onClick={onOpenTools}
        title={studioBridge ? 'View app tools' : capability('tools', capabilities).reason ?? 'Connect to inspect tools. Server startup may prompt for sign-in; existing CLI sessions are unchanged.'}
      >
        <ToolsIcon size={14} />
        <span>Tools</span>
      </button>}
      {server.catalog ? (
        <Button onClick={onConfigure} ariaLabel={`Configure ${displayName}`}
          disabled={!canMutateConfig || !capability('add', capabilities).supported}
          title={capability('add', capabilities).reason ?? undefined}>
          Configure
        </Button>
      ) : <CapabilityDetails capabilities={capabilities} />}
      {detailsOpen && status && (
        <Modal
          title={`Why ${server.name} couldn't connect`}
          onClose={() => setDetailsOpen(false)}
        >
          <McpHealDetails
            attempts={healAttempts}
            message={status.message}
            onClose={() => setDetailsOpen(false)}
          />
        </Modal>
      )}
    </div>
  );
}

/** Icon + tone for a single self-heal step outcome. */
function healOutcomeView(outcome: McpHealAttempt['outcome']): {
  icon: JSX.Element;
  tone: string;
} {
  switch (outcome) {
    case 'recovered':
      return { icon: <CheckIcon size={14} />, tone: 'ok' };
    case 'info':
      return { icon: <InfoIcon size={14} />, tone: 'info' };
    case 'failed':
    default:
      return { icon: <WarningIcon size={14} />, tone: 'error' };
  }
}

/**
 * Explains, on demand, exactly what self-healing tried before a server was
 * reported as failed: the ordered probe/retry/diagnosis steps and their
 * outcomes, plus the raw failure message the server produced.
 */
function McpHealDetails({
  attempts,
  message,
  onClose,
}: {
  attempts: McpHealAttempt[];
  message: string | null;
  onClose: () => void;
}) {
  const diagnosis = attempts.find(
    (attempt) => attempt.action.includes('diagnosis') && attempt.outcome === 'info',
  )?.detail;
  return (
    <div className="mcp-heal">
      <p className="mcp-heal-intro">
        Self-healing couldn't restore this connection. Here's what it tried:
      </p>
      {attempts.length > 0 ? (
        <ol className="mcp-heal-steps">
          {attempts.map((attempt, index) => {
            const outcome = healOutcomeView(attempt.outcome);
            return (
              <li
                key={index}
                className={`mcp-heal-step mcp-heal-step-${outcome.tone}`}
              >
                <span className="mcp-heal-step-icon" aria-hidden="true">
                  {outcome.icon}
                </span>
                <span className="mcp-heal-step-body">
                  <span className="mcp-heal-step-action">{attempt.action}</span>
                  {attempt.detail && (
                    <span className="mcp-heal-step-detail">{attempt.detail}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="mcp-heal-empty">
          No self-heal steps were recorded for this failure.
        </p>
      )}
      {diagnosis && (
        <div className="mcp-heal-diagnosis">
          <span className="mcp-heal-diagnosis-label">AI diagnosis</span>
          <p className="mcp-heal-diagnosis-text">{diagnosis}</p>
        </div>
      )}
      {message && (
        <details className="mcp-heal-raw">
          <summary>Raw server error</summary>
          <pre className="mcp-heal-raw-text">{message}</pre>
        </details>
      )}
      <div className="mcp-heal-actions">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

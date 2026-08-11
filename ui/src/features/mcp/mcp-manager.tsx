import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { McpServerEntry } from '../../lib/types.js';
import { Button, Card, EmptyState, ErrorText, Modal } from '../../components/ui.js';
import { Loader } from '../../components/loading.js';
import { PencilIcon, PlusIcon, RefreshIcon } from '../../components/icons.js';
import { McpServerForm } from './mcp-server-form.js';

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

  // Default to the first MCP-capable provider once the list resolves.
  useEffect(() => {
    if (!providerId && providers.data && providers.data.length > 0) {
      setProviderId(providers.data[0].id);
    }
  }, [providerId, providers.data]);

  const config = useAsync(
    () =>
      providerId
        ? api.getMcpServers(providerId)
        : Promise.resolve(null),
    [providerId],
  );

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<McpServerEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(input: { name: string; spec: Record<string, unknown> }) {
    if (!providerId) {
      return;
    }
    setError(null);
    try {
      await api.putMcpServer(providerId, input);
      setCreating(false);
      setEditing(null);
      config.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function restart(server: McpServerEntry) {
    if (!providerId) return;
    setBusyKey(`restart:${server.name}`);
    setError(null);
    setNotice(null);
    try {
      const result = await api.restartMcpServer(providerId, server.name);
      const suffix =
        result.liveReloadCommand && result.liveReloadedSessions > 0
          ? ` Sent ${result.liveReloadCommand} to ${result.liveReloadedSessions} open session(s).`
          : ' No open sessions needed a live reload.';
      setNotice(`Restarted ${server.name}.${suffix}`);
      config.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function toggleTool(
    server: McpServerEntry,
    toolName: string,
    enabled: boolean,
  ) {
    if (!providerId) return;
    setBusyKey(`tool:${server.name}:${toolName}`);
    setError(null);
    setNotice(null);
    try {
      const result = await api.setMcpToolEnabled(
        providerId,
        server.name,
        toolName,
        enabled,
      );
      const suffix =
        result.liveReloadCommand && result.liveReloadedSessions > 0
          ? ` Sent ${result.liveReloadCommand} to ${result.liveReloadedSessions} open session(s).`
          : ' It will apply to new sessions; no open sessions were reloaded.';
      setNotice(`${enabled ? 'Enabled' : 'Disabled'} ${toolName}.${suffix}`);
      config.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  const list = config.data?.servers ?? [];
  const providerList = providers.data ?? [];

  return (
    <Card>
      <div className="page-header">
        <div>
          <h2 className="page-title">MCP Servers</h2>
          <p className="page-subtitle">
            Model Context Protocol servers configured for the selected provider.
            The provider’s CLI reports where its config lives, so entries reflect
            the real file it uses.
          </p>
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
          <Button
            onClick={() => setCreating(true)}
            disabled={!providerId || Boolean(config.error)}
          >
            <span className="btn-icon">
              <PlusIcon size={15} />
            </span>
            Add server
          </Button>
        </div>
      </div>

      <ErrorText error={error ?? providers.error ?? config.error} />
      {notice && <p className="mcp-notice">{notice}</p>}

      {config.data?.configPath && (
        <p className="field-hint" title={config.data.configPath}>
          Config file: <code>{config.data.configPath}</code>
          {config.data.exists ? '' : ' (not created yet)'}
        </p>
      )}

      {(providers.loading || config.loading) && <Loader label="Loading MCP servers" />}

      {!providers.loading && providerList.length === 0 && (
        <EmptyState message="No providers expose MCP configuration." />
      )}

      {!config.loading && providerList.length > 0 && list.length === 0 && (
        <EmptyState message="No MCP servers configured yet. Add your first one." />
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
                  disabled={busyKey === `restart:${server.name}`}
                  onClick={() => void restart(server)}
                >
                  <RefreshIcon />
                </button>
                <button
                  type="button"
                  className="tree-action"
                  title="Edit"
                  aria-label={`Edit ${server.name}`}
                  onClick={() => setEditing(server)}
                >
                  <PencilIcon />
                </button>
              </div>
            </div>
            <span className="skill-card-name" title={server.name}>
              {server.name}
            </span>
            <p className="skill-card-body">{describeSpec(server.spec)}</p>
            <div className="mcp-tools-panel">
              <div className="mcp-tools-head">
                <span>Tools</span>
                <span className={`mcp-discovery mcp-discovery-${server.toolDiscovery?.status ?? 'skipped'}`}>
                  {server.tools?.length ?? 0}
                </span>
              </div>
              <p className="mcp-tools-status">{discoveryLabel(server)}</p>
              {server.toolDiscovery?.output && server.toolDiscovery.output.length > 0 && (
                <pre className="mcp-output">
                  {server.toolDiscovery.output.join('\n')}
                </pre>
              )}
              {server.tools && server.tools.length > 0 ? (
                <div className="mcp-tool-list">
                  {server.tools.map((tool) => (
                    <label key={tool.name} className="mcp-tool-row">
                      <input
                        type="checkbox"
                        checked={tool.enabled}
                        disabled={busyKey === `tool:${server.name}:${tool.name}`}
                        onChange={(event) =>
                          void toggleTool(server, tool.name, event.target.checked)
                        }
                      />
                      <span>
                        <strong>{tool.name}</strong>
                        {tool.description && <small>{tool.description}</small>}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="mcp-tools-empty">
                  No tools discovered. Restart to retry and surface any auth prompt.
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {creating && (
        <Modal title="Add MCP server" onClose={() => setCreating(false)}>
          <McpServerForm onSubmit={save} onCancel={() => setCreating(false)} />
        </Modal>
      )}
      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <McpServerForm
            initial={editing}
            onSubmit={save}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
    </Card>
  );
}

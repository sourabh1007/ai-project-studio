import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type {
  ConfigUpdateResult,
  ConfigValue,
  FieldMeta,
} from '../../lib/types.js';
import {
  buildConfigTabs,
  buildFields,
  matchesQuery,
  parseInput,
  sameValue,
  seedValue,
  type SettingField,
} from '../../lib/settings-model.js';
import { Button, Card, EmptyState, ErrorText, IconBadge } from '../../components/ui.js';
import {
  InfoIcon,
  WorkspaceContextIcon,
  LogsIcon,
  ConfigIcon,
  AdvancedIcon,
} from '../../components/icons.js';
import { ErrorState } from '../../components/error-state.js';
import { Loader, Spinner } from '../../components/loading.js';
import { SharedContextPanel } from '../shared-context/shared-context-panel.js';
import { SoftwareUpdateSection } from '../updates/software-update-section.js';
import { NetworkActivitySection } from './network-activity-section.js';
import { DiagnosticsSection } from './diagnostics-section.js';
import { WorktreesSection } from './worktrees-section.js';
import { MetasessionPoolsSection } from './metasession-pools-section.js';

/** The Electron preload bridge, present only in the desktop app. */
interface DesktopBridge {
  revealFile(path: string): void;
  relaunch(): void;
  getVersion?(): Promise<string>;
  openDocs?(): void;
}

function desktopBridge(): DesktopBridge | undefined {
  return (window as unknown as { desktop?: DesktopBridge }).desktop;
}

/** Renders the editor control for one setting inside a namespace. */
function FieldControl({
  field,
  draft,
  disabled,
  onChange,
}: {
  field: SettingField;
  draft: string | boolean;
  disabled: boolean;
  onChange: (next: string | boolean) => void;
}) {
  if (field.control === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={draft as boolean}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (field.control === 'enum') {
    const options = field.meta?.options ?? [];
    return (
      <select
        className="input"
        value={draft as string}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field.control === 'json' || field.control === 'multiline') {
    return (
      <textarea
        className={field.control === 'json' ? 'input config-json' : 'input'}
        rows={field.control === 'json' ? 5 : 4}
        value={draft as string}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      className="input"
      type={field.control === 'number' ? 'number' : 'text'}
      value={draft as string}
      min={field.meta?.min}
      max={field.meta?.max}
      step={field.control === 'number' && field.meta?.int ? 1 : undefined}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Editable form for one config namespace, persisting overrides on save. */
function NamespaceEditor({
  namespace,
  values,
  fieldsMeta,
  overrideKeys,
  overridden,
  query,
  onSaved,
}: {
  namespace: string;
  values: Record<string, ConfigValue>;
  fieldsMeta: Record<string, FieldMeta> | undefined;
  overrideKeys: Set<string>;
  overridden: boolean;
  query: string;
  onSaved: (result: ConfigUpdateResult) => void;
}) {
  const api = useApi();
  const fields = useMemo<SettingField[]>(
    () => buildFields(values, fieldsMeta),
    [values, fieldsMeta],
  );
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, seedValue(f.value, f.control)])),
  );
  const [busy, setBusy] = useState<null | 'save' | 'reset'>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(
      Object.fromEntries(
        fields.map((f) => [f.key, seedValue(f.value, f.control)]),
      ),
    );
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, fieldsMeta]);

  const changed = fields.filter(
    (f) => !sameValue(draft[f.key], f.value, f.control, f.meta),
  );
  const dirty = changed.length > 0;
  const visible = fields.filter((f) => matchesQuery(namespace, f.key, query));

  async function save() {
    setError(null);
    const patch: Record<string, unknown> = {};
    try {
      for (const f of changed) {
        patch[f.key] = parseInput(draft[f.key], f.control, f.meta);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy('save');
    try {
      onSaved(await api.updateConfig(namespace, patch));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy('reset');
    setError(null);
    try {
      onSaved(await api.resetConfig(namespace));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (visible.length === 0) {
    return null;
  }

  return (
    <div className="config-module-card">
      <div className="config-module-head">
        <div className="config-module-title">
          <span>{namespace}</span>
          {overridden && <span className="config-badge">overridden</span>}
        </div>
        <div className="config-editor-actions">
          <Button onClick={save} disabled={!dirty || busy !== null}>
            {busy === 'save' ? (
              <>
                <Spinner size={13} label="Saving" /> Saving…
              </>
            ) : (
              'Save'
            )}
          </Button>
          <Button
            variant="ghost"
            onClick={reset}
            disabled={!overridden || busy !== null}
          >
            {busy === 'reset' ? (
              <>
                <Spinner size={13} label="Resetting" /> Resetting…
              </>
            ) : (
              'Reset'
            )}
          </Button>
        </div>
      </div>
      <div className="config-fields">
        {visible.map((f) => (
          <div key={f.key} className="config-field-row">
            <div className="config-field-label">
              <span className="config-field-name">{f.key}</span>
              {f.meta?.description && (
                <span className="config-field-desc">{f.meta.description}</span>
              )}
              {overrideKeys.has(f.key) && (
                <span className="config-field-badge">overridden</span>
              )}
            </div>
            <div className="config-field-control">
              <FieldControl
                field={f}
                draft={draft[f.key]}
                disabled={busy !== null}
                onChange={(next) =>
                  setDraft((d) => ({ ...d, [f.key]: next }))
                }
              />
            </div>
          </div>
        ))}
      </div>
      <ErrorText error={error} />
      {dirty && <span className="config-dirty">Unsaved changes</span>}
    </div>
  );
}

type TabId =
  | 'general'
  | 'config'
  | 'metasession'
  | 'network'
  | 'context'
  | 'diagnostics';

interface TabDef {
  id: TabId;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'general', label: 'General' },
  { id: 'config', label: 'Configuration' },
  { id: 'metasession', label: 'Metasession' },
  { id: 'network', label: 'Network' },
  { id: 'context', label: 'Workspace context' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

export function SettingsView() {
  const api = useApi();
  const { data, loading, error, cause, reload } = useAsync(
    () => api.getConfig(),
    [],
  );
  const [tab, setTab] = useState<TabId>('general');
  const [query, setQuery] = useState('');
  const [subTab, setSubTab] = useState<string | null>(null);
  const [restartPending, setRestartPending] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const bridge = desktopBridge();

  useEffect(() => {
    let active = true;
    bridge?.getVersion?.().then(
      (v) => {
        if (active) {
          setVersion(v);
        }
      },
      () => {
        /* version is optional; ignore bridge errors */
      },
    );
    return () => {
      active = false;
    };
  }, [bridge]);

  const configTabs = useMemo(
    () => (data ? buildConfigTabs(data.namespaces) : []),
    [data],
  );
  const activeSubTab =
    subTab && configTabs.some((t) => t.id === subTab)
      ? subTab
      : configTabs[0]?.id ?? null;
  const activeNamespaces =
    configTabs.find((t) => t.id === activeSubTab)?.namespaces ?? [];

  const logDirectory =
    typeof data?.current.logging?.directory === 'string'
      ? (data.current.logging.directory as string)
      : null;
  const logLevel =
    typeof data?.current.logging?.level === 'string'
      ? (data.current.logging.level as string)
      : null;

  function onSaved(result: ConfigUpdateResult) {
    if (result.requiresRestart) {
      setRestartPending(true);
    }
    reload();
  }

  function restart() {
    setRestarting(true);
    bridge?.relaunch();
  }

  return (
    <>
      {restartPending && (
        <div className="settings-restart-banner" role="status">
          <div>
            <strong>Restart required</strong>
            <p className="page-subtitle">
              Configuration changes are saved and apply the next time the app
              starts.
            </p>
          </div>
          {bridge ? (
            <Button onClick={restart} disabled={restarting}>
              {restarting ? (
                <>
                  <Spinner size={13} label="Restarting" /> Restarting…
                </>
              ) : (
                'Restart now'
              )}
            </Button>
          ) : (
            <span className="muted">Restart the app to apply.</span>
          )}
        </div>
      )}

      <div className="settings-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`settings-tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'config' && data && (
              <span className="settings-tab-count">{data.namespaces.length}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <div className="settings-panel">
          <Card>
            <div className="page-header">
              <div className="page-header-main">
                <IconBadge icon={<InfoIcon size={22} />} tone="accent" />
                <div>
                  <h2 className="page-title">About</h2>
                  <p className="page-subtitle">
                    AI Project Studio — an IDE-style workspace for AI coding CLIs.
                  </p>
                </div>
              </div>
              {bridge?.openDocs && (
                <Button variant="ghost" onClick={() => bridge.openDocs?.()}>
                  Open documentation
                </Button>
              )}
            </div>
            <dl className="kv">
              <div style={{ display: 'contents' }}>
                <dt>Version</dt>
                <dd>{version ?? '—'}</dd>
              </div>
            </dl>
          </Card>
          <SoftwareUpdateSection />
        </div>
      )}

      {tab === 'config' && (
        <div className="settings-panel">
          <Card>
            <div className="page-header">
              <div className="page-header-main">
                <IconBadge icon={<ConfigIcon size={22} />} tone="accent" />
                <div>
                  <h2 className="page-title">Configuration</h2>
                  <p className="page-subtitle">
                    Every module setting, grouped and editable. Values are typed
                    from each module's schema; saved changes apply after a
                    restart. Environment variables still take precedence.
                  </p>
                </div>
              </div>
              <input
                className="input"
                style={{ maxWidth: 260 }}
                placeholder="Filter settings…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {loading && <Loader label="Loading configuration" />}
            {error && <ErrorState error={cause ?? error} onRetry={reload} />}
            {data && (
              <>
                <div className="config-subtabs" role="tablist">
                  {configTabs.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={activeSubTab === t.id}
                      className={`config-subtab${
                        activeSubTab === t.id ? ' is-active' : ''
                      }`}
                      onClick={() => setSubTab(t.id)}
                    >
                      {t.label}
                      <span className="settings-tab-count">
                        {t.namespaces.length}
                      </span>
                    </button>
                  ))}
                </div>
                {activeNamespaces.length === 0 && (
                  <EmptyState message="No settings to show." />
                )}
                {activeNamespaces.map((namespace) => {
                  const overrideKeys = new Set(
                    Object.keys(data.overrides[namespace] ?? {}),
                  );
                  return (
                    <NamespaceEditor
                      key={namespace}
                      namespace={namespace}
                      values={data.current[namespace] ?? {}}
                      fieldsMeta={data.schema?.[namespace]?.fields}
                      overrideKeys={overrideKeys}
                      overridden={overrideKeys.size > 0}
                      query={query.trim().toLowerCase()}
                      onSaved={onSaved}
                    />
                  );
                })}
              </>
            )}
          </Card>
        </div>
      )}

      {tab === 'metasession' && (
        <div className="settings-panel">
          <MetasessionPoolsSection />
        </div>
      )}

      {tab === 'network' && (
        <div className="settings-panel">
          <NetworkActivitySection />
        </div>
      )}

      {tab === 'context' && (
        <div className="settings-panel">
          <Card>
            <div className="shared-context-card-head">
              <div className="page-header-main">
                <IconBadge
                  icon={<WorkspaceContextIcon size={22} />}
                  tone="accent"
                />
                <div>
                  <h2 className="page-title">Workspace context</h2>
                  <p className="page-subtitle">
                    Global knowledge shared with every repository, feature, and
                    session. Promote durable, workspace-wide conventions here — it
                    is manual-only and never auto-written.
                  </p>
                </div>
              </div>
            </div>
            <SharedContextPanel
              scope="workspace"
              scopeId=""
              title="Workspace shared context"
            />
          </Card>
        </div>
      )}

      {tab === 'diagnostics' && (
        <div className="settings-panel">
          <Card>
            <div className="page-header">
              <div className="page-header-main">
                <IconBadge icon={<LogsIcon size={22} />} tone="neutral" />
                <div>
                  <h2 className="page-title">Logs &amp; diagnostics</h2>
                  <p className="page-subtitle">
                    The app writes structured logs to a daily file. Open the
                    folder to inspect or share them when reporting an issue.
                  </p>
                </div>
              </div>
              {logDirectory && bridge && (
                <Button
                  variant="ghost"
                  onClick={() => bridge.revealFile(logDirectory)}
                >
                  Open logs folder
                </Button>
              )}
            </div>
            <dl className="kv">
              <div style={{ display: 'contents' }}>
                <dt>Log level</dt>
                <dd>{logLevel ?? '—'}</dd>
              </div>
              <div style={{ display: 'contents' }}>
                <dt>Log directory</dt>
                <dd className="config-path">{logDirectory ?? '—'}</dd>
              </div>
            </dl>
          </Card>
          <DiagnosticsSection
            version={version}
            logDirectory={logDirectory ?? null}
            bridge={bridge}
          />
          <WorktreesSection />
          <Card>
            <div className="page-header">
              <div className="page-header-main">
                <IconBadge icon={<AdvancedIcon size={22} />} tone="neutral" />
                <div>
                  <h2 className="page-title">Advanced</h2>
                  <p className="page-subtitle">
                    Looking for a specific setting? Every module is editable under
                    the Configuration tab.
                  </p>
                </div>
              </div>
              <Button variant="ghost" onClick={() => setTab('config')}>
                Open Configuration
              </Button>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

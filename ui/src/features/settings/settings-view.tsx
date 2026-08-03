import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { ConfigUpdateResult, ConfigValue } from '../../lib/types.js';
import { Button, Card, EmptyState, ErrorText } from '../../components/ui.js';
import { Loader, Spinner } from '../../components/loading.js';
import { SharedContextPanel } from '../shared-context/shared-context-panel.js';

/** The Electron preload bridge, present only in the desktop app. */
interface DesktopBridge {
  revealFile(path: string): void;
  relaunch(): void;
}

function desktopBridge(): DesktopBridge | undefined {
  return (window as unknown as { desktop?: DesktopBridge }).desktop;
}

type FieldKind = 'boolean' | 'number' | 'string' | 'json';

function kindOf(value: ConfigValue): FieldKind {
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  return 'json';
}

function seedValue(value: ConfigValue, kind: FieldKind): string | boolean {
  if (kind === 'boolean') {
    return value as boolean;
  }
  if (kind === 'json') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

/** Converts an editor input back to its typed value; throws on malformed input. */
function fromInput(raw: string | boolean, kind: FieldKind): unknown {
  if (kind === 'boolean') {
    return raw as boolean;
  }
  if (kind === 'number') {
    const n = Number(raw);
    if (raw === '' || Number.isNaN(n)) {
      throw new Error('Enter a valid number.');
    }
    return n;
  }
  if (kind === 'json') {
    return JSON.parse(raw as string);
  }
  return raw as string;
}

function sameValue(
  raw: string | boolean,
  original: ConfigValue,
  kind: FieldKind,
): boolean {
  try {
    return JSON.stringify(fromInput(raw, kind)) === JSON.stringify(original);
  } catch {
    return false;
  }
}

function renderValue(value: ConfigValue): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

interface Field {
  key: string;
  kind: FieldKind;
}

/** Editable form for one config namespace, persisting overrides on save. */
function NamespaceEditor({
  namespace,
  values,
  overridden,
  onSaved,
}: {
  namespace: string;
  values: Record<string, ConfigValue>;
  overridden: boolean;
  onSaved: (result: ConfigUpdateResult) => void;
}) {
  const api = useApi();
  const fields = useMemo<Field[]>(
    () =>
      Object.entries(values).map(([key, value]) => ({
        key,
        kind: kindOf(value),
      })),
    [values],
  );
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      fields.map((f) => [f.key, seedValue(values[f.key], f.kind)]),
    ),
  );
  const [busy, setBusy] = useState<null | 'save' | 'reset'>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(
      Object.fromEntries(
        fields.map((f) => [f.key, seedValue(values[f.key], f.kind)]),
      ),
    );
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  const changed = fields.filter(
    (f) => !sameValue(draft[f.key], values[f.key], f.kind),
  );
  const dirty = changed.length > 0;

  async function save() {
    setError(null);
    const patch: Record<string, unknown> = {};
    try {
      for (const f of changed) {
        patch[f.key] = fromInput(draft[f.key], f.kind);
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

  return (
    <div className="config-editor">
      <div className="config-fields">
        {fields.map((f) => (
          <label key={f.key} className="config-field">
            <span className="config-field-key">{f.key}</span>
            {f.kind === 'boolean' ? (
              <input
                type="checkbox"
                checked={draft[f.key] as boolean}
                disabled={busy !== null}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [f.key]: e.target.checked }))
                }
              />
            ) : f.kind === 'json' ? (
              <textarea
                className="input config-json"
                rows={4}
                value={draft[f.key] as string}
                disabled={busy !== null}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [f.key]: e.target.value }))
                }
              />
            ) : (
              <input
                className="input"
                type={f.kind === 'number' ? 'number' : 'text'}
                value={draft[f.key] as string}
                disabled={busy !== null}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [f.key]: e.target.value }))
                }
              />
            )}
          </label>
        ))}
      </div>
      <ErrorText error={error} />
      <div className="config-editor-actions">
        <Button onClick={save} disabled={!dirty || busy !== null}>
          {busy === 'save' ? (
            <>
              <Spinner size={13} label="Saving" /> Saving…
            </>
          ) : (
            'Save changes'
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
            'Reset to default'
          )}
        </Button>
        {dirty && <span className="config-dirty">Unsaved changes</span>}
      </div>
    </div>
  );
}

export function SettingsView() {
  const api = useApi();
  const { data, loading, error, reload } = useAsync(() => api.getConfig(), []);
  const [query, setQuery] = useState('');
  const [restartPending, setRestartPending] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const bridge = desktopBridge();

  const namespaces = useMemo(() => {
    if (!data) {
      return [];
    }
    const term = query.trim().toLowerCase();
    return data.namespaces
      .map((namespace) => {
        const settings = data.current[namespace] ?? {};
        const entries = Object.entries(settings).filter(
          ([key]) => !term || `${namespace}.${key}`.toLowerCase().includes(term),
        );
        return { namespace, entries };
      })
      .filter((group) => group.entries.length > 0);
  }, [data, query]);

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

      <Card>
        <div className="shared-context-card-head">
          <h2 className="page-title">Workspace context</h2>
          <p className="page-subtitle">
            Global knowledge shared with every repository, feature, and session.
            Promote durable, workspace-wide conventions here — it is manual-only
            and never auto-written.
          </p>
        </div>
        <SharedContextPanel
          scope="workspace"
          scopeId=""
          title="Workspace shared context"
        />
      </Card>

      <Card>
        <div className="page-header">
          <div>
            <h2 className="page-title">Logs &amp; diagnostics</h2>
            <p className="page-subtitle">
              The app writes structured logs to a daily file. Open the folder to
              inspect or share them when reporting an issue.
            </p>
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

      <Card>
        <div className="page-header">
          <div>
            <h2 className="page-title">Settings</h2>
            <p className="page-subtitle">
              Effective configuration, grouped by module. Every value is
              config-driven — nothing is hardcoded.
            </p>
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
        <ErrorText error={error} />
        {data && namespaces.length === 0 && (
          <EmptyState message="No matching settings." />
        )}
        <div style={{ marginTop: 'var(--space-4)' }}>
          {namespaces.map((group) => (
            <div key={group.namespace} className="config-namespace">
              <h3>{group.namespace}</h3>
              <dl className="kv">
                {group.entries.map(([key, value]) => (
                  <div key={key} style={{ display: 'contents' }}>
                    <dt>{key}</dt>
                    <dd>{renderValue(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="page-header">
          <div>
            <h2 className="page-title">Advanced</h2>
            <p className="page-subtitle">
              Reconfigure any module. Saved values persist and take effect after
              a restart. Environment variables, when set, still take precedence.
            </p>
          </div>
        </div>
        {loading && <Loader label="Loading configuration" />}
        {data && (
          <div className="config-advanced">
            {data.namespaces.map((namespace) => {
              const values = data.current[namespace] ?? {};
              const overridden =
                Object.keys(data.overrides[namespace] ?? {}).length > 0;
              return (
                <details key={namespace} className="config-module">
                  <summary>
                    <span className="config-module-name">{namespace}</span>
                    {overridden && (
                      <span className="config-badge">overridden</span>
                    )}
                  </summary>
                  <NamespaceEditor
                    namespace={namespace}
                    values={values}
                    overridden={overridden}
                    onSaved={onSaved}
                  />
                </details>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}

import { useEffect, useId, useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { usePersistentState } from '../../hooks/use-persistent-state.js';
import type {
  ConfigUpdateResult,
  ConfigValue,
  FieldMeta,
} from '../../lib/types.js';
import {
  buildConfigTabs,
  buildFields,
  fieldHelp,
  fieldLabel,
  matchesQuery,
  parseInput,
  sameValue,
  seedValue,
  type SettingField,
} from '../../lib/settings-model.js';
import { Button, Card, EmptyState, ErrorText, IconBadge } from '../../components/ui.js';
import { SettingsPage, CollapsibleCard } from './settings-page.js';
import {
  InfoIcon,
  WorkspaceContextIcon,
  LogsIcon,
  ConfigIcon,
  AdvancedIcon,
  ChevronIcon,
} from '../../components/icons.js';
import { ErrorState } from '../../components/error-state.js';
import { Loader, Spinner } from '../../components/loading.js';
import { SelfHealButton } from '../../components/self-heal-button.js';
import { SharedContextPanel } from '../shared-context/shared-context-panel.js';
import { SoftwareUpdateSection } from '../updates/software-update-section.js';
import { AgencyCliSection } from './agency-cli-section.js';
import { AppearanceSection } from './appearance-section.js';
import { NetworkActivitySection } from './network-activity-section.js';
import { DiagnosticsSection } from './diagnostics-section.js';
import { RetainedImagesSection } from './retained-images-section.js';
import { WorktreesSection } from './worktrees-section.js';
import { MetasessionPoolsSection } from './metasession-pools-section.js';
import { MetaOperationsSection } from '../meta-operations/meta-operations-section.js';
import { PromptsCommandsSection } from './prompts-commands-section.js';
import {
  OPEN_PROMPT_SETTINGS_EVENT,
  takePromptSettingsAnchor,
  type OpenPromptSettingsDetail,
} from './prompts-nav.js';
import {
  applyConfigUpdateToDraftStore,
  createNamespaceDraftState,
  discardNamespaceDraftConflicts,
  isSettingsDraftStore,
  reconcileSettingsDraftStore,
  updateNamespaceDraftValue,
  type NamespaceDraftState,
} from './settings-drafts.js';
import { desktopBridge } from '../../lib/desktop-bridge.js';

function fallbackDraftState(
  values: Record<string, ConfigValue>,
  fieldsMeta: Record<string, FieldMeta> | undefined,
): NamespaceDraftState {
  return createNamespaceDraftState(buildFields(values, fieldsMeta));
}

function fieldPathLabel(path: string): string {
  return path
    .split('.')
    .filter(Boolean)
    .map((segment) => fieldLabel(segment))
    .join(' ');
}

function sanitizeIdPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'field';
}

function describeByIds(
  ...ids: Array<string | null | undefined>
): string | undefined {
  const value = ids.filter(Boolean).join(' ');
  return value || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Renders the editor control for one setting inside a namespace. */
function FieldControl({
  field,
  draft,
  disabled,
  id,
  labelledBy,
  describedBy,
  invalid,
  onChange,
}: {
  field: SettingField;
  draft: string | boolean;
  disabled: boolean;
  id: string;
  labelledBy: string;
  describedBy?: string;
  invalid?: boolean;
  onChange: (next: string | boolean) => void;
}) {
  if (field.control === 'boolean') {
    return (
      <input
        id={id}
        type="checkbox"
        checked={draft as boolean}
        disabled={disabled}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (field.control === 'enum') {
    const options = field.meta?.options ?? [];
    return (
      <select
        id={id}
        className="input"
        value={draft as string}
        disabled={disabled}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
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
        id={id}
        className={field.control === 'json' ? 'input config-json' : 'input'}
        rows={field.control === 'json' ? 5 : 4}
        value={draft as string}
        disabled={disabled}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      id={id}
      className="input"
      type={field.control === 'number' ? 'number' : 'text'}
      value={draft as string}
      min={field.meta?.min}
      max={field.meta?.max}
      step={field.control === 'number' && field.meta?.int ? 1 : undefined}
      disabled={disabled}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ConfigFieldRow({
  namespace,
  field,
  draft,
  disabled,
  asking,
  overridden,
  validationError,
  onChange,
  onExplain,
}: {
  namespace: string;
  field: SettingField;
  draft: string | boolean;
  disabled: boolean;
  asking: boolean;
  overridden: boolean;
  validationError: string | null;
  onChange: (next: string | boolean) => void;
  onExplain: () => void;
}) {
  const instanceId = useId().replace(/:/g, '');
  const fieldBaseId = `${instanceId}-${sanitizeIdPart(namespace)}-${sanitizeIdPart(field.key)}`;
  const labelId = `${fieldBaseId}-label`;
  const descriptionId = `${fieldBaseId}-description`;
  const errorId = `${fieldBaseId}-error`;
  const controlId = `${fieldBaseId}-control`;
  const label = fieldPathLabel(field.key);

  return (
    <div className="config-field-row">
      <div className="config-field-label">
        <label className="config-field-name" htmlFor={controlId} id={labelId}>
          {label}
        </label>
        <code className="config-field-key">{field.key}</code>
        <span className="config-field-desc" id={descriptionId}>
          {fieldHelp(field)}
        </span>
        <button
          type="button"
          className="config-field-explain"
          disabled={asking}
          onClick={onExplain}
        >
          Explain
        </button>
        {overridden && (
          <span className="config-field-badge">overridden</span>
        )}
      </div>
      <div className="config-field-control">
        <FieldControl
          id={controlId}
          labelledBy={labelId}
          describedBy={describeByIds(
            descriptionId,
            validationError ? errorId : null,
          )}
          invalid={!!validationError}
          field={field}
          draft={draft}
          disabled={disabled}
          onChange={onChange}
        />
        {validationError && (
          <p className="error-text" id={errorId}>
            {validationError}
          </p>
        )}
      </div>
    </div>
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
  draftState,
  onDraftChange,
  onDiscardConflicts,
  onSaved,
}: {
  namespace: string;
  values: Record<string, ConfigValue>;
  fieldsMeta: Record<string, FieldMeta> | undefined;
  overrideKeys: Set<string>;
  overridden: boolean;
  query: string;
  draftState: NamespaceDraftState;
  onDraftChange: (key: string, next: string | boolean) => void;
  onDiscardConflicts: (keys?: readonly string[]) => void;
  onSaved: (result: ConfigUpdateResult) => void;
}) {
  const api = useApi();
  const fields = useMemo<SettingField[]>(
    () => buildFields(values, fieldsMeta),
    [values, fieldsMeta],
  );
  const [busy, setBusy] = useState<null | 'save' | 'reset'>(null);
  const [error, setError] = useState<string | null>(null);
  const [assistOpen, setAssistOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [assistError, setAssistError] = useState<string | null>(null);
  const [open, setOpen] = usePersistentState<boolean>(
    `cw-settings-open:config:${namespace}`,
    false,
  );
  const draftValue = (field: SettingField) =>
    draftState.values[field.key] ?? seedValue(field.value, field.control);
  const validationErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    for (const field of fields) {
      const draft = draftValue(field);
      if (sameValue(draft, field.value, field.control, field.meta)) {
        continue;
      }
      try {
        parseInput(draft, field.control, field.meta);
      } catch (err) {
        errors[field.key] = errorMessage(err);
      }
    }
    return errors;
  }, [fields, draftState.values]);

  async function askAssistant(q: string, key?: string) {
    const trimmed = q.trim();
    if (trimmed.length === 0 || asking) {
      return;
    }
    setAssistOpen(true);
    setQuestion(q);
    setAsking(true);
    setAnswer(null);
    setAssistError(null);
    try {
      const res = await api.askSettingsAssistant({ namespace, key, question: trimmed });
      setAnswer(res.answer);
    } catch {
      setAssistError(
        'The assistant is unavailable right now. Make sure a model is configured and try again.',
      );
    } finally {
      setAsking(false);
    }
  }

  const changed = fields.filter(
    (f) => !sameValue(draftValue(f), f.value, f.control, f.meta),
  );
  const dirty = changed.length > 0;
  const visible = fields.filter((f) => matchesQuery(namespace, f.key, query));
  const firstValidationError = changed
    .map((field) => validationErrors[field.key])
    .find(Boolean);

  function handleDraftChange(key: string, next: string | boolean) {
    setError(null);
    onDraftChange(key, next);
  }

  async function save() {
    setError(null);
    if (firstValidationError) {
      setError('Fix the highlighted setting values before saving.');
      return;
    }
    const patch: Record<string, unknown> = {};
    try {
      for (const f of changed) {
        patch[f.key] = parseInput(draftValue(f), f.control, f.meta);
      }
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    setBusy('save');
    try {
      onSaved(await api.updateConfig(namespace, patch));
    } catch (err) {
      setError(errorMessage(err));
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
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (visible.length === 0) {
    return null;
  }

  const expanded = query !== '' || open;

  return (
    <div className="config-module-card">
      <div className="config-module-head">
        <button
          type="button"
          className="config-module-toggle"
          aria-expanded={expanded}
          onClick={() => setOpen(!open)}
        >
          <ChevronIcon size={13} open={expanded} />
          <span className="config-module-title">
            <span>{fieldLabel(namespace)}</span>
            {overridden && <span className="config-badge">overridden</span>}
          </span>
        </button>
        <div className="config-editor-actions">
          <Button
            variant="ghost"
            onClick={() => setAssistOpen((open) => !open)}
            aria-expanded={assistOpen}
          >
            ✨ Ask AI
          </Button>
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
      {expanded && (
        <>
          {assistOpen && (
        <div className="config-assistant">
          <form
            className="config-assistant-ask"
            onSubmit={(e) => {
              e.preventDefault();
              void askAssistant(question);
            }}
          >
            <input
              className="config-assistant-input"
              value={question}
              placeholder={`Ask about the ${fieldLabel(namespace)} settings…`}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={asking}
            />
            <Button type="submit" disabled={asking || question.trim().length === 0}>
              {asking ? (
                <>
                  <Spinner size={13} label="Thinking" /> Thinking…
                </>
              ) : (
                'Ask'
              )}
            </Button>
          </form>
          {asking && !answer && (
            <div className="config-assistant-answer config-assistant-pending">
              <Spinner size={13} label="Thinking" /> Consulting the model…
            </div>
          )}
          {answer && <div className="config-assistant-answer">{answer}</div>}
          <ErrorText error={assistError} />
          {assistError && (
            <SelfHealButton
              target="assistant-model"
              label="Configure a model"
              onHealed={() => {
                setAssistError(null);
                if (question) {
                  void askAssistant(question);
                }
              }}
            />
          )}
        </div>
      )}
      <div className="config-fields">
        {visible.map((f) => (
          <ConfigFieldRow
            key={f.key}
            namespace={namespace}
            field={f}
            draft={draftValue(f)}
            disabled={busy !== null}
            asking={asking}
            overridden={overrideKeys.has(f.key)}
            validationError={validationErrors[f.key] ?? null}
            onExplain={() =>
              void askAssistant(
                `Explain the "${fieldPathLabel(f.key)}" setting and recommend a good value.`,
                f.key,
              )
            }
            onChange={(next) => handleDraftChange(f.key, next)}
          />
        ))}
      </div>
        </>
      )}
      {draftState.conflicts.length > 0 && (
        <div className="config-dirty" role="alert">
          <span>
            Server updates conflict with your unsaved{' '}
            {draftState.conflicts.length === 1 ? 'change' : 'changes'} in{' '}
            {draftState.conflicts.map((key) => fieldPathLabel(key)).join(', ')}.
          </span>{' '}
          <Button
            variant="ghost"
            onClick={() => onDiscardConflicts()}
            disabled={busy !== null}
          >
            Discard conflicting changes
          </Button>
        </div>
      )}
      <ErrorText error={error} />
      {dirty && <span className="config-dirty">Unsaved changes</span>}
    </div>
  );
}

type TabId =
  | 'general'
  | 'appearance'
  | 'config'
  | 'prompts'
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
  { id: 'appearance', label: 'Appearance' },
  { id: 'prompts', label: 'Prompts & Commands' },
  { id: 'metasession', label: 'Metasession' },
  { id: 'network', label: 'Network' },
  { id: 'context', label: 'Workspace context' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'config', label: 'Configuration' },
];

export function SettingsView() {
  const api = useApi();
  const { data, loading, error, cause, reload } = useAsync(
    () => api.getConfig(),
    [],
  );
  const [drafts, setDrafts] = usePersistentState('cw-settings-drafts', {}, {
    validate: isSettingsDraftStore,
  });
  const [tab, setTab] = useState<TabId>('general');
  const [promptAnchor, setPromptAnchor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [subTab, setSubTab] = useState<string | null>(null);
  const [restartPending, setRestartPending] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const bridge = desktopBridge();

  // Deep-link into a specific prompt entry: either from a fresh mount (another
  // view stashed the anchor) or from a live event while Settings is open.
  useEffect(() => {
    const initial = takePromptSettingsAnchor();
    if (initial) {
      setTab('prompts');
      setPromptAnchor(initial);
    }
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenPromptSettingsDetail>).detail;
      setTab('prompts');
      // Force the effect to re-run even if the same anchor is requested twice.
      setPromptAnchor(null);
      requestAnimationFrame(() => setPromptAnchor(detail?.anchorId ?? null));
    };
    window.addEventListener(OPEN_PROMPT_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PROMPT_SETTINGS_EVENT, onOpen);
  }, []);
  useEffect(() => {
    if (!data) {
      return;
    }
    setDrafts((prev) =>
      reconcileSettingsDraftStore(prev, data.current, data.schema),
    );
  }, [data, setDrafts]);

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
    setDrafts((prev) => applyConfigUpdateToDraftStore(prev, result, data?.schema));
    reload();
  }

  async function restart() {
    setRestarting(true);
    setRestartError(null);
    try {
      if (await bridge?.relaunch?.() !== true) {
        throw new Error('Restart was not confirmed');
      }
    } catch {
      setRestarting(false);
      setRestartError('Restart not confirmed. Wait for active work to finish, then try again. Your saved settings will apply after a successful restart.');
    }
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
            {restartError && <p role="alert">{restartError}</p>}
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
        <SettingsPage searchLabel="Search General settings…">
          <CollapsibleCard
            id="general-about"
            title="About"
            subtitle="AI Project Studio — an IDE-style workspace for AI coding CLIs."
            icon={<InfoIcon size={22} />}
            tone="accent"
            keywords={['version', 'documentation']}
            actions={
              bridge?.openDocs && (
                <Button variant="ghost" onClick={() => bridge.openDocs?.()}>
                  Open documentation
                </Button>
              )
            }
          >
            <dl className="kv">
              <div style={{ display: 'contents' }}>
                <dt>Version</dt>
                <dd>{version ?? '—'}</dd>
              </div>
            </dl>
          </CollapsibleCard>
          <CollapsibleCard
            id="general-updates"
            title="Software updates"
            subtitle="Check for and install new versions of the app."
            keywords={['update', 'version', 'release']}
          >
            <SoftwareUpdateSection embedded />
          </CollapsibleCard>
          <CollapsibleCard
            id="general-agency"
            title="Agency CLI"
            subtitle="The bundled Microsoft Agency CLI is kept current automatically."
            keywords={['agency', 'cli', 'upgrade']}
          >
            <AgencyCliSection embedded />
          </CollapsibleCard>
        </SettingsPage>
      )}

      {tab === 'appearance' && (
        <SettingsPage searchLabel="Search Appearance settings…">
          <CollapsibleCard
            id="appearance-main"
            title="Appearance"
            subtitle="Theme, density, and other visual preferences."
            keywords={['theme', 'dark', 'light', 'density', 'font', 'color']}
          >
            <AppearanceSection embedded />
          </CollapsibleCard>
        </SettingsPage>
      )}

      {tab === 'prompts' && (
        <SettingsPage searchLabel="Search Prompts & Commands…">
          <CollapsibleCard
            id="prompts-main"
            title="Prompts & Commands"
            subtitle="Customize the prompts and slash commands used by AI features."
            defaultOpen
            keywords={['prompt', 'command', 'slash', 'template']}
          >
            <PromptsCommandsSection focusAnchor={promptAnchor} embedded />
          </CollapsibleCard>
        </SettingsPage>
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
                      draftState={
                        drafts[namespace] ??
                        fallbackDraftState(
                          data.current[namespace] ?? {},
                          data.schema?.[namespace]?.fields,
                        )
                      }
                      onDraftChange={(key, next) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [namespace]: updateNamespaceDraftValue(
                            prev[namespace] ??
                              fallbackDraftState(
                                data.current[namespace] ?? {},
                                data.schema?.[namespace]?.fields,
                              ),
                            key,
                            next,
                          ),
                        }))
                      }
                      onDiscardConflicts={(keys) =>
                        setDrafts((prev) => {
                          const fields = buildFields(
                            data.current[namespace] ?? {},
                            data.schema?.[namespace]?.fields,
                          );
                          const current =
                            prev[namespace] ??
                            fallbackDraftState(
                              data.current[namespace] ?? {},
                              data.schema?.[namespace]?.fields,
                            );
                          return {
                            ...prev,
                            [namespace]: discardNamespaceDraftConflicts(
                              current,
                              fields,
                              keys,
                            ),
                          };
                        })
                      }
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
        <SettingsPage searchLabel="Search Metasession settings…">
          <CollapsibleCard
            id="metasession-pools"
            title="Metasession pools"
            subtitle="Warm pool size and live per-instance status."
            keywords={['pool', 'warm', 'metasession', 'instance', 'concurrency']}
          >
            <MetasessionPoolsSection embedded />
          </CollapsibleCard>
          <CollapsibleCard
            id="metasession-operations"
            title="Saved AI operations"
            subtitle="Durable results and interrupted work."
            keywords={['operation', 'credits', 'usage', 'result', 'history']}
          >
            <MetaOperationsSection embedded />
          </CollapsibleCard>
        </SettingsPage>
      )}

      {tab === 'network' && (
        <SettingsPage searchLabel="Search Network settings…">
          <CollapsibleCard
            id="network-activity"
            title="Network activity"
            subtitle="Outbound integrations and their authentication state."
            keywords={['network', 'integration', 'github', 'azure', 'http', 'auth']}
          >
            <NetworkActivitySection embedded />
          </CollapsibleCard>
        </SettingsPage>
      )}

      {tab === 'context' && (
        <SettingsPage searchLabel="Search Workspace context…">
          <CollapsibleCard
            id="workspace-context"
            title="Workspace context"
            subtitle="Global knowledge shared with every repository, feature, and session. Promote durable, workspace-wide conventions here — it is manual-only and never auto-written."
            icon={<WorkspaceContextIcon size={22} />}
            tone="accent"
            keywords={['context', 'shared', 'knowledge', 'convention']}
          >
            <SharedContextPanel
              scope="workspace"
              scopeId=""
              title="Workspace shared context"
            />
          </CollapsibleCard>
        </SettingsPage>
      )}

      {tab === 'diagnostics' && (
        <SettingsPage searchLabel="Search Diagnostics…">
          <CollapsibleCard
            id="diagnostics-logs"
            title="Logs & diagnostics"
            subtitle="The app writes structured logs to a daily file. Open the folder to inspect or share them when reporting an issue."
            icon={<LogsIcon size={22} />}
            tone="neutral"
            keywords={['logs', 'log level', 'directory', 'diagnostics']}
            actions={
              logDirectory && bridge?.revealFile && (
                <Button
                  variant="ghost"
                  onClick={() => bridge.revealFile?.(logDirectory)}
                >
                  Open logs folder
                </Button>
              )
            }
          >
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
          </CollapsibleCard>
          <CollapsibleCard
            id="diagnostics-failures"
            title="Backend & renderer diagnostics"
            subtitle="Recent supervisor, API, and renderer failures with a restart action."
            keywords={['failure', 'crash', 'restart', 'backend', 'renderer']}
          >
            <DiagnosticsSection
              version={version}
              logDirectory={logDirectory ?? null}
              bridge={bridge}
              embedded
            />
          </CollapsibleCard>
          <CollapsibleCard
            id="diagnostics-images"
            title="Retained clipboard images"
            subtitle="Manually manage images retained for AI history."
            keywords={['image', 'clipboard', 'retained', 'attachment', 'cleanup']}
          >
            <RetainedImagesSection bridge={bridge?.attachments} embedded />
          </CollapsibleCard>
          <CollapsibleCard
            id="diagnostics-worktrees"
            title="Review worktrees"
            subtitle="Inspect and clean up Review Board worktrees."
            keywords={['worktree', 'review', 'git', 'cleanup']}
          >
            <WorktreesSection embedded />
          </CollapsibleCard>
          <CollapsibleCard
            id="diagnostics-advanced"
            title="Advanced"
            subtitle="Looking for a specific setting? Every module is editable under the Configuration tab."
            icon={<AdvancedIcon size={22} />}
            tone="neutral"
            keywords={['advanced', 'configuration', 'module']}
            actions={
              <Button variant="ghost" onClick={() => setTab('config')}>
                Open Configuration
              </Button>
            }
          >
            <p className="page-subtitle">
              Every module setting is editable under the Configuration tab.
            </p>
          </CollapsibleCard>
        </SettingsPage>
      )}
    </>
  );
}

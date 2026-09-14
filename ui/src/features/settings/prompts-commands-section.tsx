import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { ConfigResponse, ConfigValue } from '../../lib/types.js';
import { Button, Card, ErrorText, IconBadge } from '../../components/ui.js';
import { ErrorState } from '../../components/error-state.js';
import { Loader } from '../../components/loading.js';
import { AiMagicIcon, CheckIcon } from '../../components/icons.js';
import {
  PROMPT_CATALOG,
  type PromptCatalogField,
  type PromptCatalogReadOnly,
} from './prompts-catalog.js';
import { promptAnchorId } from './prompts-nav.js';

function asString(value: ConfigValue): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Editor for one config-backed prompt/command, persisted per-key on save. */
function PromptFieldEditor({
  field,
  data,
  onSaved,
}: {
  field: PromptCatalogField;
  data: ConfigResponse;
  onSaved: () => void;
}) {
  const api = useApi();
  const override = data.overrides[field.namespace]?.[field.key];
  // `current` is the config snapshot loaded at startup; a just-saved value that
  // requires a restart only appears in `overrides`. Prefer the override so the
  // editor reflects the persisted value immediately, falling back to the live
  // snapshot and then the default.
  const persisted =
    override !== undefined ? override : data.current[field.namespace]?.[field.key];
  const current = asString(persisted);
  const defaultValue = asString(data.defaults[field.namespace]?.[field.key]);
  const [draft, setDraft] = useState(current);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-sync the draft whenever the persisted value changes (e.g. after a
  // reload), but leave in-progress edits alone otherwise.
  useEffect(() => {
    setDraft(current);
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const dirty = draft !== current;
  const isDefault = current === defaultValue;
  const draftIsDefault = draft === defaultValue;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateConfig(field.namespace, { [field.key]: draft });
      setSaved(true);
      onSaved();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id={promptAnchorId(field.namespace, field.key)} className="prompt-entry">
      <div className="prompt-entry-head">
        <h4 className="prompt-entry-title">{field.label}</h4>
        <code className="prompt-entry-path">
          {field.namespace}.{field.key}
        </code>
        {!isDefault && (
          <span className="prompt-entry-flag" title="Overridden from default">
            Modified
          </span>
        )}
      </div>
      <p className="prompt-entry-desc">{field.description}</p>
      {field.placeholders && field.placeholders.length > 0 && (
        <p className="prompt-entry-placeholders">
          Placeholders:{' '}
          {field.placeholders.map((p, i) => (
            <span key={p}>
              {i > 0 && ' '}
              <code>{`{{${p}}}`}</code>
            </span>
          ))}
        </p>
      )}
      <textarea
        className="prompt-entry-textarea"
        value={draft}
        spellCheck={false}
        rows={Math.min(20, Math.max(4, draft.split('\n').length + 1))}
        onChange={(e) => {
          setDraft(e.target.value);
          setSaved(false);
        }}
        aria-label={`${field.label} prompt template`}
      />
      <div className="prompt-entry-actions">
        <Button onClick={save} loading={saving} disabled={!dirty}>
          Save
        </Button>
        <Button
          variant="ghost"
          onClick={() => setDraft(current)}
          disabled={!dirty}
        >
          Revert edits
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setDraft(defaultValue);
            setSaved(false);
          }}
          disabled={draftIsDefault}
        >
          Restore default
        </Button>
        {saved && (
          <span className="prompt-entry-saved">
            <CheckIcon size={13} /> Saved — restart to apply
          </span>
        )}
      </div>
      <ErrorText error={saveError} />
    </div>
  );
}

/** A non-editable prompt/command shown for transparency. */
function PromptReadOnly({ entry }: { entry: PromptCatalogReadOnly }) {
  return (
    <div id={entry.id} className="prompt-entry prompt-entry-readonly">
      <div className="prompt-entry-head">
        <h4 className="prompt-entry-title">{entry.label}</h4>
        <span className="prompt-entry-flag prompt-entry-flag-ro">
          {entry.command ? 'Command' : 'Read-only'}
        </span>
      </div>
      <p className="prompt-entry-desc">{entry.description}</p>
      <pre className="prompt-entry-pre">{entry.text}</pre>
    </div>
  );
}

/**
 * Settings → Prompts & Commands. A curated, grouped view over every prompt and
 * command the IDE sends to AI providers/CLIs. Config-backed prompts are edited
 * inline (persisted through the standard config override API); commands and
 * hardcoded prompts are shown read-only.
 */
export function PromptsCommandsSection({
  focusAnchor,
}: {
  /** When set, scroll to and briefly highlight this entry's anchor. */
  focusAnchor?: string | null;
}) {
  const api = useApi();
  const { data, loading, error, cause, reload } = useAsync(
    () => api.getConfig(),
    [],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!focusAnchor || !data) return;
    // Defer to the next frame so the target has been rendered/laid out.
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(focusAnchor);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('prompt-entry-highlight');
      window.setTimeout(
        () => el.classList.remove('prompt-entry-highlight'),
        2200,
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [focusAnchor, data]);

  return (
    <div className="settings-panel" ref={rootRef}>
      <Card>
        <div className="page-header">
          <div className="page-header-main">
            <IconBadge icon={<AiMagicIcon size={18} />} tone="ai" glow />
            <div>
              <h2 className="page-title">Prompts &amp; Commands</h2>
              <p className="page-subtitle">
                Every prompt and command the IDE sends to the AI, grouped by the
                operation it drives. Edit a prompt to change how that feature
                reasons; saved changes apply after a restart. Environment
                variables still take precedence.
              </p>
            </div>
          </div>
        </div>
      </Card>

      {loading && <Loader label="Loading prompts…" />}
      {error && <ErrorState error={cause ?? error} onRetry={reload} />}

      {data &&
        PROMPT_CATALOG.map((section) => (
          <Card key={section.id} className="prompt-section">
            <div className="prompt-section-head">
              <h3 className="prompt-section-title">{section.title}</h3>
              <p className="prompt-section-desc">{section.description}</p>
            </div>
            <div className="prompt-section-body">
              {section.fields.map((field) => (
                <PromptFieldEditor
                  key={`${field.namespace}.${field.key}`}
                  field={field}
                  data={data}
                  onSaved={reload}
                />
              ))}
              {section.readOnly?.map((entry) => (
                <PromptReadOnly key={entry.id} entry={entry} />
              ))}
            </div>
          </Card>
        ))}
    </div>
  );
}

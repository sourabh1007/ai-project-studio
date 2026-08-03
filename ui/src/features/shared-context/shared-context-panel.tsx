import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText } from '../../components/ui.js';
import { Loader } from '../../components/loading.js';
import type {
  ContextScope,
  ContextStatusPhase,
  SharedContextDoc,
} from '../../lib/types.js';

const UPDATED_BY_LABEL: Record<SharedContextDoc['updatedBy'], string> = {
  merge: 'AI-curated from sessions',
  manual: 'Manually edited',
  import: 'Imported',
};

/** Human-readable label for each live merge phase (drives the animated pill). */
const PHASE_LABEL: Record<Exclude<ContextStatusPhase, 'idle'>, string> = {
  generating: 'Generating shared context…',
  saving: 'Saving context…',
  sharing: 'Sharing with live sessions…',
};

/**
 * Editable view of one layer of the shared-context store. The document is
 * durable, curated instruction-style markdown that is injected into every
 * future dev session at launch and live-pushed into running ones. Auto-merge
 * refreshes the feature layer after each session; this panel lets the user read
 * and hand-edit any layer.
 */
export function SharedContextPanel({
  scope,
  scopeId,
  title,
  hint,
  livePhase,
}: {
  scope: ContextScope;
  scopeId: string;
  title: string;
  hint?: string;
  livePhase?: ContextStatusPhase;
}) {
  const api = useApi();
  const [doc, setDoc] = useState<SharedContextDoc | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [justUpdated, setJustUpdated] = useState(false);

  const reload = useCallback(() => {
    let active = true;
    setError(null);
    api
      .getSharedContext(scope, scopeId)
      .then((result) => {
        if (!active) {
          return;
        }
        setDoc(result);
        setDirty((wasDirty) => {
          if (!wasDirty) {
            setDraft(result?.content ?? '');
          }
          return wasDirty;
        });
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, scope, scopeId]);

  useEffect(() => {
    setLoading(true);
    return reload();
  }, [reload]);

  // When a live background merge finishes (phase → idle after being active),
  // pull the freshly-curated document and flash a brief "updated" confirmation.
  const prevPhase = useRef<ContextStatusPhase | undefined>(undefined);
  useEffect(() => {
    const was = prevPhase.current;
    prevPhase.current = livePhase;
    if (livePhase === 'idle' && was && was !== 'idle') {
      reload();
      setJustUpdated(true);
      const timer = setTimeout(() => setJustUpdated(false), 2200);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [livePhase, reload]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveSharedContext(scope, scopeId, draft);
      setDoc(saved);
      setDraft(saved.content);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const activePhase =
    livePhase && livePhase !== 'idle' ? livePhase : undefined;

  return (
    <section className="shared-context">
      <header className="shared-context-head">
        <div>
          <h3 className="shared-context-title">{title}</h3>
          {hint && <span className="shared-context-hint">{hint}</span>}
        </div>
        <div className="shared-context-status">
          {activePhase && (
            <span
              className="shared-context-live shared-context-live-active"
              role="status"
            >
              <span className="spinner" aria-hidden="true" />
              {PHASE_LABEL[activePhase]}
            </span>
          )}
          {!activePhase && justUpdated && (
            <span className="shared-context-live shared-context-live-done">
              ✓ Context updated
            </span>
          )}
          {!activePhase && !justUpdated && doc && (
            <span className="shared-context-meta" title={doc.updatedAt}>
              {UPDATED_BY_LABEL[doc.updatedBy]} ·{' '}
              {new Date(doc.updatedAt).toLocaleString()}
            </span>
          )}
        </div>
      </header>

      {loading ? (
        <Loader label="Loading context" />
      ) : (
        <>
          <textarea
            className="shared-context-editor"
            value={draft}
            spellCheck={false}
            placeholder="No shared context yet. Add durable conventions, decisions, and gotchas that every future session should know."
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
            }}
          />
          <ErrorText error={error} />
          <div className="shared-context-actions">
            <span className="shared-context-note">
              Injected into every session in this scope.
            </span>
            <Button onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

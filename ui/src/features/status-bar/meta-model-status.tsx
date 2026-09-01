import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { metaModelLabel } from '../../lib/meta-model.js';
import type { MetaSettings, ModelInfo, ProviderInfo } from '../../lib/types.js';

/**
 * Status-bar control showing which provider/model the IDE uses for its
 * metasessions (summaries, PR review, monitors, …) and letting the user change
 * it live. A change applies to all *new* metasessions immediately — no restart.
 */
export function MetaModelStatus(): JSX.Element | null {
  const api = useApi();
  const [settings, setSettings] = useState<MetaSettings | null>(null);
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [draftProvider, setDraftProvider] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void api
      .getMetaSettings()
      .then((value) => {
        if (alive) setSettings(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);

  const loadModels = useCallback(
    (providerId: string) => {
      void api
        .listModels(providerId)
        .then((list) => setModels(list))
        .catch(() => setModels([]));
    },
    [api],
  );

  const openPicker = useCallback(() => {
    if (!settings) return;
    setError(null);
    setDraftProvider(settings.providerId);
    setDraftModel(settings.model);
    setOpen(true);
    setModels([]);
    loadModels(settings.providerId);
    void api
      .listProviders()
      .then((list) => setProviders(list))
      .catch(() => setProviders([]));
  }, [api, settings, loadModels]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onProviderChange = useCallback(
    (providerId: string) => {
      setDraftProvider(providerId);
      setDraftModel('auto');
      setModels([]);
      loadModels(providerId);
    },
    [loadModels],
  );

  const apply = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.updateMetaSettings({
        providerId: draftProvider,
        model: draftModel,
      });
      setSettings(next);
      setOpen(false);
    } catch {
      setError('Could not update the AI model. Try again.');
    } finally {
      setSaving(false);
    }
  }, [api, draftProvider, draftModel]);

  if (!settings) {
    return null;
  }

  const modelOptions =
    models.length > 0 || draftModel === 'auto'
      ? models
      : [{ id: draftModel, label: draftModel }];

  return (
    <div className="statusbar-meta" ref={rootRef}>
      <button
        type="button"
        className="statusbar-item statusbar-meta-trigger"
        onClick={() => (open ? setOpen(false) : openPicker())}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="AI model powering the IDE's metasessions — click to change (applies to new metasessions)"
      >
        <span className="statusbar-meta-dot" aria-hidden="true" />
        {metaModelLabel(settings)}
      </button>
      {open && (
        <div
          className="statusbar-meta-popover"
          role="dialog"
          aria-label="IDE AI model"
        >
          <div className="statusbar-meta-title">IDE metasession AI</div>
          <label className="statusbar-meta-field">
            <span>Provider</span>
            <select
              value={draftProvider}
              onChange={(event) => onProviderChange(event.target.value)}
            >
              {providers.length === 0 && (
                <option value={draftProvider}>{draftProvider}</option>
              )}
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.id}
                </option>
              ))}
            </select>
          </label>
          <label className="statusbar-meta-field">
            <span>Model</span>
            <select
              value={draftModel}
              onChange={(event) => setDraftModel(event.target.value)}
            >
              <option value="auto">Auto</option>
              {modelOptions
                .filter((model) => model.id !== 'auto')
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
            </select>
          </label>
          {settings.warmPoolEnabled && draftModel !== 'auto' && (
            <p className="statusbar-meta-note">
              A specific model runs on the cold path (warm pool uses the
              default).
            </p>
          )}
          {error && <p className="statusbar-meta-error">{error}</p>}
          <div className="statusbar-meta-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void apply()}
              disabled={saving}
            >
              {saving ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

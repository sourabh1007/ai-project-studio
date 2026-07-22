import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { ModelInfo, Session } from '../../lib/types.js';
import { Button, ErrorText } from '../../components/ui.js';
import { ProviderPicker } from '../../components/provider-picker.js';
import { ModelPicker } from '../../components/model-picker.js';

/**
 * Compact form to launch a new interactive Session under a Feature: pick a
 * provider and model (both fetched, never hardcoded), then create a terminal
 * session record the workspace opens as a live CLI.
 */
export function NewSessionForm({
  featureId,
  onCreated,
  onCancel,
}: {
  featureId: string;
  onCreated: (session: Session) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const providers = useAsync(() => api.listProviders(), []);
  const [providerId, setProviderId] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [model, setModel] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!providerId && providers.data && providers.data.length > 0) {
      setProviderId(providers.data[0].id);
    }
  }, [providers.data, providerId]);

  useEffect(() => {
    if (!providerId) {
      return;
    }
    let active = true;
    setModelsLoading(true);
    api
      .listModels(providerId)
      .then((list) => {
        if (active) {
          setModels(list);
          setModel(list[0]?.id ?? '');
        }
      })
      .finally(() => {
        if (active) {
          setModelsLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, providerId]);

  async function create() {
    setStarting(true);
    setError(null);
    try {
      const session = await api.createTerminalSession(featureId, {
        providerId,
        model: model || undefined,
        kind: 'dev',
      });
      onCreated(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="new-session glass">
      <ProviderPicker
        providers={providers.data ?? []}
        value={providerId}
        onChange={setProviderId}
      />
      <ModelPicker
        models={models}
        value={model}
        onChange={setModel}
        loading={modelsLoading}
      />
      <ErrorText error={providers.error ?? error} />
      <div className="row">
        <Button onClick={create} disabled={starting || !providerId}>
          {starting ? 'Opening…' : 'Open session'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { Session } from '../../lib/types.js';
import { Button, ErrorText } from '../../components/ui.js';
import { ProviderPicker } from '../../components/provider-picker.js';

/**
 * Compact form to launch a new interactive Session under a Feature: pick a
 * provider (fetched, never hardcoded), then create a terminal session record
 * the workspace opens as a live CLI. The model is chosen inside the shell, so
 * it is intentionally not surfaced here.
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
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!providerId && providers.data && providers.data.length > 0) {
      setProviderId(providers.data[0].id);
    }
  }, [providers.data, providerId]);

  async function create() {
    setStarting(true);
    setError(null);
    try {
      const session = await api.createTerminalSession(featureId, {
        providerId,
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
      <div className="new-session-title">New session</div>
      <ProviderPicker
        providers={providers.data ?? []}
        value={providerId}
        onChange={setProviderId}
      />
      <ErrorText error={providers.error ?? error} />
      <div className="new-session-actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={create} disabled={starting || !providerId}>
          {starting ? 'Opening…' : 'Open session'}
        </Button>
      </div>
    </div>
  );
}

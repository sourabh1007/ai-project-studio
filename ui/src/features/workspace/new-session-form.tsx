import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { Session } from '../../lib/types.js';
import { installedProviders } from '../../lib/providers.js';
import { Button, ErrorText } from '../../components/ui.js';
import { withOperationKey } from '../../lib/operation-keys.js';
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
  const bootstrap = useAsync(() => api.getProviderBootstrap(), []);
  const available = useMemo(
    () => bootstrap.data?.selectionRequired === true ? [] : installedProviders(providers.data ?? [])
      .filter((provider) => provider.id === bootstrap.data?.defaultProvider),
    [providers.data, bootstrap.data],
  );
  const [providerId, setProviderId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptId = useId();
  // Deliver a session created after unmount/cancel to the latest host callback.
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    promptRef.current?.focus();
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (providerId || available.length === 0 || bootstrap.loading) {
      return;
    }
    const preferred = bootstrap.data?.defaultProvider;
    const match = preferred
      ? available.find((provider) => provider.id === preferred)
      : undefined;
    setProviderId((match ?? available[0]).id);
  }, [available, bootstrap.loading, bootstrap.data, providerId]);

  async function create() {
    if (startingRef.current || !providerId) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    const initialPrompt = prompt.trim();
    try {
      const input = {
        providerId,
        kind: 'dev' as const,
        ...(initialPrompt ? { prompt: initialPrompt } : {}),
      };
      const session = await withOperationKey(`session.create:${featureId}`, input, 'session', (operation) =>
        api.createTerminalSession(featureId, input, operation),
      );
      onCreatedRef.current(session);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setStarting(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (!event.repeat) void create();
    } else if (event.key === 'Escape' && !event.defaultPrevented && !starting && prompt.length === 0) {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="new-session glass" onKeyDown={onKeyDown}>
      <div className="new-session-title">New session</div>
      <ProviderPicker
        providers={available}
        value={providerId}
        onChange={setProviderId}
      />
      <label className="field" htmlFor={promptId}>
        <span>Initial prompt (optional)</span>
        <textarea
          id={promptId}
          ref={promptRef}
          className="session-prompt-input"
          rows={3}
          value={prompt}
          readOnly={starting}
          placeholder="Sent to the session when it opens. Ctrl/Cmd+Enter to open."
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <ErrorText error={providers.error ?? bootstrap.error ?? error} />
      {!bootstrap.loading && !bootstrap.error && available.length === 0 && <p>Select and install an active CLI in Settings → CLI before creating a session.</p>}
      <div className="new-session-actions">
        <Button variant="ghost" onClick={onCancel} disabled={starting}>
          Cancel
        </Button>
        <Button onClick={create} disabled={starting || !providerId}>
          {starting ? 'Opening…' : 'Open session'}
        </Button>
      </div>
    </div>
  );
}

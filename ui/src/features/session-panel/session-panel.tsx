import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { formatDateTime } from '../../lib/format.js';
import { sessionLiveTotals, type LiveState } from '../../lib/stream.js';
import type { ModelInfo, Session } from '../../lib/types.js';
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  StatusBadge,
} from '../../components/ui.js';
import { ProviderPicker } from '../../components/provider-picker.js';
import { ModelPicker } from '../../components/model-picker.js';
import { LiveCreditMeter } from '../live-credit-meter/live-credit-meter.js';

export function SessionPanel({
  featureId,
  live,
}: {
  featureId: string;
  live: LiveState;
}) {
  const api = useApi();
  const providers = useAsync(() => api.listProviders(), []);
  const sessions = useAsync(() => api.listSessions(featureId), [featureId]);

  const [providerId, setProviderId] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  async function start() {
    if (!prompt.trim()) {
      setStartError('Prompt is required');
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      const session = await api.startSession(featureId, {
        providerId,
        model: model || undefined,
        prompt: prompt.trim(),
        kind: 'dev',
      });
      setPrompt('');
      setSelectedId(session.id);
      sessions.reload();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  const merged: Session[] = (sessions.data ?? []).map((session) => {
    const liveSession = live.sessions[session.id];
    return liveSession ? { ...session, ...liveSession } : session;
  });
  const selected = merged.find((session) => session.id === selectedId) ?? null;
  const outputLines = selected ? live.outputBySession[selected.id] ?? [] : [];

  return (
    <div className="grid grid-2">
      <Card>
        <h2 className="page-title">Start a session</h2>
        <div style={{ marginTop: 'var(--space-4)' }}>
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
          <div className="field">
            <label htmlFor="session-prompt">Prompt</label>
            <textarea
              id="session-prompt"
              className="textarea"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe the task for the AI…"
            />
          </div>
          <ErrorText error={providers.error ?? startError} />
          <Button onClick={start} disabled={starting || !providerId}>
            {starting ? 'Launching…' : 'Launch session'}
          </Button>
        </div>
      </Card>

      <Card>
        <h2 className="page-title">Sessions</h2>
        {sessions.loading && <EmptyState message="Loading sessions…" />}
        <ErrorText error={sessions.error} />
        {sessions.data && merged.length === 0 && (
          <EmptyState message="No sessions yet." />
        )}
        <div className="list" style={{ marginTop: 'var(--space-3)' }}>
          {merged.map((session) => (
            <button
              key={session.id}
              type="button"
              className="list-row"
              aria-current={session.id === selectedId ? 'true' : undefined}
              onClick={() => setSelectedId(session.id)}
            >
              <span>
                <strong>{session.provider}</strong>{' '}
                <span className="muted">
                  {session.resolvedModel ?? session.requestedModel}
                </span>
                <br />
                <span className="muted">
                  {formatDateTime(session.startedAt ?? session.createdAt)}
                </span>
              </span>
              <StatusBadge status={session.status} />
            </button>
          ))}
        </div>
      </Card>

      {selected && (
        <Card className="grid-span">
          <div className="page-header">
            <h3>Live session · {selected.provider}</h3>
            <StatusBadge status={selected.status} />
          </div>
          <LiveCreditMeter totals={sessionLiveTotals(live, selected.id)} />
          <div className="terminal-log" style={{ marginTop: 'var(--space-4)' }}>
            {outputLines.length === 0
              ? 'Waiting for output…'
              : outputLines.join('')}
          </div>
        </Card>
      )}
    </div>
  );
}

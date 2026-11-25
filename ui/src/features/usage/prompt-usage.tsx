import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { UsageIcon } from '../../components/icons.js';
import { Button } from '../../components/ui.js';
import { formatAic, formatTokens } from '../../lib/format.js';
import type { MetaOperation } from '../meta-operations/meta-operation-types.js';
import { PROMPT_CATALOG } from '../settings/prompts-catalog.js';
import { HistoryChart } from '../monitoring/insights.js';

export const OPEN_PROMPT_USAGE_EVENT = 'cw:open-prompt-usage';
export interface PromptUsageTarget { promptRef: string; nonce: number }
export interface PromptUsageSnapshot {
  events: Array<{
    eventId: string; promptRefs: string[]; sessionId: string | null; providerId: string | null;
    kind: 'request' | 'context-prepared' | 'context-injected'; recordedAt: string;
    state: string; usage: MetaOperation['usage'];
  }>;
  limited: boolean;
  maxEvents: number;
}

export function PromptUsageMarker({ promptRef, label }: { promptRef: string; label: string }) {
  return <Button variant="ghost" className="btn-sm"
    ariaLabel={`View ${label} prompt usage`} title="View recorded prompt usage and charts"
    onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PROMPT_USAGE_EVENT, { detail: promptRef }))}>
    <UsageIcon size={14} />
  </Button>;
}

const catalog = PROMPT_CATALOG.flatMap((section) => [
  ...section.fields.map((field) => ({ ref: `${field.namespace}.${field.key}`, label: field.label })),
  ...(section.readOnly ?? []).map((entry) => ({ ref: entry.id, label: entry.label })),
]);

export function PromptUsage({ window, signal, target }: {
  window: { from: string; to: string }; signal: number; target?: PromptUsageTarget;
}) {
  const api = useApi();
  const [promptRef, setPromptRef] = useState(target?.promptRef ?? '');
  const [data, setData] = useState<PromptUsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { if (target) setPromptRef(target.promptRef); }, [target]);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    api.getPromptUsage({
      from: `${window.from}T00:00:00.000Z`, to: `${window.to}T00:00:00.000Z`,
      ...(promptRef ? { promptRef } : {}),
    }, controller.signal).then((value) => {
      if (!controller.signal.aborted) setData(value);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => controller.abort();
  }, [api, window.from, window.to, promptRef, signal, refresh]);
  const events = data?.events ?? [];
  const requests = events.filter((event) => event.kind === 'request');
  const days = new Map<string, number>();
  for (const event of events) {
    const day = event.recordedAt.slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  const max = Math.max(1, ...days.values());
  const totals = (field: 'inputTokens' | 'outputTokens' | 'nanoAiu') => {
    const values = requests.flatMap((event) => event.usage?.[field] == null ? [] : [event.usage[field]!]);
    return { value: values.length ? values.reduce((a, b) => a + b, 0) : null, reported: values.length };
  };
  const input = totals('inputTokens'), output = totals('outputTokens'), aic = totals('nanoAiu');
  return <section className="usage-section" aria-label="Prompt usage">
    <h3>Prompt usage</h3>
    <p className="field-hint">IDE requests and workspace skill context, across both usage scopes. Uses the selected UTC time frame.</p>
    <details><summary>About prompt attribution</summary><p className="field-hint">
      Attribution starts with this update; older requests are unattributed, not zero usage.
      Requests record template participation, not success. Context preparation or injection is not a model invocation.
      Request-level tokens and AIC are shared by all participating templates; do not add per-template totals.
      Shared-session totals are never assigned to a prompt. Overall Usage remains the accounting authority.
    </p></details>
    <div className="usage-controls"><label>Prompt <select className="input" value={promptRef} onChange={(event) => setPromptRef(event.target.value)}>
      <option value="">All attributed prompts</option>
      {catalog.map((entry) => <option key={entry.ref} value={entry.ref}>{entry.label}</option>)}
    </select></label>
    <Button variant="ghost" className="btn-sm" onClick={() => setRefresh((value) => value + 1)}>Refresh prompt usage</Button></div>
    {error && <p role="alert">Could not load prompt usage: {error}</p>}
    {!data && !error && <p role="status">Loading prompt usage...</p>}
    {data && <>
      {data.limited && <p role="status">Showing the latest {data.maxEvents} matching events only; charts and totals are partial.</p>}
      <p>{requests.length} requests; {events.filter((event) => event.kind === 'context-prepared').length} context preparations;{' '}
        {events.filter((event) => event.kind === 'context-injected').length} context injections.</p>
      <p>Request-level reported usage: {formatAic(aic.value)} AIC ({aic.reported}/{requests.length} reported),{' '}
        {input.value === null ? 'Unavailable' : formatTokens(input.value)} input tokens ({input.reported}/{requests.length} reported),{' '}
        {output.value === null ? 'Unavailable' : formatTokens(output.value)} output tokens ({output.reported}/{requests.length} reported).</p>
      {events.length === 0 ? <p>No attributed events recorded in this window. Historical attribution is unavailable.</p> :
        <div className="usage-periods" aria-label="Prompt activity by UTC day">
          {[...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) =>
            <div className="usage-period-row" key={day}>
              <span className="usage-period-label">{day}</span>
              <span className="dash-bar-track usage-period-bar" aria-hidden="true">
                <span className="dash-bar-fill" style={{ width: `${100 * count / max}%` }} />
              </span><span>{count} events</span>
            </div>)}
        </div>}
      {requests.length > 0 && <div className="usage-split">
        {(['inputTokens', 'outputTokens', 'nanoAiu'] as const).map((field) =>
          <HistoryChart key={field}
            title={field === 'nanoAiu' ? 'Prompt request AIC' : field === 'inputTokens' ? 'Prompt request input tokens' : 'Prompt request output tokens'}
            unit={field === 'nanoAiu' ? 'AIC' : 'tokens'}
            explain="One point per request, including failed attempts. Gaps are unavailable metering, not zero; values are shared by participating templates."
            points={[...requests].reverse().map((event) => ({
              id: event.eventId, at: Date.parse(event.recordedAt),
              label: `${event.recordedAt} (${event.state})`,
              value: event.usage?.[field] == null ? null : event.usage[field]! / (field === 'nanoAiu' ? 1e9 : 1),
            }))} />)}
      </div>}
    </>}
  </section>;
}

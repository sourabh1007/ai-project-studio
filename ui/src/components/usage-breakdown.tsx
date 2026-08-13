import { useMemo } from 'react';
import { useApi } from '../app/api-context.js';
import { useAsync } from '../hooks/use-async.js';
import { useVirtualWindow } from '../hooks/use-virtual-window.js';
import {
  formatAic,
  formatCompactNumber,
  formatDateTime,
  nanoAiuToAic,
} from '../lib/format.js';
import type { StoredUsage } from '../lib/types.js';
import { Loader } from './loading.js';
import { EmptyState, ErrorText, Modal } from './ui.js';
import { ArrowDownIcon, ArrowUpIcon, UsageIcon } from './icons.js';

/** The scope a usage breakdown is opened for. */
export type UsageScope =
  | { kind: 'session'; id: string; label: string }
  | { kind: 'feature'; id: string; label: string }
  | { kind: 'repo'; id: string; label: string };

interface Totals {
  turns: number;
  nanoAiu: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

function sum(events: StoredUsage[]): Totals {
  return events.reduce<Totals>(
    (acc, e) => ({
      turns: acc.turns + 1,
      nanoAiu: acc.nanoAiu + e.nanoAiu,
      inputTokens: acc.inputTokens + e.inputTokens,
      outputTokens: acc.outputTokens + e.outputTokens,
      reasoningOutputTokens: acc.reasoningOutputTokens + e.reasoningOutputTokens,
    }),
    {
      turns: 0,
      nanoAiu: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
  );
}

/** Groups events by resolved model and sums their AIC, richest spender first. */
function byModel(events: StoredUsage[]): { model: string; nanoAiu: number }[] {
  const map = new Map<string, number>();
  for (const e of events) {
    const model = e.resolvedModel || e.requestedModel || 'unknown';
    map.set(model, (map.get(model) ?? 0) + e.nanoAiu);
  }
  return [...map.entries()]
    .map(([model, nanoAiu]) => ({ model, nanoAiu }))
    .sort((a, b) => b.nanoAiu - a.nanoAiu);
}

function loadFor(
  api: ReturnType<typeof useApi>,
  scope: UsageScope,
): Promise<StoredUsage[]> {
  switch (scope.kind) {
    case 'session':
      return api.getSessionUsageEvents(scope.id);
    case 'feature':
      return api.getFeatureUsageEvents(scope.id);
    case 'repo':
      return api.getRepoUsageEvents(scope.id);
  }
}

const SCOPE_NOUN: Record<UsageScope['kind'], string> = {
  session: 'session',
  feature: 'feature',
  repo: 'repository',
};

/**
 * A drill-down that answers "how is each credit and token being used" by
 * listing every per-turn usage event for a session, feature, or repository,
 * with per-model subtotals and an overall summary.
 */
export function UsageBreakdownModal({
  scope,
  onClose,
}: {
  scope: UsageScope;
  onClose: () => void;
}) {
  const api = useApi();
  const { data, loading, error } = useAsync<StoredUsage[]>(
    () => loadFor(api, scope),
    [scope.kind, scope.id],
  );
  const events = data ?? [];
  const totals = useMemo(() => sum(events), [events]);
  const models = useMemo(() => byModel(events), [events]);

  return (
    <Modal title={`Usage breakdown · ${scope.label}`} onClose={onClose}>
      <div className="usage-breakdown">
        <p className="usage-breakdown-sub">
          Every AI credit and token recorded for this {SCOPE_NOUN[scope.kind]},
          one row per turn.
        </p>

        {loading && <Loader label="Loading usage" />}
        <ErrorText error={error} />

        {!loading && !error && events.length === 0 && (
          <EmptyState message="No usage recorded yet." />
        )}

        {!loading && !error && events.length > 0 && (
          <>
            <div className="usage-breakdown-summary">
              <div className="usage-summary-item">
                <span className="usage-summary-value">
                  <UsageIcon size={13} /> {formatAic(totals.nanoAiu)}
                </span>
                <span className="usage-summary-label">AIC used</span>
              </div>
              <div className="usage-summary-item">
                <span className="usage-summary-value">
                  <ArrowUpIcon size={13} />{' '}
                  {formatCompactNumber(totals.inputTokens)}
                </span>
                <span className="usage-summary-label">Input tokens</span>
              </div>
              <div className="usage-summary-item">
                <span className="usage-summary-value">
                  <ArrowDownIcon size={13} />{' '}
                  {formatCompactNumber(totals.outputTokens)}
                </span>
                <span className="usage-summary-label">Output tokens</span>
              </div>
              <div className="usage-summary-item">
                <span className="usage-summary-value">
                  {formatCompactNumber(totals.reasoningOutputTokens)}
                </span>
                <span className="usage-summary-label">Reasoning tokens</span>
              </div>
              <div className="usage-summary-item">
                <span className="usage-summary-value">{totals.turns}</span>
                <span className="usage-summary-label">Turns</span>
              </div>
            </div>

            {models.length > 1 && (
              <ul className="usage-breakdown-models">
                {models.map((m) => (
                  <li key={m.model} className="usage-model-row">
                    <span className="usage-model-name">{m.model}</span>
                    <span className="usage-model-aic">
                      {formatAic(m.nanoAiu)} AIC
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <UsageEventsTable events={events} />
          </>
        )}
      </div>
    </Modal>
  );
}

/** Approximate fixed height of one usage row, in pixels (see app.css). */
const USAGE_ROW_HEIGHT = 25;

/**
 * The per-turn usage table, virtualized so a session with thousands of turns
 * renders only the rows in view. Spacer rows preserve the scrollbar geometry so
 * the sticky header, scroll position, and row alignment stay correct.
 */
function UsageEventsTable({ events }: { events: StoredUsage[] }) {
  const { ref, window } = useVirtualWindow<HTMLDivElement>({
    rowHeight: USAGE_ROW_HEIGHT,
    rowCount: events.length,
  });
  const visible = events.slice(window.startIndex, window.endIndex);

  return (
    <div ref={ref} className="usage-table-scroll">
      <table className="usage-breakdown-table">
        <thead>
          <tr>
            <th scope="col">Turn</th>
            <th scope="col">Model</th>
            <th scope="col">Operation</th>
            <th scope="col">Input</th>
            <th scope="col">Output</th>
            <th scope="col">Reasoning</th>
            <th scope="col">AIC</th>
            <th scope="col">When</th>
          </tr>
        </thead>
        <tbody>
          {window.topPad > 0 && (
            <tr aria-hidden="true" style={{ height: window.topPad }}>
              <td colSpan={8} />
            </tr>
          )}
          {visible.map((e) => (
            <tr key={`${e.sessionId}:${e.turnIndex}`}>
              <td>{e.turnIndex}</td>
              <td title={e.provider}>{e.resolvedModel || e.requestedModel}</td>
              <td>{e.operation}</td>
              <td>{formatCompactNumber(e.inputTokens)}</td>
              <td>{formatCompactNumber(e.outputTokens)}</td>
              <td>{formatCompactNumber(e.reasoningOutputTokens)}</td>
              <td>{nanoAiuToAic(e.nanoAiu).toFixed(4)}</td>
              <td className="usage-when">{formatDateTime(e.startedAt)}</td>
            </tr>
          ))}
          {window.bottomPad > 0 && (
            <tr aria-hidden="true" style={{ height: window.bottomPad }}>
              <td colSpan={8} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

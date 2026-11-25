import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { HistoryChart, type HistoryPoint } from '../monitoring/insights.js';
import { useAsync } from '../../hooks/use-async.js';
import { useMicrosoftSignedIn } from '../../hooks/use-microsoft-identity.js';
import { installedProviders } from '../../lib/providers.js';
import { useActiveSessions } from '../active-sessions/use-active-sessions.js';
import type { ActiveSessionEntry } from '../active-sessions/active-session-types.js';
import '../active-sessions/active-sessions.css';
import { providerLabel } from '../../lib/meta-model.js';
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  IconBadge,
  Modal,
  StatusBadge,
} from '../../components/ui.js';
import {
  ActivityIcon,
  ChevronIcon,
} from '../../components/icons.js';
import { Loader, Spinner } from '../../components/loading.js';
import { ErrorState } from '../../components/error-state.js';
import type {
  MetaModelOption,
  MetaPoolStat,
  MetaSessionInfo,
  MetaSessionState,
  MetaSettings,
  MetaPoolsStatus,
  ModelInfo,
  ProviderInfo,
} from '../../lib/types.js';
import {
  formatClock,
  formatDuration,
  formatTokens,
  purposeLabel,
  savedWarmPool as readSavedWarmPool,
  sessionSeq,
  turnWork,
  type WarmPoolConfig,
} from '../../lib/metasession-format.js';

/** How often the live warm-pool status is refreshed while the page is open. */
const POLL_MS = 4000;

/** Faster status cadence while a pool is actively growing or shrinking. */
const CONVERGING_POLL_MS = 1000;

/** Milliseconds an exiting session chip lingers so its removal animates. */
const EXIT_MS = 320;



import { desktopBridge } from '../../lib/desktop-bridge.js';

const STATE_LABEL: Record<MetaSessionState, string> = {
  warming: 'Warming',
  idle: 'Idle',
  busy: 'Busy',
};

/**
 * Whether a session can take a command right now, in plain terms. "Idle" reads
 * as ambiguous on its own, so the detail view spells out that it means ready to
 * lease, versus warming (booting) or busy (mid-turn).
 */
const STATE_READINESS: Record<
  MetaSessionState,
  { ready: 'yes' | 'no' | 'busy'; pill: string; note: string }
> = {
  warming: {
    ready: 'no',
    pill: 'Not ready yet',
    note: 'Booting up — it cannot take a command until it finishes warming.',
  },
  idle: {
    ready: 'yes',
    pill: 'Ready for a command',
    note: 'Warm and waiting — the IDE can lease this session for its next turn immediately.',
  },
  busy: {
    ready: 'busy',
    pill: 'Serving a command',
    note: 'Currently handling a turn — it takes the next command once this one finishes.',
  },
};

/**
 * Merges the live session list with recently-removed sessions so additions
 * animate in and removals animate out before disappearing. Session ids are
 * unique and monotonically increasing, so an id never re-enters after leaving.
 */
function useAnimatedSessions(
  sessions: readonly MetaSessionInfo[],
): Array<{ info: MetaSessionInfo; exiting: boolean }> {
  const [rendered, setRendered] = useState<
    Array<{ info: MetaSessionInfo; exiting: boolean }>
  >([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timersRef = timers.current;
    setRendered((prev) => {
      const liveIds = new Set(sessions.map((s) => s.id));
      const next = sessions.map((info) => ({ info, exiting: false }));
      for (const item of prev) {
        if (!liveIds.has(item.info.id)) {
          if (!timersRef.has(item.info.id)) {
            const timer = setTimeout(() => {
              timersRef.delete(item.info.id);
              setRendered((cur) => cur.filter((x) => x.info.id !== item.info.id));
            }, EXIT_MS);
            timersRef.set(item.info.id, timer);
          }
          next.push({ info: item.info, exiting: true });
        }
      }
      next.sort((a, b) => sessionSeq(a.info.id) - sessionSeq(b.info.id));
      return next;
    });
  }, [sessions]);

  useEffect(() => {
    const timersRef = timers.current;
    return () => {
      for (const timer of timersRef.values()) {
        clearTimeout(timer);
      }
      timersRef.clear();
    };
  }, []);

  return rendered;
}

function SessionDetailsModal({
  info,
  model,
  now,
  onClose,
}: {
  info: MetaSessionInfo;
  model: string | undefined;
  now: number;
  onClose: () => void;
}) {
  const [showHistory, setShowHistory] = useState(true);
  const [openTurn, setOpenTurn] = useState<number | null>(null);
  const [observations, setObservations] = useState<HistoryPoint[]>([]);
  useEffect(() => {
    const at = Date.now();
    setObservations((previous) => [...previous, {
      id: String(at), at, label: `${formatClock(at)} · ${STATE_LABEL[info.state]}`,
      value: info.state === 'idle' ? 1 : 0,
    }].slice(-60));
  }, [info]);
  const totalTokens = info.inputTokens + info.outputTokens;
  // Newest turn first so the most recent work is at the top of the history.
  const history = [...info.history].reverse();
  return (
    <Modal title={`Metasession ${info.id}`} onClose={onClose} size="lg">
      <div className="metasession-detail">
        <div className="metasession-detail-head">
          <span
            className={`metasession-chip-dot metasession-dot-${info.state}`}
          />
          <span className="metasession-detail-state">
            {STATE_LABEL[info.state]}
          </span>
          <span
            className={`metasession-ready-pill metasession-ready-${STATE_READINESS[info.state].ready}`}
          >
            {STATE_READINESS[info.state].pill}
          </span>
        </div>
        <p className="metasession-readiness-note">
          {STATE_READINESS[info.state].note}
        </p>
        <dl className="metasession-detail-grid">
          <dt>Session id</dt>
          <dd>{info.id}</dd>
          <dt>State</dt>
          <dd>{STATE_LABEL[info.state]}</dd>
          <dt>Model</dt>
          <dd>{model ?? 'CLI default'}</dd>
          <dt>Turns served</dt>
          <dd>{info.served}</dd>
          <dt>Tokens used</dt>
          <dd>
            {formatTokens(totalTokens)}
            <span className="metasession-detail-sub">
              {' '}
              ({formatTokens(info.inputTokens)} in ·{' '}
              {formatTokens(info.outputTokens)} out)
            </span>
          </dd>
          <dt>Uptime</dt>
          <dd>{formatDuration(Math.max(0, now - info.startedAt))}</dd>
          <dt>Started</dt>
          <dd>{formatClock(info.startedAt)}</dd>
          <dt>Last active</dt>
          <dd>
            {info.lastActiveAt === null
              ? 'Never leased yet'
              : `${formatClock(info.lastActiveAt)} (${formatDuration(
                  Math.max(0, now - info.lastActiveAt),
                )} ago)`}
          </dd>
        </dl>

        {info.live && (
          <div className="metasession-live">
            <div className="metasession-live-head">
              <span className="metasession-chip-dot metasession-dot-busy" />
              <span className="metasession-live-title">Live conversation</span>
              <span className="metasession-live-work">
                {info.live.label ?? purposeLabel(info.live.purpose)}
              </span>
            </div>
            <div className="metasession-turn-message">
              <span className="metasession-turn-role">IDE → AI · prompt</span>
              <pre className="metasession-turn-text">{info.live.prompt}</pre>
            </div>
            <div className="metasession-turn-message">
              <span className="metasession-turn-role">AI → IDE · response</span>
              {info.live.response.length === 0 ? (
                <p className="metasession-turn-waiting">
                  <Spinner /> Waiting for the assistant to respond…
                </p>
              ) : (
                <pre className="metasession-turn-text">
                  {info.live.response}
                </pre>
              )}
            </div>
          </div>
        )}

        <div className="metasession-history">
          <button
            type="button"
            className="metasession-history-toggle"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((v) => !v)}
          >
            <ChevronIcon size={14} open={showHistory} />
            Usage history
            <span className="metasession-history-count">
              {info.history.length}
            </span>
          </button>
          {showHistory &&
            (history.length === 0 ? (
              <p className="metasession-history-empty">
                No turns served yet. When the IDE leases this warm session,
                each turn appears here — click one to replay the prompt and
                response it exchanged, and its tokens.
              </p>
            ) : (
              <ol className="metasession-history-list">
                {history.map((turn, i) => {
                  const open = openTurn === i;
                  const where = purposeLabel(turn.purpose);
                  const work = turnWork(turn);
                  return (
                    <li key={`${turn.at}-${i}`} className="metasession-history-item">
                      <button
                        type="button"
                        className="metasession-history-row"
                        aria-expanded={open}
                        title="Show what this turn was used for"
                        onClick={() => setOpenTurn((v) => (v === i ? null : i))}
                      >
                        <ChevronIcon size={12} open={open} />
                        <span className="metasession-history-where">{work}</span>
                        <span className="metasession-history-when">
                          {formatClock(turn.at)}
                        </span>
                        <span className="metasession-history-tokens">
                          {formatTokens(turn.inputTokens + turn.outputTokens)} tok
                        </span>
                      </button>
                      {open && (
                        <dl className="metasession-turn-detail">
                          <dt>Work</dt>
                          <dd>{work}</dd>
                          <dt>Where in the IDE</dt>
                          <dd>
                            {where}
                            <span className="metasession-detail-sub">
                              {' '}
                              (purpose <code>{turn.purpose}</code>)
                            </span>
                          </dd>
                          <dt>When</dt>
                          <dd>{formatClock(turn.at)}</dd>
                          <dt>Tokens</dt>
                          <dd>
                            {formatTokens(turn.inputTokens + turn.outputTokens)}
                            <span className="metasession-detail-sub">
                              {' '}
                              ({formatTokens(turn.inputTokens)} in ·{' '}
                              {formatTokens(turn.outputTokens)} out)
                            </span>
                          </dd>
                          {turn.prompt !== undefined && (
                            <>
                              <dt>Prompt</dt>
                              <dd>
                                <pre className="metasession-turn-text">
                                  {turn.prompt}
                                </pre>
                              </dd>
                            </>
                          )}
                          {turn.response !== undefined && (
                            <>
                              <dt>Response</dt>
                              <dd>
                                <pre className="metasession-turn-text">
                                  {turn.response}
                                </pre>
                              </dd>
                            </>
                          )}
                        </dl>
                      )}
                    </li>
                  );
                })}
              </ol>
            ))}
        </div>

        <div className="metasession-detail-charts">
          <HistoryChart title="Session token usage" unit="tokens"
            explain="Provider-reported tokens for retained completed turns in this session, not shared process counts or lifetime billing."
            points={info.history.map((turn, index) => ({
              id: `${turn.at}-${index}`, at: turn.at,
              label: `${formatClock(turn.at)} · ${turnWork(turn)}`,
              value: turn.inputTokens + turn.outputTokens,
            }))} />
          <HistoryChart title="Session availability" unit="ready"
            explain="Live observations while this dialog is open: 1 = ready for a command, 0 = serving a command or warming. Busy is normal, not unhealthy. CPU, memory and failure health are unavailable without session-specific telemetry."
            maxGapMs={15_000} points={observations} />
        </div>
        <p className="metasession-detail-note">Usage and state belong to this session only. Missing charges or health telemetry are not inferred from a shared queue.</p>
      </div>
    </Modal>
  );
}

function InactivePoolStatus({ status, target, loading, failed }: {
  status: MetaPoolsStatus | null;
  target: number;
  loading: boolean;
  failed: boolean;
}) {
  const api = useApi();
  const [selected, setSelected] = useState<ActiveSessionEntry | null>(null);
  const monitor = useActiveSessions(api, selected?.id ?? null);
  const entries = monitor.snapshot?.entries.filter((entry) => entry.kind === 'meta') ?? [];
  const current = entries.find((entry) => entry.id === selected?.id);
  const availability = status?.availability;
  const count = Number.isInteger(target) && target > 0 ? target : 0;
  const state = failed ? 'Live status unavailable' : loading ? 'Loading…'
    : availability?.state === 'starting' ? 'Starting…'
    : availability?.state === 'failed' ? 'Startup failed'
    : availability?.state === 'disabled' ? 'Off'
    : availability?.state === 'unavailable' ? 'On demand' : 'Not running';
  return <div className="metapool-live">
    <div className="metapool-live-head">
      <StatusBadge status={failed || availability?.state === 'failed' ? 'error' : 'pending'} label={state} />
      {availability && <span className="metapool-provider">{providerLabel(availability.providerId)}</span>}
      <span className="metapool-stats">
        <span><strong>{monitor.snapshot ? entries.length : '—'}</strong> active</span>
        <span><strong>{monitor.snapshot ? entries.filter((entry) => entry.state === 'idle').length : '—'}</strong> idle</span>
        <span><strong>{monitor.snapshot ? entries.filter((entry) => entry.state === 'busy' || entry.state === 'running').length : '—'}</strong> busy</span>
        <span><strong>{status && !failed ? 0 : '—'}</strong>/{count} warm</span>
      </span>
    </div>
    <p className="metapool-pending" role="status">
      {failed ? 'Live status could not be read. Retry above; saved settings are unchanged.'
        : loading ? 'Reading live pool status.'
        : availability?.message ?? 'No live warm pool is reported. Saving a target does not start one.'}
    </p>
    {monitor.error && <div role="status"><ErrorText error={monitor.error} /><Button variant="ghost"
      onClick={monitor.refresh}>Retry sessions</Button></div>}
    {entries.length > 0 && <div className="metapool-sessions" role="list" aria-label="Live IDE metasessions">
      {entries.map((entry) => <button key={entry.id} type="button" role="listitem"
        className={`metasession-chip metasession-chip-${entry.state === 'running' ? 'busy' : entry.state}`}
        aria-label={`Metasession ${entry.label}: ${entry.state}. View live details`}
        title={`${entry.sessionId ?? entry.id} · ${entry.provider ?? 'unknown provider'} · ${entry.label} · ${entry.state}`}
        aria-haspopup="dialog" onClick={() => setSelected(entry)}>
        <span className={`metasession-chip-dot metasession-dot-${entry.state === 'running' ? 'busy' : entry.state}`} />
        <span className="metasession-chip-id">{(entry.sessionId ?? entry.id).slice(0, 12)}</span>
      </button>)}
    </div>}
    {count > 0 && <div className="metapool-sessions" role="list" aria-label="Configured warm slots">
      {Array.from({ length: Math.min(count, 32) }, (_, index) => <span key={index}
        role="listitem" className="metasession-chip metasession-chip-ghost"
        aria-label={`Metasession slot ${index + 1}: no live session`}>
        <span className="metasession-chip-dot metasession-dot-ghost" /><span className="metasession-chip-id">s{index + 1}</span>
      </span>)}
      {count > 32 && <span>+{count - 32} configured slots</span>}
    </div>}
    <div className="metapool-legend" role="note"><span className="metapool-legend-hint">
      Click a live session for details. Outlined slots are not running sessions.
    </span></div>
    {selected && <Modal title={`IDE metasession · ${selected.label}`} size="xl" onClose={() => setSelected(null)}>
      <p className="muted">Read-only live activity; opening this view starts no AI work.</p>
      <dl className="active-session-details">
        <dt>Status</dt><dd>{current?.state ?? 'No longer active'}</dd>
        <dt>Provider / model</dt><dd>{selected.provider ?? 'Not reported'} / {selected.model ?? 'Not reported'}</dd>
        <dt>Project</dt><dd>{selected.projectName ?? 'Not associated'}</dd>
        <dt>Feature</dt><dd>{selected.featureName ?? selected.featureId ?? 'Not associated'}</dd>
        <dt>Task</dt><dd>{selected.purpose ?? selected.label}</dd>
      </dl>
      <ErrorText error={monitor.debugError} />
      <ErrorText error={monitor.debug?.error ?? null} />
      {monitor.debugError && <Button onClick={monitor.refresh}>Retry live details</Button>}
      {!monitor.debug && !monitor.debugError && <Loader label="Loading live details" />}
      {monitor.debug && <>
        {monitor.debug.truncated && <p role="status">Showing the retained activity/output tail.</p>}
        <h3>Recent activity</h3>
        {monitor.debug.activity.length ? <ol>{monitor.debug.activity.map((line, index) => <li key={index}>{line}</li>)}</ol>
          : <p>No recorded activity.</p>}
        <h3>Live output</h3>
        <pre className="active-session-output">{monitor.debug.output || 'No output available.'}</pre>
      </>}
    </Modal>}
  </div>;
}

function PoolStatus({
  pool,
  model,
  draftSize,
  onApplySuggestion,
}: {
  pool: MetaPoolStat;
  model: string | undefined;
  draftSize: number;
  onApplySuggestion: (size: number) => void;
}) {
  const rendered = useAnimatedSessions(pool.sessions);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [justApplied, setJustApplied] = useState(false);
  // Resolve the open session's live data each render so its tokens/history keep
  // updating while the modal is open; null once the session is gone.
  const detail =
    detailId === null
      ? null
      : (pool.sessions.find((s) => s.id === detailId) ?? null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Briefly flash the target after a suggestion is applied so the (restart-
  // deferred) change is acknowledged in the live view instead of silently
  // mutating the size input.
  useEffect(() => {
    if (!justApplied) {
      return;
    }
    const timer = setTimeout(() => setJustApplied(false), 900);
    return () => clearTimeout(timer);
  }, [justApplied]);

  const target = Number.isFinite(draftSize) ? draftSize : pool.size;
  const suggestionDiffers =
    Number.isFinite(draftSize) && pool.suggestedSize !== draftSize;
  // The running pool still reflects `pool.size`; `target` is the edited draft.
  // Their difference is the change that will take effect on the next restart.
  const pendingDelta = target - pool.size;
  const hasPending = pendingDelta !== 0;
  const liveCount = rendered.filter((r) => !r.exiting).length;
  const ghostCount = Math.max(
    0,
    (hasPending && pendingDelta > 0 ? target : pool.size) - liveCount,
  );
  const ghostLabel = hasPending
    ? 'Will warm on save'
    : pool.waitingForCapacity
      ? 'Waiting for shared process capacity'
      : 'Warming';
  // Live convergence (a *saved* change the pool is still applying), as opposed
  // to `hasPending` (an *unsaved* edit). The pool's own target is `pool.size`;
  // it keeps moving toward it while sessions are still warming (growing) or a
  // surplus session is finishing its turn before it retires (shrinking). This
  // is what keeps the UI honest after save: the number isn't reverted, the pool
  // is visibly climbing/dropping toward it.
  const warmingCount = pool.sessions.filter(
    (s) => s.state === 'warming',
  ).length;
  const retiringCount = Math.max(0, pool.live - pool.size);
  const readyCount = Math.max(0, pool.live - warmingCount);
  const growing = warmingCount > 0;
  const converging = !hasPending && (growing || retiringCount > 0);

  function handleApply() {
    setJustApplied(true);
    onApplySuggestion(pool.suggestedSize);
  }

  return (
    <div className="metapool-live">
      <div
        className={`metapool-live-head${justApplied ? ' metapool-live-applied' : ''}`}
      >
        <StatusBadge
          status={pool.ready ? 'ready' : 'starting'}
          label={pool.ready ? 'Ready' : 'Warming…'}
        />
        <span className="metapool-stats">
          <span>
            <strong>{pool.idle}</strong> idle
          </span>
          <span>
            <strong>{pool.busy}</strong> busy
          </span>
          <span>
            <strong>{pool.live}</strong>/{pool.size} warm
          </span>
          <span title="Warm turns served by this pool since it started">
            <strong>{pool.served}</strong> served
          </span>
        </span>
        {hasPending && (
          <span
            className={`metapool-target metapool-target-${
              pendingDelta > 0 ? 'grow' : 'shrink'
            }${justApplied ? ' is-pulse' : ''}`}
            title="Pending target — save to apply live"
          >
            → target <strong>{target}</strong>
          </span>
        )}
        {converging && (
          <span
            className={`metapool-converge metapool-converge-${
              growing ? 'grow' : 'shrink'
            }`}
            title={
              growing
                ? 'Warming new sessions up to the saved target'
                : 'Retiring surplus sessions down to the saved target'
            }
          >
            <span className="metapool-converge-dot" />
            {growing ? 'increasing' : 'decreasing'} →{' '}
            <strong>{pool.size}</strong>
          </span>
        )}
      </div>

      {!hasPending && pool.waitingForCapacity && (
        <p className="metapool-pending" role="status" aria-live="polite">
          Waiting for shared process capacity — <strong>{readyCount}</strong> of{' '}
          <strong>{pool.size}</strong> ready, <strong>{warmingCount}</strong> warming.
          The saved target has not reverted. Lower the metasession count or
          adjust the processAdmission limits and restart.
        </p>
      )}

      <span
        className="metapool-suggest"
        title="Suggested warm size from observed peak concurrency in the recent telemetry window"
      >
        Suggested <strong>{pool.suggestedSize}</strong>
        {suggestionDiffers && (
          <button
            type="button"
            className="metapool-suggest-apply"
            onClick={handleApply}
          >
            Apply
          </button>
        )}
      </span>

      {(rendered.length > 0 || ghostCount > 0) && (
        <div className="metapool-sessions" role="list">
          {rendered.map(({ info, exiting }) => {
            const surplus =
              hasPending &&
              pendingDelta < 0 &&
              !exiting &&
              sessionSeq(info.id) > target;
            return (
              <button
                type="button"
                role="listitem"
                key={info.id}
                className={`metasession-chip metasession-chip-${info.state}${
                  exiting ? ' metasession-chip-exit' : ''
                }${surplus ? ' metasession-chip-surplus' : ''}`}
                aria-label={`Metasession ${info.id}: ${STATE_LABEL[info.state]}, ${info.served} turns. View details`}
                aria-haspopup="dialog"
                aria-expanded={detailId === info.id}
                title={`${info.id} · ${STATE_LABEL[info.state]} · ${info.served} served${
                  surplus ? ' · retires on save' : ''
                }`}
                onClick={() => !exiting && setDetailId(info.id)}
              >
                <span
                  className={`metasession-chip-dot metasession-dot-${info.state}`}
                />
                <span className="metasession-chip-id">{info.id}</span>
                <span className="metasession-chip-served">{info.served}</span>
              </button>
            );
          })}
          {Array.from({ length: ghostCount }, (_, i) => (
            <span
              key={`ghost-${i}`}
              className="metasession-chip metasession-chip-ghost"
              role="listitem"
              title={ghostLabel}
              aria-label={`Metasession slot ${liveCount + i + 1}: ${ghostLabel}`}
            >
              <span className="metasession-chip-dot metasession-dot-ghost" />
              <span className="metasession-chip-id">
                {hasPending ? '+1' : `s${liveCount + i + 1}`}
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="metapool-legend" role="note">
        <span>
          <i className="metasession-chip-dot metasession-dot-idle" /> idle
        </span>
        <span>
          <i className="metasession-chip-dot metasession-dot-busy" /> busy
        </span>
        <span>
          <i className="metasession-chip-dot metasession-dot-warming" /> warming
        </span>
        <span className="metapool-legend-hint">
          Click a session for live details
        </span>
      </div>

      {hasPending && (
        <p className="metapool-pending" role="status">
          {pendingDelta > 0 ? (
            <>
              Pool will grow by <strong>+{pendingDelta}</strong> to{' '}
              <strong>{target}</strong> warm sessions — save to apply live; the
              new sessions warm in the background.
            </>
          ) : (
            <>
              Pool will shrink by <strong>{pendingDelta}</strong> to{' '}
              <strong>{target}</strong> warm sessions — save to apply live; the
              highlighted sessions retire (busy ones finish first).
            </>
          )}
        </p>
      )}

      {converging && (
        <p
          className={`metapool-transition metapool-transition-${
            growing ? 'grow' : 'shrink'
          }`}
          role="status"
          aria-live="polite"
        >
          {growing ? (
            <>
              Metasessions increasing to <strong>{pool.size}</strong> —{' '}
              <strong>{readyCount}</strong> of <strong>{pool.size}</strong>{' '}
              ready, <strong>{warmingCount}</strong> warming…
            </>
          ) : (
            <>
              Metasessions decreasing to <strong>{pool.size}</strong> —{' '}
              <strong>{pool.live}</strong> still live,{' '}
              <strong>{retiringCount}</strong> finishing before they retire…
            </>
          )}
        </p>
      )}

      {detail && (
        <SessionDetailsModal
          info={detail}
          model={model}
          now={now}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  );
}

/**
 * Settings ▸ "Metasession pools" — configure and monitor the warm
 * `copilot --acp` sessions the IDE keeps ready so AI responses (PR review,
 * review board, summaries, monitors, …) skip the cold CLI spawn. Size, purposes
 * and the on/off switch are editable here and persist as `meta.warmPool`
 * overrides; size changes also apply live on save, and live warm capacity is
 * shown per pool.
 */
/** Human label for a model's coarse price bucket. */
const PRICE_LABEL: Record<string, string> = {
  low: 'Low cost',
  medium: 'Medium cost',
  high: 'High cost',
};

/**
 * Picker for the AI model powering the IDE's metasessions (summaries, PR
 * review, repo context, monitors, …). The list is the live catalog the
 * Agency/Copilot CLI advertises, annotated with each model's premium-request
 * multiplier and price bucket so the cost of a choice is visible before it is
 * applied. A change takes effect for all *new* metasessions immediately.
 */
function MetaModelPicker(): JSX.Element {
  const api = useApi();
  const signedIn = useMicrosoftSignedIn();
  const [settings, setSettings] = useState<MetaSettings | null>(null);
  const [models, setModels] = useState<MetaModelOption[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerModels, setProviderModels] = useState<ModelInfo[]>([]);
  const [draftProvider, setDraftProvider] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setSettingsError(false);
    void api
      .getMetaSettings()
      .then((value) => {
        if (!alive) return;
        setSettings(value);
        setDraftModel(value.model);
        setDraftProvider(value.providerId ?? '');
      })
      .catch(() => {
        // Don't swallow into a permanent spinner: surface a retryable error so
        // a transient hiccup (slow/hung backend) can be recovered by the user.
        if (alive) setSettingsError(true);
      });
    // The installed providers power the provider selector; Agency only appears
    // once a Microsoft identity is signed in, so this is re-read when `signedIn`
    // flips (see the dependency list).
    void Promise.resolve(api.listProviders?.())
      .then((list) => {
        if (alive) setProviders(list ? installedProviders(list) : []);
      })
      .catch(() => {
        if (alive) setProviders([]);
      });
    // The catalog is sourced from Agency over ACP; the very first request after
    // launch spawns the CLI and can briefly return an empty list while it warms
    // up. Poll with backoff until a populated catalog arrives so the picker
    // fills in on its own instead of getting stuck on the fallback model.
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (): void => {
      void api
        .getMetaModels()
        .then((list) => {
          if (!alive) return;
          if (list.length > 0) {
            setModels(list);
            return;
          }
          if (attempt < 8) {
            attempt += 1;
            timer = setTimeout(load, 2000);
          }
        })
        .catch(() => {
          if (alive && attempt < 8) {
            attempt += 1;
            timer = setTimeout(load, 2000);
          }
        });
    };
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, reloadKey, signedIn]);

  // Per-provider model list, loaded only when the draft provider differs from
  // the saved one (whose richer, cost-annotated catalog comes from getMetaModels
  // below). Tolerates a backend that can't list a provider's models.
  function loadProviderModels(providerId: string): void {
    void Promise.resolve(api.listModels?.(providerId))
      .then((list) => setProviderModels(list ?? []))
      .catch(() => setProviderModels([]));
  }

  function onProviderChange(providerId: string): void {
    setDraftProvider(providerId);
    setDraftModel('auto');
    setProviderModels([]);
    setSaved(false);
    if (settings && providerId !== settings.providerId) {
      loadProviderModels(providerId);
    }
  }

  // The current provider's cost-annotated catalog applies only while the draft
  // provider matches the saved one; after switching provider, fall back to that
  // provider's plain model list.
  const useCatalog =
    settings !== null &&
    (draftProvider === '' || draftProvider === settings.providerId);

  // Always keep the current selection choosable even if the live catalog omits
  // it (custom or legacy id): fall back to a synthetic option.
  const options = useMemo<MetaModelOption[]>(() => {
    const base: MetaModelOption[] = useCatalog
      ? models
      : [
          {
            id: 'auto',
            name: 'Auto',
            description: '',
            usageMultiplier: null,
            usageLabel: null,
            priceCategory: null,
            enabled: true,
          },
          ...providerModels
            .filter((m) => m.id !== 'auto')
            .map((m) => ({
              id: m.id,
              name: m.label,
              description: '',
              usageMultiplier: null,
              usageLabel: null,
              priceCategory: null,
              enabled: true,
            })),
        ];
    if (draftModel === '' || base.some((m) => m.id === draftModel)) {
      return base;
    }
    return [
      {
        id: draftModel,
        name: draftModel,
        description: '',
        usageMultiplier: null,
        usageLabel: null,
        priceCategory: null,
        enabled: true,
      },
      ...base,
    ];
  }, [models, providerModels, useCatalog, draftModel]);

  const selected = options.find((m) => m.id === draftModel) ?? null;
  const dirty =
    settings !== null &&
    (draftModel !== settings.model || draftProvider !== settings.providerId);

  async function apply(): Promise<void> {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.updateMetaSettings({
        providerId: draftProvider || settings.providerId,
        model: draftModel,
      });
      setSettings(next);
      setDraftModel(next.model);
      setDraftProvider(next.providerId);
      setSaved(true);
    } catch {
      setError('Could not update the AI model. Try again.');
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    if (settingsError) {
      return (
        <div className="metamodel-picker metamodel-picker-error">
          <ErrorText error="Could not load the metasession model settings. The backend may be busy." />
          <Button
            variant="secondary"
            onClick={() => setReloadKey((n) => n + 1)}
          >
            Retry
          </Button>
        </div>
      );
    }
    return <Loader label="Loading model settings" />;
  }

  return (
    <div className="metamodel-picker">
      <div className="metamodel-head">
        <h3 className="metamodel-title">Metasession model</h3>
        <p className="metamodel-subtitle">
          The AI model powering the IDE's metasessions — summaries, PR review,
          repo context, review board and monitors. Applies to new metasessions
          immediately. Suggestions come from Agency with each model's
          premium-request cost.
        </p>
      </div>
      <div className="metamodel-row">
        <label className="metamodel-field">
          <span className="metapool-field-label">Provider</span>
          <select
            className="input"
            value={draftProvider}
            disabled={saving}
            onChange={(e) => onProviderChange(e.target.value)}
          >
            {providers.length === 0 && (
              <option value={draftProvider}>
                {providerLabel(draftProvider)}
              </option>
            )}
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {providerLabel(provider.id)}
              </option>
            ))}
          </select>
        </label>
        <label className="metamodel-field">
          <span className="metapool-field-label">Model</span>
          <select
            className="input"
            value={draftModel}
            disabled={saving}
            onChange={(e) => {
              setDraftModel(e.target.value);
              setSaved(false);
            }}
          >
            {options.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
                {model.usageLabel ? ` · ${model.usageLabel}` : ''}
                {model.priceCategory ? ` · ${model.priceCategory}` : ''}
                {model.enabled ? '' : ' · unavailable'}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => void apply()} disabled={saving || !dirty}>
          {saving ? (
            <>
              <Spinner size={13} label="Applying" /> Applying…
            </>
          ) : (
            'Apply model'
          )}
        </Button>
      </div>

      {selected && (
        <div className="metamodel-details">
          {selected.description && selected.description !== selected.name && (
            <p className="metamodel-desc">{selected.description}</p>
          )}
          <div className="metamodel-meta">
            {selected.usageMultiplier !== null && (
              <span className="metamodel-badge">
                {selected.usageLabel} premium requests
              </span>
            )}
            {selected.priceCategory && (
              <span
                className={`metamodel-badge metamodel-badge-${selected.priceCategory}`}
              >
                {PRICE_LABEL[selected.priceCategory] ?? selected.priceCategory}
              </span>
            )}
            {selected.usageMultiplier === null &&
              !selected.priceCategory &&
              selected.id === 'auto' && (
                <span className="metamodel-badge">
                  Agency picks the best model per turn
                </span>
              )}
            {!selected.enabled && (
              <span className="metamodel-badge metamodel-badge-warn">
                Not available on your plan
              </span>
            )}
          </div>
        </div>
      )}

      {settings.warmPoolEnabled && draftModel !== 'auto' && (
        <p className="metamodel-note">
          Warm pools run the CLI default model, so a specific model routes new
          metasessions to the (slightly slower) cold path where the choice is
          honored.
        </p>
      )}
      {error && <ErrorText error={error} />}
      {saved && !dirty && (
        <span className="metamodel-saved">Saved — applied to new metasessions.</span>
      )}
    </div>
  );
}

export function MetasessionPoolsSection({ embedded }: { embedded?: boolean } = {}) {
  const api = useApi();
  const status = useAsync(() => api.getMetaPools(), []);
  const config = useAsync(() => api.getConfig(), []);

  const savedWarmPool = useMemo<WarmPoolConfig | null>(() => {
    const meta = config.data?.current.meta;
    if (!meta) return null;
    // What is stored wins over what the backend booted with; otherwise a saved
    // edit appears to revert as soon as the form reloads.
    return readSavedWarmPool(
      meta.warmPool,
      // Optional: a backend predating this field must not blank the page.
      config.data?.overrides?.meta?.warmPool ?? null,
    );
  }, [config.data]);

  const [enabled, setEnabled] = useState(false);
  const [size, setSize] = useState('5');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [appliedLive, setAppliedLive] = useState(false);

  useEffect(() => {
    if (savedWarmPool) {
      setEnabled(savedWarmPool.enabled);
      setSize(String(savedWarmPool.size));
      setError(null);
    }
  }, [savedWarmPool]);

  // Poll faster while the pool is still converging on a saved size change or a
  // session is actively serving a turn, so the chips, counts and the live
  // conversation of a busy session update smoothly instead of stepping every
  // few seconds; fall back to the calm cadence once settled and idle.
  const live = status.data?.pool;
  const converging = status.data?.availability?.state === 'starting' || Boolean(
    live &&
      (live.live > live.size ||
        live.sessions.some((s) => s.state === 'warming' || s.state === 'busy')),
  );

  useEffect(() => {
    const intervalMs = converging ? CONVERGING_POLL_MS : POLL_MS;
    const timer = setInterval(status.reload, intervalMs);
    return () => clearInterval(timer);
  }, [status.reload, converging]);

  async function save() {
    setError(null);
    setSaved(false);
    const next = Number(size);
    if (!Number.isInteger(next) || next < 1) {
      setError('The pool needs a whole size of at least 1.');
      return;
    }
    setBusy(true);
    try {
      // `pools` is a legacy key from when warm capacity was split across
      // several purpose pools. Drop it so a stale override is not written back
      // on every save; the backend ignores it, but keeping it would leave
      // confusing dead state in the stored config.
      const { pools: _legacyPools, ...rest } = (savedWarmPool ?? {}) as
        Partial<WarmPoolConfig> & { pools?: unknown };
      await api.updateConfig('meta', {
        warmPool: { ...rest, enabled, size: next },
      });
      // Apply the size live so it takes effect immediately (with the chip
      // animations) instead of forcing a restart. This only works once the warm
      // pool is already running — turning it on or off still needs a restart,
      // so that case is left to the persisted config.
      if (enabled && status.data?.enabled === true) {
        try {
          await api.resizeMetaPool(next);
        } catch {
          status.reload();
          setError(
            'Configuration saved, but resizing the running pool failed. Your requested size is retained. Click Save changes to retry.',
          );
          return;
        }
        status.reload();
      }
      // A restart is only needed to turn the warm pool on or off; the size
      // already applied live above.
      setAppliedLive(enabled && status.data?.enabled === true);
      setNeedsRestart(status.data?.availability?.state !== 'unavailable' &&
        (savedWarmPool?.enabled !== enabled || (enabled && status.data?.enabled !== true)));
      setSaved(true);
      config.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const bridge = desktopBridge();
  const restart = async () => {
    try {
      if (await bridge?.relaunch?.() !== true) {
        throw new Error('Restart was not confirmed');
      }
    } catch {
      setError('Restart not confirmed. Wait for active work to finish, then try again.');
    }
  };
  const loading = config.loading && !config.data;

  const body = (
    <>
      {embedded && (
        <p className="page-subtitle">
          Warm AI sessions kept ready for IDE requests. Resize live on save;
          availability follows the selected CLI.
        </p>
      )}

      {loading && <Loader label="Loading pool configuration" />}
      {config.error && (
        <ErrorState
          error={config.cause ?? config.error}
          onRetry={config.reload}
        />
      )}
      {status.error && (
        <ErrorState
          error={status.cause ?? status.error}
          onRetry={status.reload}
        />
      )}

      {config.data && !savedWarmPool && (
        <EmptyState message="Warm pool configuration is unavailable." />
      )}

      {status.data?.processAdmission && (
        <p className="metapool-pending" role="status">
          Headless process budget: {status.data.processAdmission.processes}/{status.data.processAdmission.maxProcesses} processes,
          {' '}{status.data.processAdmission.warmProcesses}/{status.data.processAdmission.maxWarmProcesses} warm;
          {' '}queue {status.data.processAdmission.queued}/{status.data.processAdmission.maxQueued}.
          {' '}Interactive terminals and child processes are not included.
          {status.data.processAdmission.closed && ' Process admission is closed.'}
        </p>
      )}

      {savedWarmPool && (
        <div className="metapool-editor">
          <label className="metapool-enable">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setSaved(false);
              }}
            />
            <span>Keep metasessions warm</span>
          </label>
          {status.data?.availability?.state === 'unavailable' && <p className="page-subtitle">
            The warm target is retained for compatible providers; this CLI stays unchanged.
          </p>}

          <div className="metapool-rows">
            <div className="metapool-row">
              <div className="metapool-row-fields">
                <label className="metapool-field metapool-field-size">
                  <span className="metapool-field-label">
                    Parallel metasessions
                  </span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={size}
                    disabled={busy}
                    onChange={(e) => {
                      setSize(e.target.value);
                      setSaved(false);
                    }}
                  />
                </label>
              </div>
              {live ? (
                  <PoolStatus
                    pool={live}
                    model={status.data?.model}
                    draftSize={Number(size)}
                    onApplySuggestion={(next) => {
                      setSize(String(next));
                      setSaved(false);
                    }}
                  />
                ) : (
                  <InactivePoolStatus status={status.data} target={Number(size)}
                    loading={status.loading && !status.data} failed={Boolean(status.error)} />
                )}
            </div>
          </div>

          <ErrorText error={error} />

          <div className="metapool-actions">
            <Button onClick={save} disabled={busy}>
              {busy ? (
                <>
                  <Spinner size={13} label="Saving" /> Saving…
                </>
              ) : (
                'Save changes'
              )}
            </Button>
            {saved && (
              <span className="metapool-saved">
                {needsRestart ? (
                  <>
                    Saved — restart to apply.
                    {bridge && (
                      <Button
                        variant="ghost"
                        onClick={restart}
                      >
                        Restart now
                      </Button>
                    )}
                  </>
                ) : (
                  appliedLive ? 'Saved — applied live.' : 'Saved — settings retained.'
                )}
              </span>
            )}
          </div>
        </div>
      )}

      <details className="metapool-model-settings">
        <summary>Provider and model</summary>
        <MetaModelPicker />
      </details>
    </>
  );

  if (embedded) {
    return body;
  }

  return (
    <Card>
      <div className="page-header">
        <div className="page-header-main">
          <IconBadge icon={<ActivityIcon size={22} />} tone="accent" />
          <div>
            <h2 className="page-title">Metasessions</h2>
            <p className="page-subtitle">
              Warm AI sessions kept ready for IDE requests. Resize live on save;
              availability follows the selected CLI.
            </p>
          </div>
        </div>
      </div>
      {body}
    </Card>
  );
}
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  IconBadge,
  Modal,
} from '../../components/ui.js';
import {
  ActivityIcon,
  ChevronIcon,
  InfoIcon,
  PlusIcon,
  TrashIcon,
} from '../../components/icons.js';
import { Loader, Spinner } from '../../components/loading.js';
import { ErrorState } from '../../components/error-state.js';
import type {
  ConfigValue,
  MetaPoolStat,
  MetaSessionInfo,
  MetaSessionState,
} from '../../lib/types.js';

/** How often the live warm-pool status is refreshed while the page is open. */
const POLL_MS = 4000;

/** Faster status cadence while a pool is actively growing or shrinking. */
const CONVERGING_POLL_MS = 1000;

/** Milliseconds an exiting session chip lingers so its removal animates. */
const EXIT_MS = 320;

/**
 * Purposes the IDE routes metasession work to. `general` is the required
 * fallback for any request without a dedicated pool; the others are workflow
 * routing keys used across the app. Surfaced so users don't have to guess what
 * to type when adding a pool.
 */
const KNOWN_PURPOSES: Array<{ purpose: string; label: string; hint: string }> = [
  {
    purpose: 'general',
    label: 'General',
    hint: 'Fallback for every AI turn without a dedicated pool — PR review, summaries, repo context, review board, monitors.',
  },
  {
    purpose: 'self-recovery',
    label: 'Self-recovery',
    hint: 'Read-only diagnosis turns that analyze a stuck session and suggest a fix.',
  },
];

interface PoolDraft {
  purpose: string;
  size: string;
}

interface WarmPoolConfig {
  enabled: boolean;
  pools: Array<{ purpose: string; size: number }>;
  [key: string]: ConfigValue;
}

interface DesktopBridge {
  relaunch(): void;
}

function desktopBridge(): DesktopBridge | undefined {
  return (window as unknown as { desktop?: DesktopBridge }).desktop;
}

function readWarmPool(value: ConfigValue): WarmPoolConfig | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const wp = value as Record<string, unknown>;
  if (typeof wp.enabled !== 'boolean' || !Array.isArray(wp.pools)) {
    return null;
  }
  return wp as unknown as WarmPoolConfig;
}

const STATE_LABEL: Record<MetaSessionState, string> = {
  warming: 'Warming',
  idle: 'Idle',
  busy: 'Busy',
};

function sessionSeq(id: string): number {
  const n = Number.parseInt(id.replace(/^\D+/, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return '0s';
  }
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) {
    parts.push(`${h}h`);
  }
  if (h > 0 || m > 0) {
    parts.push(`${m}m`);
  }
  parts.push(`${s}s`);
  return parts.join(' ');
}

function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString();
}

/** Formats a token count compactly (e.g. 1234 → "1,234", 0 → "0"). */
function formatTokens(n: number): string {
  return n.toLocaleString();
}

/** Human label for a routing purpose (the "where in the IDE" of a turn). */
function purposeLabel(purpose: string): string {
  const known = KNOWN_PURPOSES.find((p) => p.purpose === purpose);
  return known ? known.label : purpose;
}

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
  const totalTokens = info.inputTokens + info.outputTokens;
  // Newest turn first so the most recent work is at the top of the history.
  const history = [...info.history].reverse();
  return (
    <Modal title={`Metasession ${info.id}`} onClose={onClose}>
      <div className="metasession-detail">
        <div className="metasession-detail-head">
          <span
            className={`metasession-chip-dot metasession-dot-${info.state}`}
          />
          <span className="metasession-detail-state">
            {STATE_LABEL[info.state]}
          </span>
        </div>
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
                each turn appears here with where it was used and its tokens.
              </p>
            ) : (
              <ol className="metasession-history-list">
                {history.map((turn, i) => (
                  <li key={`${turn.at}-${i}`} className="metasession-history-row">
                    <span className="metasession-history-where">
                      {purposeLabel(turn.purpose)}
                    </span>
                    <span className="metasession-history-when">
                      {formatClock(turn.at)}
                    </span>
                    <span className="metasession-history-tokens">
                      {formatTokens(turn.inputTokens + turn.outputTokens)} tok
                    </span>
                  </li>
                ))}
              </ol>
            ))}
        </div>

        <p className="metasession-detail-note">
          A climbing “turns served” and real token counts are live evidence this
          warm session is handling IDE AI requests instead of a cold CLI spawn.
          Warm ACP turns report tokens; per-turn AIC is only attributed on the
          cold path.
        </p>
      </div>
    </Modal>
  );
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
  const ghostCount =
    hasPending && pendingDelta > 0 ? Math.max(0, target - liveCount) : 0;
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
        <span
          className={`metapool-badge ${
            pool.ready ? 'metapool-badge-ready' : 'metapool-badge-warming'
          }`}
        >
          {pool.ready ? 'Ready' : 'Warming…'}
        </span>
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
      </div>

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
              title="Will warm on save"
            >
              <span className="metasession-chip-dot metasession-dot-ghost" />
              <span className="metasession-chip-id">+1</span>
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
export function MetasessionPoolsSection() {
  const api = useApi();
  const status = useAsync(() => api.getMetaPools(), []);
  const config = useAsync(() => api.getConfig(), []);

  const savedWarmPool = useMemo<WarmPoolConfig | null>(() => {
    const meta = config.data?.current.meta;
    return meta ? readWarmPool(meta.warmPool) : null;
  }, [config.data]);

  const [enabled, setEnabled] = useState(false);
  const [pools, setPools] = useState<PoolDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showPurposes, setShowPurposes] = useState(false);

  useEffect(() => {
    if (savedWarmPool) {
      setEnabled(savedWarmPool.enabled);
      setPools(
        savedWarmPool.pools.map((p) => ({
          purpose: p.purpose,
          size: String(p.size),
        })),
      );
      setError(null);
      setSaved(false);
    }
  }, [savedWarmPool]);

  // Poll faster while any pool is still converging on a saved size change, so
  // the chips and counts update live (warming → idle, surplus retiring) instead
  // of stepping every few seconds; fall back to the calm cadence once settled.
  const anyConverging = useMemo(
    () =>
      (status.data?.pools ?? []).some(
        (p) => p.sessions.some((s) => s.state === 'warming') || p.live > p.size,
      ),
    [status.data],
  );

  useEffect(() => {
    const intervalMs = anyConverging ? CONVERGING_POLL_MS : POLL_MS;
    const timer = setInterval(status.reload, intervalMs);
    return () => clearInterval(timer);
  }, [status.reload, anyConverging]);

  const statusByPurpose = useMemo(() => {
    const map = new Map<string, MetaPoolStat>();
    for (const pool of status.data?.pools ?? []) {
      map.set(pool.purpose, pool);
    }
    return map;
  }, [status.data]);

  const usedPurposes = useMemo(
    () => new Set(pools.map((p) => p.purpose.trim())),
    [pools],
  );

  function setPool(index: number, patch: Partial<PoolDraft>) {
    setPools((current) =>
      current.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    );
    setSaved(false);
  }

  function addPool(purpose = '') {
    setPools((current) => [...current, { purpose, size: '5' }]);
    setSaved(false);
  }

  function removePool(index: number) {
    setPools((current) => current.filter((_, i) => i !== index));
    setSaved(false);
  }

  function validate(): Array<{ purpose: string; size: number }> | string {
    const seen = new Set<string>();
    const out: Array<{ purpose: string; size: number }> = [];
    for (const pool of pools) {
      const purpose = pool.purpose.trim();
      if (!purpose) {
        return 'Every pool needs a purpose.';
      }
      if (seen.has(purpose)) {
        return `Duplicate pool purpose: ${purpose}.`;
      }
      seen.add(purpose);
      const size = Number(pool.size);
      if (!Number.isInteger(size) || size < 1) {
        return `Pool "${purpose}" needs a whole size of at least 1.`;
      }
      out.push({ purpose, size });
    }
    if (!seen.has('general')) {
      return "A pool with purpose 'general' is required.";
    }
    return out;
  }

  async function save() {
    setError(null);
    const result = validate();
    if (typeof result === 'string') {
      setError(result);
      return;
    }
    setBusy(true);
    try {
      await api.updateConfig('meta', {
        warmPool: { ...savedWarmPool, enabled, pools: result },
      });
      // Apply size changes live so pools grow/shrink immediately (with the
      // chip animations) instead of forcing a restart. Only pools that are
      // already running can be resized; adding, removing or toggling a pool
      // still needs a restart, so those are left to the persisted config.
      if (enabled) {
        const running = new Set(
          (status.data?.pools ?? []).map((p) => p.purpose),
        );
        await Promise.all(
          result
            .filter((pool) => running.has(pool.purpose))
            .map((pool) =>
              api.resizeMetaPool(pool.purpose, pool.size).catch(() => undefined),
            ),
        );
        status.reload();
      }
      setSaved(true);
      config.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const bridge = desktopBridge();
  const loading = config.loading && !config.data;
  const suggestablePurposes = KNOWN_PURPOSES.filter(
    (p) => !usedPurposes.has(p.purpose),
  );

  return (
    <Card>
      <div className="page-header">
        <div className="page-header-main">
          <IconBadge icon={<ActivityIcon size={22} />} tone="accent" />
          <div>
            <h2 className="page-title">Metasession pools</h2>
            <p className="page-subtitle">
              Warm AI sessions kept ready so the IDE responds instantly instead
              of spawning a CLI per request. Each pool bounds how many turns run
              in parallel; extra requests reuse the next free session or fall
              back to a cold spawn. Size changes apply live on save; adding,
              removing or toggling a pool needs a restart.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="metapool-help-toggle"
          onClick={() => setShowPurposes((v) => !v)}
        >
          <InfoIcon size={14} /> What is a purpose?
        </button>
      </div>

      {showPurposes && (
        <div className="metapool-help">
          <p className="metapool-help-lead">
            A <strong>purpose</strong> is a routing key. Every AI turn the IDE
            runs carries a purpose; it leases a warm session from the pool with
            the matching purpose, or the required <code>general</code> pool if
            none matches. Dedicate a pool to a workflow to give it its own warm
            capacity.
          </p>
          <ul className="metapool-help-list">
            {KNOWN_PURPOSES.map((p) => (
              <li key={p.purpose}>
                <code>{p.purpose}</code>
                <span>{p.hint}</span>
                {!usedPurposes.has(p.purpose) && (
                  <button
                    type="button"
                    className="metapool-help-add"
                    disabled={busy}
                    onClick={() => addPool(p.purpose)}
                  >
                    <PlusIcon size={12} /> Add
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading && <Loader label="Loading pool configuration" />}
      {config.error && (
        <ErrorState
          error={config.cause ?? config.error}
          onRetry={config.reload}
        />
      )}

      {config.data && !savedWarmPool && (
        <EmptyState message="Warm pool configuration is unavailable." />
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

          <div className="metapool-rows">
            {pools.map((pool, index) => {
              const live = statusByPurpose.get(pool.purpose.trim());
              return (
                <div className="metapool-row" key={index}>
                  <div className="metapool-row-fields">
                    <label className="metapool-field">
                      <span className="metapool-field-label">Purpose</span>
                      <input
                        className="input"
                        value={pool.purpose}
                        disabled={busy}
                        placeholder="general"
                        onChange={(e) =>
                          setPool(index, { purpose: e.target.value })
                        }
                      />
                    </label>
                    <label className="metapool-field metapool-field-size">
                      <span className="metapool-field-label">
                        Parallel sessions
                      </span>
                      <input
                        className="input"
                        type="number"
                        min={1}
                        value={pool.size}
                        disabled={busy}
                        onChange={(e) =>
                          setPool(index, { size: e.target.value })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="metapool-remove"
                      title="Remove pool"
                      disabled={busy || pool.purpose.trim() === 'general'}
                      onClick={() => removePool(index)}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                  {enabled &&
                    (live ? (
                      <PoolStatus
                        pool={live}
                        model={status.data?.model}
                        draftSize={Number(pool.size)}
                        onApplySuggestion={(size) =>
                          setPool(index, { size: String(size) })
                        }
                      />
                    ) : (
                      <div className="metapool-live">
                        <span className="metapool-badge metapool-badge-warming">
                          {saved ? 'Restart to start' : 'Not running'}
                        </span>
                      </div>
                    ))}
                </div>
              );
            })}
          </div>

          <div className="metapool-add-row">
            <Button variant="ghost" onClick={() => addPool()} disabled={busy}>
              <PlusIcon size={13} /> Add pool
            </Button>
            {suggestablePurposes.map((p) => (
              <button
                key={p.purpose}
                type="button"
                className="metapool-purpose-chip"
                disabled={busy}
                title={p.hint}
                onClick={() => addPool(p.purpose)}
              >
                <PlusIcon size={11} /> {p.purpose}
              </button>
            ))}
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
                Saved — restart to apply.
                {bridge && (
                  <Button variant="ghost" onClick={() => bridge.relaunch()}>
                    Restart now
                  </Button>
                )}
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

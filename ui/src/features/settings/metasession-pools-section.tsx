import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  IconBadge,
} from '../../components/ui.js';
import { ActivityIcon, PlusIcon, TrashIcon } from '../../components/icons.js';
import { Loader, Spinner } from '../../components/loading.js';
import { ErrorState } from '../../components/error-state.js';
import type { ConfigValue, MetaPoolStat } from '../../lib/types.js';

/** How often the live warm-pool status is refreshed while the page is open. */
const POLL_MS = 4000;

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

function PoolStatus({ pool }: { pool: MetaPoolStat }) {
  return (
    <div className="metapool-live">
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
      </span>
    </div>
  );
}

/**
 * Settings ▸ "Metasession pools" — configure and monitor the warm
 * `copilot --acp` sessions the IDE keeps ready so AI responses (PR review,
 * review board, summaries, monitors, …) skip the cold CLI spawn. Size, purposes
 * and the on/off switch are editable here and persist as `meta.warmPool`
 * overrides that apply after a restart; live warm capacity is shown per pool.
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

  useEffect(() => {
    const timer = setInterval(status.reload, POLL_MS);
    return () => clearInterval(timer);
  }, [status.reload]);

  const statusByPurpose = useMemo(() => {
    const map = new Map<string, MetaPoolStat>();
    for (const pool of status.data?.pools ?? []) {
      map.set(pool.purpose, pool);
    }
    return map;
  }, [status.data]);

  function setPool(index: number, patch: Partial<PoolDraft>) {
    setPools((current) =>
      current.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    );
    setSaved(false);
  }

  function addPool() {
    setPools((current) => [...current, { purpose: '', size: '5' }]);
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
              back to a cold spawn. Changes apply after a restart.
            </p>
          </div>
        </div>
      </div>

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
                      <PoolStatus pool={live} />
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

          <Button variant="ghost" onClick={addPool} disabled={busy}>
            <PlusIcon size={13} /> Add pool
          </Button>

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

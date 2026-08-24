import { useEffect } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { Card, EmptyState, IconBadge } from '../../components/ui.js';
import { ActivityIcon } from '../../components/icons.js';
import { Loader } from '../../components/loading.js';
import { ErrorState } from '../../components/error-state.js';
import type { MetaPoolStat } from '../../lib/types.js';

/** How often the live warm-pool status is refreshed while the page is open. */
const POLL_MS = 4000;

function PoolRow({ pool }: { pool: MetaPoolStat }) {
  return (
    <li className="metapool-item">
      <div className="metapool-item-head">
        <span className="metapool-purpose">{pool.purpose}</span>
        <span
          className={`metapool-badge ${
            pool.ready ? 'metapool-badge-ready' : 'metapool-badge-warming'
          }`}
        >
          {pool.ready ? 'Ready' : 'Warming…'}
        </span>
      </div>
      <div className="metapool-stats">
        <span>
          <strong>{pool.idle}</strong> idle
        </span>
        <span>
          <strong>{pool.busy}</strong> busy
        </span>
        <span>
          <strong>{pool.live}</strong>/{pool.size} warm
        </span>
      </div>
    </li>
  );
}

/**
 * Settings ▸ "Metasession pools" — a live view of the warm `copilot --acp`
 * sessions the IDE keeps ready so AI responses (PR review, review board,
 * summaries, monitors, …) skip the cold CLI spawn. Size and purposes are
 * config-driven (Advanced ▸ meta ▸ warmPool); this panel reflects live state.
 */
export function MetasessionPoolsSection() {
  const api = useApi();
  const { data, loading, error, cause, reload } = useAsync(
    () => api.getMetaPools(),
    [],
  );

  useEffect(() => {
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <Card>
      <div className="page-header">
        <div className="page-header-main">
          <IconBadge icon={<ActivityIcon size={22} />} tone="accent" />
          <div>
            <h2 className="page-title">Metasession pools</h2>
            <p className="page-subtitle">
              Warm AI sessions kept ready so the IDE responds instantly instead
              of spawning a CLI per request. Configure size and purposes under
              Advanced ▸ <code>meta</code> ▸ <code>warmPool</code> (applies after
              a restart).
            </p>
          </div>
        </div>
      </div>

      {loading && !data && <Loader label="Loading pool status" />}
      {error && <ErrorState error={cause ?? error} onRetry={reload} />}
      {data && !data.enabled && (
        <EmptyState message="Warm pools are disabled. Enable meta ▸ warmPool ▸ enabled to speed up AI responses." />
      )}
      {data && data.enabled && data.pools.length === 0 && (
        <EmptyState message="No pools configured." />
      )}
      {data && data.enabled && data.pools.length > 0 && (
        <ul className="metapool-list">
          {data.pools.map((pool) => (
            <PoolRow pool={pool} key={pool.purpose} />
          ))}
        </ul>
      )}
    </Card>
  );
}

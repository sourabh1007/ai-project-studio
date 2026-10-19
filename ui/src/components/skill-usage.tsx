import { useEffect, useState } from 'react';
import { useApi } from '../app/api-context.js';
import type { SkillOrigin, SkillUsageSnapshot } from '../lib/types.js';
import { formatAic, formatCompactNumber, formatDateTime, formatTokens } from '../lib/format.js';
import { Button } from './ui.js';

const SOURCES: Record<SkillOrigin, string> = {
  repository: 'Repository', ide: 'IDE', cli: 'CLI', unknown: 'Not identified',
};

export function SkillUsage({ scope = 'feature', featureId, signal }: {
  scope?: 'feature' | 'internal'; featureId?: string; signal: string | number;
}) {
  const api = useApi();
  const [source, setSource] = useState<SkillOrigin | 'all'>('all');
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{ key: string; data: SkillUsageSnapshot | null; error: string | null }>({
    key: '', data: null, error: null,
  });
  const key = JSON.stringify([scope, featureId]);
  useEffect(() => {
    let active = true;
    setState((prev) => ({ key, data: prev.key === key ? prev.data : null, error: null }));
    void Promise.resolve().then(() => featureId === undefined ? api.getSkillUsage(scope) : api.getFeatureSkillUsage(featureId))
      .then((data) => {
        if (!data || !Array.isArray(data.rows)) throw new Error('The backend returned an invalid skill usage snapshot');
        if (active) setState({ key, data, error: null });
      })
      .catch((error: unknown) => {
        if (active) setState((prev) => ({
          ...prev, error: error instanceof Error ? error.message : 'Could not load skill usage',
        }));
      });
    return () => { active = false; };
  }, [api, scope, featureId, signal, key, refresh]);
  const snapshot = state.key === key ? state.data : null;
  const rows = snapshot?.rows.filter((row) => source === 'all' || row.source === source) ?? [];
  const measured = (value: number | null, count: number, uses: number, format: (value: number) => string) =>
    value === null ? 'Not reported' : `${format(value)}${count < uses ? ' (partial)' : ''}`;
  return <section aria-label="Skill usage">
    <h3>Skills</h3>
    <Button variant="secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh skills</Button>
    <p className="field-hint">Repository, IDE and CLI skills are tracked separately. CLI invocations, IDE context preparation and live injections are distinct activities.
      Tokens and AIC require explicit skill attribution; session totals are never divided between skills. This is a recent activity window, independent of the usage period selector.</p>
    <div className="usage-granularity" role="group" aria-label="Skill source">
      {(['all', 'repository', 'ide', 'cli', 'unknown'] as const).map((item) => <button key={item} type="button"
        className={`usage-seg ${source === item ? 'is-active' : ''}`} aria-pressed={source === item} onClick={() => setSource(item)}>
        {item === 'all' ? 'All skills' : SOURCES[item]}
      </button>)}
    </div>
    {state.key === key && state.error && <p role="status">{snapshot ? 'Could not refresh skill usage; showing the previous snapshot: ' : 'Could not load skill usage: '}{state.error}</p>}
    {!snapshot && !state.error && <p role="status">Loading skill usage…</p>}
    {snapshot?.limited && <p role="status">Showing the most recent {snapshot.maxEvents.toLocaleString()} skill events. Older activity is retained but excluded from this snapshot.</p>}
    {snapshot && rows.length === 0 && <p className="field-hint">No recorded skill activity in this source and scope. Unavailable telemetry is not zero usage.</p>}
    {rows.length > 0 && <div className="mcp-usage-table-scroll" tabIndex={0} role="region" aria-label="Skill usage details">
      <table className="usage-table" aria-label="Per-skill usage">
        <thead><tr><th>Skill</th><th>Source</th><th>Repository</th><th>Provider</th><th>Activity</th><th>Uses</th><th>Sessions</th>
          <th>Input tokens</th><th>Output tokens</th><th>AIC</th><th>Last used</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={JSON.stringify([row.identity, row.source, row.kind, row.repoId, row.provider, row.name])}>
          <td title={row.identity}>{row.name}</td><td>{SOURCES[row.source]}</td>
          <td>{row.repoName ?? row.repoId ?? 'Not associated'}</td><td>{row.provider}</td>
          <td>{row.kind === 'invocation' ? 'Invoked' : row.kind === 'context-prepared' ? 'Context prepared' : 'Context injected'}</td>
          <td className="dash-num">{formatCompactNumber(row.uses)}</td><td className="dash-num">{formatCompactNumber(row.sessions)}</td>
          <td className="dash-num">{measured(row.inputTokens, row.reportedInput, row.uses, formatTokens)}</td>
          <td className="dash-num">{measured(row.outputTokens, row.reportedOutput, row.uses, formatTokens)}</td>
          <td className="dash-num">{measured(row.nanoAiu, row.reportedAic, row.uses, formatAic)}</td>
          <td>{formatDateTime(row.lastUsedAt)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}

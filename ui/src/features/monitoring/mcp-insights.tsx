import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { InsightMatrix, useInsightVisibility } from './insights.js';
import { sharedRead } from './shared-read.js';

export function McpInsights({ provider, server, scope = 'feature', featureId, signal = 0 }: {
  provider: string; server: string; scope?: 'feature' | 'internal'; featureId?: string; signal?: string | number;
}) {
  const api = useApi();
  const visibility = useInsightVisibility();
  const [refresh, setRefresh] = useState(0);
  const key = JSON.stringify([provider, server, scope, featureId]);
  const [state, setState] = useState<{ key: string; data?: Awaited<ReturnType<typeof api.getMcpHistory>>; error?: string }>({ key: '' });
  useEffect(() => {
    if (!visibility.visible) return;
    let active = true;
    setState((previous) => previous.key === key ? { ...previous, error: undefined } : { key });
    const to = new Date();
    void sharedRead(api, `mcp:${key}:${visibility.revision}:${signal}:${refresh}`, () => api.getMcpHistory({ provider, server, scope, ...(featureId ? { featureId } : {}),
      from: new Date(to.getTime() - 7 * 86400000).toISOString(), to: to.toISOString() }))
      .then((data) => { if (active) setState({ key, data }); })
      .catch((cause: unknown) => { if (active) setState((previous) => ({ ...previous, key, error: cause instanceof Error ? cause.message : 'Call history unavailable' })); });
    return () => { active = false; };
  }, [api, key, provider, server, scope, featureId, signal, refresh, visibility.visible, visibility.revision]);
  const data = state.key === key ? state.data : undefined;
  const groups = new Map<string, NonNullable<typeof data>['items']>();
  for (const call of data?.items ?? []) {
    const id = JSON.stringify([call.tool, call.at.slice(0, 10)]);
    const values = groups.get(id) ?? [];
    values.push(call); groups.set(id, values);
  }
  return <section aria-label="MCP observed diagnostics">
    <p className="field-hint">{provider} / {server} · {scope} · last 7 UTC days. Provider-observed calls only, not merged proxy transport.
      Outcomes use only explicit provider success flags; legacy records and missing flags remain unknown. Missing completion is not failure.</p>
    <button type="button" className="rb-linkish" onClick={() => setRefresh((value) => value + 1)}>Refresh observed calls</button>
    {state.key === key && state.error && <p role="status">{data && 'Showing previous snapshot. '}{state.error}</p>}
    {!data && !state.error && <p role="status">Loading observed calls...</p>}
    {data?.limited && <p role="status">Latest 500 calls shown; older calls are excluded from these sample statistics.</p>}
    <InsightMatrix title="Tool activity and measured latency" intensity={false} columns={['Calls', 'Timed', 'Median ms', 'p95 ms', 'Unknown completion', 'Succeeded', 'Failed', 'Unknown outcome']}
      explanation="Percentiles use compatible recorded per-call durations. p95 requires at least 20 measured samples. No arguments, responses or prompts are loaded."
      rows={[...groups.entries()].map(([id, calls]) => {
        const times = calls.map((call) => call.durationMs).filter((value): value is number => value != null && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
        return { id, label: `${calls[0].tool || 'Unknown tool'} · ${calls[0].at.slice(0, 10)}`, cells: [
          { value: calls.length }, { value: times.length }, { value: times.length ? times.length % 2 ? times[Math.floor(times.length / 2)] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2 : null },
          { value: times.length >= 20 ? times[Math.ceil(times.length * 0.95) - 1] : null }, { value: calls.length - times.length },
          { value: calls.filter((call) => call.outcome === 'succeeded').length },
          { value: calls.filter((call) => call.outcome === 'failed').length },
          { value: calls.filter((call) => call.outcome !== 'succeeded' && call.outcome !== 'failed').length },
        ] };
      })} />
  </section>;
}

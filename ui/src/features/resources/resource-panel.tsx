import { useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText, Modal } from '../../components/ui.js';
import { Spinner } from '../../components/loading.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import type { MeasuredConnectionStatus } from '../../hooks/use-connection-status.js';
import type { AppResourceSnapshot, ResourceCleanup } from './resource-types.js';
import { desktopBridge } from '../../lib/desktop-bridge.js';

export const resourceBytes = (value: number | null | undefined) =>
  value == null ? 'Unavailable' : formatBytes(value);
export const resourcePercent = (value: number | null | undefined) =>
  value == null ? 'Unavailable' : `${value.toFixed(1)}%`;
const measuredTime = (value: number | null | undefined) =>
  value == null ? 'Not yet measured' : new Date(value).toLocaleTimeString();

export function ResourcePanel({ snapshot, error, loading, now, connection, refresh, onClose, onManageWorktrees }: {
  snapshot: AppResourceSnapshot | null;
  error: string | null;
  loading: boolean;
  now: number;
  connection: MeasuredConnectionStatus;
  refresh(): Promise<void>;
  onClose(): void;
  onManageWorktrees(): void;
}) {
  const api = useApi();
  const bridge = desktopBridge();
  const [httpCachePending, setHttpCachePending] = useState(false);
  const [httpCacheResult, setHttpCacheResult] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'memory' | 'cpu' | 'pid'>('pid');
  const [scanPending, setScanPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'logs' | 'cache' | null>(null);
  const [submitted, setSubmitted] = useState<Partial<Record<'logs' | 'cache', ResourceCleanup | 'submitting'>>>({});
  const processData = snapshot?.processes;
  const storage = snapshot?.storage;
  const stale = !!snapshot && (now - snapshot.measuredAt >= snapshot.staleAfterMs || now < snapshot.measuredAt);
  const processStale = processData?.sampledAt == null || now - processData.sampledAt >= (snapshot?.staleAfterMs ?? 0);
  const rows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return [...(processData?.items ?? [])].filter((item) =>
      `${item.name} ${item.role} ${item.pid} ${item.parentPid ?? ''}`.toLowerCase().includes(query))
      .sort((a, b) => sort === 'pid' ? a.pid - b.pid :
        ((sort === 'cpu' ? b.cpuPercent : b.memoryBytes) ?? -1) -
        ((sort === 'cpu' ? a.cpuPercent : a.memoryBytes) ?? -1) || a.pid - b.pid);
  }, [processData?.items, filter, sort]);
  const knownStorage = (storage?.categories ?? []).reduce((sum, item) => sum + (item.bytes ??
    item.pathDetails?.reduce((total, path) => total + (path.status === 'excluded' ? 0 : path.bytes ?? 0), 0) ?? 0), 0);
  const partialStorage = !storage?.categories.length || storage.categories.some((item) => item.bytes === null || item.error);
  const host = connection.resources;
  const hostFresh = connection.state === 'online' && !connection.probeFailed && host?.measuredAt != null &&
    now >= host.measuredAt && now - host.measuredAt < host.staleAfterMs;

  async function scan() {
    setScanPending(true); setActionError(null);
    try { await api.refreshResourceStorage(); await refresh(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Storage scan could not start.'); }
    finally { setScanPending(false); }
  }
  async function clean(category: 'logs' | 'cache') {
    setConfirm(null); setActionError(null);
    if (category === 'cache' && bridge?.clearHttpCache) {
      setHttpCachePending(true); setHttpCacheResult(null);
      try {
        const result = await bridge.clearHttpCache();
        if (result.status !== 'completed') throw new Error(result.error ?? 'Electron HTTP cache cleanup is unavailable.');
        setHttpCacheResult('Electron HTTP cache cleared. Cookies, sign-in, sessions and other stored data were preserved.');
        await api.refreshResourceStorage();
        await refresh();
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : 'Electron HTTP cache cleanup failed.');
      } finally { setHttpCachePending(false); }
      return;
    }
    setSubmitted((prev) => ({ ...prev, [category]: 'submitting' }));
    try {
      const job = await api.cleanResourceStorage(category);
      setSubmitted((prev) => ({ ...prev, [category]: job }));
      await refresh();
    } catch (cause) {
      setSubmitted((prev) => ({ ...prev, [category]: undefined }));
      setActionError(cause instanceof Error ? cause.message : 'Cleanup could not start.');
    }
  }
  const cleanup = (category: 'logs' | 'cache') => {
    const local = submitted[category];
    if (local === 'submitting') return local;
    return snapshot?.cleanups.find((job) => job.id === local?.id) ??
      (local || snapshot?.cleanups.filter((job) => job.category === category).at(-1));
  };

  function cleanupControls(category: 'logs' | 'cache') {
    const job = cleanup(category);
    const pending = (category === 'cache' && httpCachePending) || job === 'submitting' || job?.status === 'running' || job?.status === 'queued';
    const httpCache = category === 'cache' && !!bridge?.clearHttpCache;
    const enabled = httpCache || storage?.categories.some((item) => item.kind === category && item.cleanupSupported);
    const label = httpCache ? 'Clear Electron HTTP cache' : `Clean ${category}`;
    return <>
      <div className="resource-category-actions">
        <Button variant="secondary" disabled={!enabled || pending} onClick={() => setConfirm(category)}
          ariaLabel={pending ? `Cleaning ${category}…` : label}>
          {pending ? <><Spinner size={12} /> Cleaning {category}…</> : label}
        </Button>
      </div>
      {category === 'cache' && httpCacheResult && <p role="status">{httpCacheResult}</p>}
      {job && job !== 'submitting' && <p role={job.status === 'failed' ? 'alert' : 'status'}>
        {category === 'logs' ? 'Logs' : 'Cache'}: {job.status} · {job.removedFiles} files removed ({formatBytes(job.removedBytes)})
        {job.skippedFiles > 0 && ` · ${job.skippedFiles} protected/busy files skipped`}{job.error && ` · ${job.error}`}
      </p>}
      {confirm === category && <div className="resource-cleanup-confirm" role="group" aria-label={`Confirm ${category} cleanup`}>
        {httpCache
          ? <p>Clear this desktop app's Electron HTTP cache through Chromium? Cached network responses will be downloaded again. Cookies, sign-in, local storage, session history, provider caches and worktrees are preserved.</p>
          : <><p>Delete eligible disposable {category} in these locations? Active/protected files, credentials, sessions, databases and worktrees are preserved. This cannot be undone.</p>
            <ul>{storage?.categories.filter((item) => item.kind === category && item.cleanupSupported).flatMap((item) => item.paths).map((path) => <li key={path}><code>{path}</code></li>)}</ul></>}
        <div className="resource-category-actions">
          <Button variant="danger" onClick={() => void clean(category)}>Confirm clean {category}</Button>
          <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
        </div>
      </div>}
    </>;
  }

  return <Modal title="App resources" size="xl" className="resource-modal" onClose={onClose}>
    <div className="resource-panel">
      {loading && <p role="status"><Spinner size={14} /> Loading app resources…</p>}
      <ErrorText error={error} />
      {error && <Button onClick={() => void refresh()}>Retry resource measurements</Button>}
      {stale && <p role="status" className="resource-warning">Measurements are stale. Last snapshot: {measuredTime(snapshot?.measuredAt)}.</p>}
      <section className="resource-section" aria-labelledby="resource-system-title">
        <header className="resource-section-head"><h3 id="resource-system-title">System</h3><span className="muted">Entire machine · not app usage</span></header>
        <div className="resource-summary-grid resource-system-metrics">
          <div><span>CPU</span><strong>{resourcePercent(hostFresh ? host?.cpuPercent : null)}</strong><small>Across all logical processors</small></div>
          <div><span>RAM available</span><strong>{resourceBytes(hostFresh ? host?.freeMemoryBytes : null)}</strong><small>of {resourceBytes(hostFresh ? host?.totalMemoryBytes : null)} installed</small></div>
          <div><span>Backend responsiveness</span><strong>{hostFresh && host?.eventLoopDelayMs != null ? `${host.eventLoopDelayMs.toFixed(0)} ms` : 'Unavailable'}</strong><small>Event-loop delay</small></div>
        </div>
        <div className="resource-subsection">
          <h4>Hard disks</h4>
          <div className="resource-volume-list">{storage?.volumes.map((volume) => {
            const normalized = volume.path.replaceAll('/', '\\');
            const drive = /^[a-z]:\\/i.exec(normalized)?.[0] ?? (normalized.startsWith('\\\\') ? normalized.split('\\').slice(0, 4).join('\\') : volume.path);
            const percent = volume.totalBytes != null && volume.totalBytes > 0 && volume.freeBytes != null
              ? Math.max(0, Math.min(100, 100 * (1 - volume.freeBytes / volume.totalBytes))) : null;
            return <div className="resource-volume" key={volume.path}>
              <div className="resource-volume-heading"><strong title={volume.path}>{drive}</strong>
                <span>{resourceBytes(volume.freeBytes)} free / {resourceBytes(volume.totalBytes)} capacity</span></div>
              {percent !== null && <div className="resource-meter" role="meter" aria-label={`Used disk space on ${drive}`}
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
                <span style={{ width: `${percent}%` }} />
              </div>}
              <ErrorText error={volume.error} />
            </div>;
          })}</div>
          {!storage?.volumes.length && <p className="muted">Disk capacity has not been measured yet.</p>}
        </div>
      </section>
      <section className="resource-section" aria-labelledby="resource-app-title">
        <header className="resource-section-head"><h3 id="resource-app-title">App</h3><span className="muted">AI Project Studio and child processes</span></header>
        <div className="resource-summary-grid">
          <div><span>App CPU</span><strong>{resourcePercent(processData?.cpuPercent)}</strong><small>Share of machine CPU capacity</small></div>
          <div><span>App RAM</span><strong>{resourceBytes(processData?.memoryBytes)}</strong><small>Combined process working sets</small></div>
          <div><span>App disk footprint</span><strong>{storage?.categories.length ? `${partialStorage ? 'At least ' : ''}${formatBytes(knownStorage)}` : 'Not yet measured'}</strong><small>Measured storage below</small></div>
        </div>
      <section className="resource-subsection" aria-labelledby="resource-process-title">
        <div className="resource-section-head"><h3 id="resource-process-title">Processes ({processData?.items.length ?? 0})</h3>
          <span className="muted">Sample: {measuredTime(processData?.sampledAt)}{processStale && ' · not current'}</span></div>
        <ErrorText error={processData?.error ?? null} />
        {processData?.status === 'sampling' && <p role="status"><Spinner size={12} /> Sampling processes…</p>}
        <div className="resource-controls">
          <input className="input" type="search" aria-label="Filter processes" placeholder="Filter by name, role or PID" value={filter} onChange={(event) => setFilter(event.target.value)} />
          <label>Sort <select className="input" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
            <option value="memory">RAM usage</option><option value="cpu">CPU usage</option><option value="pid">Process ID</option>
          </select></label>
        </div>
        <div className="resource-table-scroll"><table className="resource-table">
          <thead><tr><th>Process / role</th><th>PID / parent</th><th>CPU</th><th>RAM</th><th>Hard disk</th></tr></thead>
          <tbody>{rows.map((item) => <tr key={`${item.pid}:${item.startedAt}`}>
            <td title={`Started: ${formatDateTime(item.startedAt)}`}><strong>{item.name}</strong><small>{item.role}</small></td>
            <td>{item.pid}<small>Parent: {item.parentPid ?? '—'}</small></td>
            <td>{resourcePercent(item.cpuPercent)}</td><td>{resourceBytes(item.memoryBytes)}</td>
            <td><button type="button" className="resource-storage-link" title="Files and caches are shared; disk usage is not attributed to individual PIDs."
              onClick={() => document.getElementById('resource-storage-title')?.scrollIntoView({ block: 'nearest' })}>Shared storage</button></td>
          </tr>)}</tbody>
        </table></div>
        {!rows.length && !loading && <p className="muted">{filter ? 'No matching processes.' : 'No process measurements available yet.'}</p>}
        <details className="resource-notes"><summary>Measurement details</summary>
          <p className="muted">CPU is a share of machine capacity; its first sample may be unavailable. Summed RAM working sets can count shared pages more than once. PIDs do not exclusively own files, so per-process disk allocation is not measured; shared app storage is listed below. Independently launched services are excluded. Hover a process name for its start time.</p>
        </details>
      </section>
      <section className="resource-subsection" aria-labelledby="resource-storage-title">
        <div className="resource-section-head"><h3 id="resource-storage-title">App storage</h3>
          <Button variant="secondary" disabled={scanPending || storage?.status === 'scanning'} onClick={() => void scan()}>
            {scanPending || storage?.status === 'scanning' ? <><Spinner size={12} /> Scanning storage…</> : 'Refresh disk usage'}
          </Button></div>
        <p className="muted">Last completed scan: {measuredTime(storage?.scannedAt)}. Disk scans run in the background, less often than CPU/RAM samples.</p>
        {storage?.progress && <p role="status">
          {storage.status === 'scanning' ? 'Scanning' : 'Last scan'}: {storage.progress.visitedEntries.toLocaleString()} entries · {formatBytes(storage.progress.scannedBytes)} measured
          {storage.status === 'scanning' && storage.progress.currentPath && <> · <code>{storage.progress.currentPath}</code></>}
        </p>}
        {storage?.stale && <p role="status" className="resource-warning">Disk measurements are stale; refresh to rescan.</p>}
        <ErrorText error={storage?.error ?? null} />
        <div className="resource-storage-list">{storage?.categories.map((item) => <section className="resource-category" key={item.id} aria-label={item.label}>
          <details>
          <summary><span>{item.label}</span><strong>{resourceBytes(item.bytes)}</strong></summary>
          <ul>{item.paths.map((path) => {
            const detail = item.pathDetails?.find((entry) => entry.path === path);
            return <li key={path}><code>{path}</code>{detail && <>
              {' '}— {detail.status === 'partial' ? 'At least ' : ''}{resourceBytes(detail.bytes)} ({detail.status})
              {detail.errors.length > 0 && <span className="muted"> · {[...new Set(detail.errors)].join(' ')}</span>}
            </>}
            </li>;
          })}</ul>
          <ErrorText error={item.error} />
          {item.cleanupReason && <p className="muted">{item.cleanupReason}</p>}
          </details>
          {item.kind === 'worktrees' && <div className="resource-category-actions"><Button variant="secondary" onClick={onManageWorktrees}>Manage worktrees</Button></div>}
          {(item.kind === 'logs' || item.kind === 'cache') && cleanupControls(item.kind)}
        </section>)}</div>
        {!storage?.categories.length && <p className="muted">Storage locations have not been loaded yet.</p>}
        <details className="resource-notes"><summary>Storage accounting</summary><p className="muted">Scoped paths avoid counting nested categories twice. Shared provider data may also be used by other apps; file sizes can differ from physical allocated disk space.</p></details>
        <ErrorText error={actionError} />
      </section>
      </section>
    </div>
  </Modal>;
}

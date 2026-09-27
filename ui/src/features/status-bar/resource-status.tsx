import { useEffect, useState } from 'react';
import type { MeasuredConnectionStatus } from '../../hooks/use-connection-status.js';
import { resourceStatus } from '../../lib/resource-status.js';
import { OverviewIcon } from '../../components/icons.js';
import { useResourceMonitor } from '../resources/use-resource-monitor.js';
import { ResourcePanel, resourceBytes, resourcePercent } from '../resources/resource-panel.js';

export function ResourceStatus({ connection, onManageWorktrees }: {
  connection: MeasuredConnectionStatus;
  onManageWorktrees?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const monitor = useResourceMonitor(open);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const view = resourceStatus(connection.resources, connection.state, connection.probeFailed, now);
  const snapshot = monitor.snapshot;
  const processes = snapshot?.processes;
  const fresh = !monitor.error && connection.state === 'online' && !connection.probeFailed &&
    snapshot && processes?.sampledAt != null && now >= processes.sampledAt && now - processes.sampledAt < snapshot.staleAfterMs;
  const state = !fresh || processes.status === 'unavailable' ? 'unknown' : view.state;
  const description = fresh
    ? `App CPU: ${resourcePercent(processes.cpuPercent)}. App RAM: ${resourceBytes(processes.memoryBytes)}. Click for processes, disk usage and cleanup.`
    : 'App resource measurements unavailable or stale. Click for details and retry.';
  const memoryPercent = processes?.memoryBytes != null && connection.resources?.totalMemoryBytes
    ? 100 * processes.memoryBytes / connection.resources.totalMemoryBytes : 0;
  const usage = fresh ? Math.min(100, Math.max(processes.cpuPercent ?? 0, memoryPercent)) : 0;
  return (
    <>
      <button type="button" className={`statusbar-item resource-status resource-status--${state}`}
        title={`${description}\nBar: higher of app CPU share and app RAM share. Amber indicates measured resource pressure.\n${view.detail}`} aria-label="App resource usage"
        aria-description={description} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen(true)}>
        <span className="resource-status-glyph" aria-hidden="true">
          <OverviewIcon size={15} />
          <span className="resource-usage-track"><span style={{ width: `${usage}%` }} /></span>
        </span>
      </button>
      {open && <ResourcePanel {...monitor} now={now} connection={connection} onClose={() => setOpen(false)}
        onManageWorktrees={() => { setOpen(false); onManageWorktrees?.(); }} />}
    </>
  );
}

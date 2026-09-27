import type { AppResources, ProcessReading, ProcessSample } from './resources-contract.js';

export const processIdentity = (p: ProcessReading): string => `${p.pid}:${p.startedAt}`;

export function createProcessAttribution(backendPid: number, desktopPid: number, staleAfterMs: number) {
  let previous: ProcessSample | undefined;
  let root: ProcessReading | undefined;
  let owned = new Set<string>();
  return (sample: ProcessSample): AppResources => {
    const byPid = new Map(sample.processes.map((p) => [p.pid, p]));
    const backend = byPid.get(backendPid);
    if (!root && backend) {
      const parent = byPid.get(backend.parentPid);
      root = parent && parent.startedAt <= backend.startedAt &&
        (desktopPid === parent.pid || /^(electron|ai project studio)(\.exe)?$/i.test(parent.name))
        ? parent : backend;
    }
    const selected = new Map<number, ProcessReading>();
    for (const p of byPid.values()) {
      if ((root && processIdentity(p) === processIdentity(root)) || owned.has(processIdentity(p))) {
        selected.set(p.pid, p);
      }
    }
    // A live backend is always measurable, even after its desktop owner exits.
    if (backend && (!previous || owned.has(processIdentity(backend)))) selected.set(backend.pid, backend);
    const children = new Map<number, ProcessReading[]>();
    for (const p of byPid.values()) {
      const list = children.get(p.parentPid) ?? [];
      list.push(p);
      children.set(p.parentPid, list);
    }
    const queue = [...selected.values()];
    for (let i = 0; i < queue.length; i++) {
      for (const child of children.get(queue[i]!.pid) ?? []) {
        if (!selected.has(child.pid) && child.startedAt >= queue[i]!.startedAt) {
          selected.set(child.pid, child);
          queue.push(child);
        }
      }
    }
    const old = new Map(previous?.processes.map((p) => [processIdentity(p), p]));
    const elapsed = previous ? sample.measuredAt - previous.measuredAt : 0;
    const processes = [...selected.values()].map((p) => {
      const before = old.get(processIdentity(p));
      const delta = p.cpuTimeMs !== null && before?.cpuTimeMs != null ? p.cpuTimeMs - before.cpuTimeMs : -1;
      const cpuPercent = elapsed > 0 && sample.logicalCpuCount > 0 && delta >= 0
        ? Math.min(100, delta / elapsed / sample.logicalCpuCount * 100) : null;
      const { cpuTimeMs: _cpu, ...rest } = p;
      return {
        ...rest, role: p.pid === backendPid ? 'backend' as const :
          root && p.pid === root.pid && root.pid !== backendPid ? 'desktop-main' as const : p.role,
        identity: processIdentity(p), cpuPercent,
      };
    }).sort((a, b) => a.pid - b.pid);
    owned = new Set(processes.map((p) => p.identity));
    previous = sample;
    const cpu = processes.filter((p) => p.cpuPercent !== null);
    const memory = processes.filter((p) => p.memoryBytes !== null);
    const errors: string[] = [];
    if (!root || !selected.has(root.pid)) errors.push('App root process is unavailable; surviving known descendants only.');
    if (cpu.length !== processes.length) errors.push('CPU needs two samples for each process identity; total includes measured processes only.');
    if (memory.length !== processes.length) errors.push('Working set unavailable for one or more processes; memory total is incomplete.');
    return {
      status: processes.length === 0 ? 'unavailable' : errors.length ? 'partial' : 'ready',
      measuredAt: sample.measuredAt, staleAfterMs, rootPid: root?.pid ?? null,
      cpuPercent: cpu.length ? cpu.reduce((sum, p) => sum + p.cpuPercent!, 0) : null,
      memoryBytes: memory.length ? memory.reduce((sum, p) => sum + p.memoryBytes!, 0) : null,
      processCount: processes.length, cpuMeasuredProcessCount: cpu.length,
      cpuNormalization: 'percent-of-host-logical-cpus',
      memoryMetric: 'summed-working-set-rss-shared-pages-may-overlap',
      processes, errors,
    };
  };
}

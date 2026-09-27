import { describe, expect, it } from 'vitest';
import { createProcessAttribution } from './process-attribution.js';
import type { ProcessReading } from './resources-contract.js';

const p = (pid: number, parentPid: number, overrides: Partial<ProcessReading> = {}): ProcessReading => ({
  pid, parentPid, startedAt: pid, name: 'node.exe', role: 'child', cpuTimeMs: 0, memoryBytes: 100, ...overrides,
});
const sample = (processes: ProcessReading[], measuredAt = 1000, logicalCpuCount = 4) => ({
  processes, measuredAt, logicalCpuCount,
});
describe('app process attribution', () => {
  it('includes Electron siblings, backend descendants and deduplicates PIDs; excludes unrelated roots', () => {
    const attribute = createProcessAttribution(2, 1, 30000);
    const rows = [p(1, 0), p(2, 1), p(3, 1, { role: 'renderer' }), p(4, 2, { role: 'cli' }), p(5, 99), p(4, 2, { role: 'cli' })];
    const initial = attribute(sample(rows));
    expect(initial).toMatchObject({ status: 'partial', cpuPercent: null, memoryBytes: 400, rootPid: 1, processCount: 4 });
    const next = attribute(sample(rows.map((row) => ({ ...row, cpuTimeMs: 1000 })), 2000));
    expect(next).toMatchObject({ status: 'ready', cpuPercent: 100, cpuMeasuredProcessCount: 4 });
    expect(next.processes.map((row) => row.role)).toEqual(['desktop-main', 'backend', 'renderer', 'cli']);
  });
  it('discovers a desktop parent on an existing launch without the new environment config', () => {
    const attribute = createProcessAttribution(2, 0, 100);
    expect(attribute(sample([p(1, 0, { name: 'Electron.exe' }), p(2, 1)])).rootPid).toBe(1);
  });
  it('never claims a terminal parent, older unrelated children or a parent with a reused PID', () => {
    const attribute = createProcessAttribution(2, 0, 100);
    expect(attribute(sample([p(1, 0), p(2, 1), p(3, 2, { startedAt: 1 })])).processes.map((r) => r.pid)).toEqual([2]);
    const reusedParent = createProcessAttribution(2, 1, 100);
    expect(reusedParent(sample([p(1, 0, { startedAt: 10 }), p(2, 1)])).rootPid).toBe(2);
  });
  it('keeps known orphaned children but not PID reuse, and reports disappeared root', () => {
    const attribute = createProcessAttribution(2, 1, 100);
    attribute(sample([p(1, 0), p(2, 1), p(3, 2)]));
    const orphan = attribute(sample([p(3, 2), p(1, 0, { startedAt: 500 })], 2000));
    expect(orphan.processes.map((r) => r.pid)).toEqual([3]);
    expect(orphan.status).toBe('partial');
    expect(attribute(sample([p(3, 0, { startedAt: 600 })], 3000)).status).toBe('unavailable');
  });
  it('reports unavailable before finding the backend and tolerates a backend without parents', () => {
    const attribute = createProcessAttribution(2, 0, 100);
    expect(attribute(sample([]))).toMatchObject({ status: 'unavailable', rootPid: null, memoryBytes: null });
    expect(attribute(sample([p(2, 99)], 2000)).rootPid).toBe(2);
  });
  it('requires positive elapsed time, logical CPUs and nonregressing counters', () => {
    const attribute = createProcessAttribution(2, 0, 100);
    attribute(sample([p(2, 1, { cpuTimeMs: 10 })]));
    expect(attribute(sample([p(2, 1)], 2000)).cpuPercent).toBeNull();
    expect(attribute(sample([p(2, 1)], 2000)).cpuPercent).toBeNull();
    expect(attribute(sample([p(2, 1)], 3000, 0)).cpuPercent).toBeNull();
    const partial = attribute(sample([p(2, 1, { cpuTimeMs: null, memoryBytes: null })], 4000));
    expect(partial.cpuPercent).toBeNull();
    expect(partial.memoryBytes).toBeNull();
    expect(partial.errors).toHaveLength(2);
    expect(attribute(sample([p(2, 1)], 5000)).cpuPercent).toBeNull();
  });
  it('clamps measured CPU and avoids cycles in malformed ancestry', () => {
    const attribute = createProcessAttribution(2, 0, 100);
    attribute(sample([p(2, 2)]));
    expect(attribute(sample([p(2, 2, { cpuTimeMs: 100000 })], 2000)).cpuPercent).toBe(100);
  });
});

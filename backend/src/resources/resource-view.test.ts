import { describe, expect, it } from 'vitest';
import { resourceView } from './resource-view.js';
import { createProcessAttribution } from './process-attribution.js';
import { initialStorage } from './storage-scanner.js';
import { evaluateResources } from '../resource-pressure/resource-pressure.js';
import { resourcePressureDefaults } from '../resource-pressure/config.js';
import type { ResourcesSnapshot } from './resources-contract.js';

function snapshot(): ResourcesSnapshot {
  const attribute = createProcessAttribution(2, 0, 30000);
  const rows = [{ pid: 2, parentPid: 0, name: 'node', role: 'backend' as const, startedAt: 1, cpuTimeMs: 0, memoryBytes: 100 }];
  attribute({ measuredAt: 1000, logicalCpuCount: 1, processes: rows });
  return {
    sampledAt: 2000,
    host: evaluateResources(undefined, 1, resourcePressureDefaults),
    app: attribute({ measuredAt: 2000, logicalCpuCount: 1, processes: rows }),
    storage: initialStorage(true), cleanups: [],
  };
}
describe('resource UI wire projection', () => {
  it('matches the UI contract, not the old internal snapshot; normalizes whole-machine CPU and dates', () => {
    const value = snapshot();
    value.app.cpuPercent = 110;
    const result = resourceView(value);
    expect(result).not.toHaveProperty('host');
    expect(result).not.toHaveProperty('app');
    expect(result.storage.categories[0]).toMatchObject({
      paths: [], cleanupSupported: false,
      cleanupReason: 'Cleanup paths are not available yet; refresh storage first.',
    });
    expect(result).toMatchObject({
      measuredAt: 2000, processes: {
        status: 'ready', error: null, cpuPercent: 100, memoryBytes: 100,
        items: [{ parentPid: null, startedAt: '1970-01-01T00:00:00.001Z' }],
      }, cleanups: [],
    });
    value.app.processes[0]!.parentPid = 1;
    value.app.cpuPercent = null;
    expect(resourceView(value).processes).toMatchObject({ cpuPercent: null, items: [{ parentPid: 1 }] });
  });
  it('does not expose partial/stale CPU totals as whole-app usage', () => {
    const value = snapshot();
    value.app.status = 'partial';
    value.app.errors = ['new child needs a baseline'];
    expect(resourceView(value).processes).toMatchObject({ status: 'sampling', cpuPercent: null, memoryBytes: 100 });
    value.app.processes[0]!.memoryBytes = null;
    expect(resourceView(value).processes.memoryBytes).toBeNull();
    value.app.status = 'stale';
    expect(resourceView(value).processes).toMatchObject({
      status: 'unavailable', cpuPercent: null, memoryBytes: null,
      error: expect.stringContaining('stale'), items: [{ cpuPercent: null, memoryBytes: null }],
    });
    value.app.status = 'unavailable';
    expect(resourceView(value).processes.status).toBe('unavailable');
    value.app.measuredAt = null;
    expect(resourceView(value).processes.status).toBe('unavailable');
    value.app.errors = ['Process sampling has not completed.'];
    expect(resourceView(value).processes.status).toBe('sampling');
    value.app.status = 'ready';
    value.app.processCount = 0;
    expect(resourceView(value).processes).toMatchObject({ cpuPercent: null, memoryBytes: null });
  });
  it('returns immediate scanning state and detailed incomplete-path diagnostics', () => {
    const value = snapshot();
    value.storage.status = 'scanning';
    expect(resourceView(value).storage.status).toBe('scanning');
    expect(resourceView(value).storage.categories[0]!.error).toBeNull();
    const category = value.storage.categories[0]!;
    category.bytes = 10;
    category.paths = [
      { path: 'logs', bytes: 10, measuredAt: 1, status: 'partial', errors: ['entry limit'] },
      { path: 'duplicate', bytes: null, measuredAt: null, status: 'excluded', errors: [] },
    ];
    value.storage.status = 'partial';
    const result = resourceView(value);
    expect(result.storage).toMatchObject({
      status: 'unavailable', error: 'entry limit',
    });
    expect(result.storage.categories[0]).toMatchObject({ id: 'logs', kind: 'logs', bytes: null, paths: ['logs'], cleanupSupported: true, error: 'entry limit' });
    category.paths[0]!.status = 'ready';
    category.paths[0]!.errors = [];
    value.storage.status = 'ready';
    expect(resourceView(value).storage.categories[0]).toMatchObject({ bytes: 10, error: null });
    value.storage.status = 'unavailable';
    value.storage.errors = Array.from({ length: 30 }, () => 'error');
    expect(resourceView(value).storage.status).toBe('unavailable');
    expect(resourceView(value).storage.error!.split('; ')).toHaveLength(20);
  });
});

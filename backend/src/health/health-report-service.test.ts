import { describe, it, expect } from 'vitest';
import { createHealthReportService } from './health-report-service.js';
import type { HealthProbe, ProviderHealth } from './health-contract.js';

function probe(
  id: string,
  check: HealthProbe['check'],
  title = id,
): HealthProbe {
  return { id, title, check };
}

const noProviders = (): ProviderHealth[] => [];

describe('health-report-service', () => {
  it('reports ok overall when every probe is ok and omits empty detail', async () => {
    let clock = 100;
    const service = createHealthReportService({
      probes: [
        probe('api', () => ({ state: 'ok' })),
        probe('db', async () => ({ state: 'ok' })),
      ],
      providerHealth: noProviders,
      timeoutMs: 1000,
      now: () => clock++,
    });

    const report = await service.report();

    expect(report.overall).toBe('ok');
    expect(report.checks.map((c) => c.id)).toEqual(['api', 'db']);
    expect(report.checks[0]).not.toHaveProperty('detail');
    expect(report.checks[0]).toMatchObject({ id: 'api', state: 'ok' });
    expect(typeof report.generatedAt).toBe('number');
  });

  it('keeps a probe detail and measures latency from the injected clock', async () => {
    const readings = [10, 25, 99];
    const service = createHealthReportService({
      probes: [probe('db', () => ({ state: 'degraded', detail: 'slow' }))],
      providerHealth: noProviders,
      timeoutMs: 1000,
      now: () => readings.shift() ?? 99,
    });

    const report = await service.report();

    expect(report.overall).toBe('degraded');
    expect(report.checks[0]).toMatchObject({
      state: 'degraded',
      detail: 'slow',
      latencyMs: 15,
    });
  });

  it('treats a thrown Error as down with the error message', async () => {
    const service = createHealthReportService({
      probes: [
        probe('boom', () => {
          throw new Error('kaboom');
        }),
      ],
      providerHealth: noProviders,
      timeoutMs: 1000,
      now: () => 0,
    });

    const report = await service.report();

    expect(report.overall).toBe('down');
    expect(report.checks[0]).toMatchObject({ state: 'down', detail: 'kaboom' });
  });

  it('treats a non-Error rejection as down with a stringified detail', async () => {
    const service = createHealthReportService({
      probes: [probe('boom', () => Promise.reject('plain string'))],
      providerHealth: noProviders,
      timeoutMs: 1000,
      now: () => 0,
    });

    const report = await service.report();

    expect(report.checks[0]).toMatchObject({
      state: 'down',
      detail: 'plain string',
    });
  });

  it('reports a probe that never settles as down via the timeout', async () => {
    const service = createHealthReportService({
      probes: [probe('hang', () => new Promise(() => {}))],
      providerHealth: noProviders,
      timeoutMs: 10,
    });

    const report = await service.report();

    expect(report.overall).toBe('down');
    expect(report.checks[0]).toMatchObject({
      id: 'hang',
      state: 'down',
      detail: 'Timed out after 10ms',
    });
    expect(report.checks[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('folds many states into the worst and includes async provider health', async () => {
    const providers: ProviderHealth[] = [
      { id: 'copilot', title: 'GitHub Copilot CLI', installed: true, version: '1.2.3' },
      { id: 'agency', title: 'Agency', installed: false, detail: 'Not installed' },
    ];
    const service = createHealthReportService({
      probes: [
        probe('a', () => ({ state: 'ok' })),
        probe('b', () => ({ state: 'degraded' })),
      ],
      providerHealth: async () => providers,
      timeoutMs: 1000,
      now: () => 0,
    });

    const report = await service.report();

    // Overall reflects the subsystem checks only, not uninstalled providers.
    expect(report.overall).toBe('degraded');
    expect(report.providers).toEqual(providers);
  });

  it('never reports negative latency when the clock goes backwards', async () => {
    const readings = [500, 100];
    const service = createHealthReportService({
      probes: [probe('x', () => ({ state: 'ok' }))],
      providerHealth: noProviders,
      timeoutMs: 1000,
      now: () => readings.shift() ?? 100,
    });

    const report = await service.report();

    expect(report.checks[0].latencyMs).toBe(0);
  });

  it('falls back to the wall clock when no now() is injected', async () => {
    const before = Date.now();
    const service = createHealthReportService({
      probes: [probe('x', () => ({ state: 'ok' }))],
      providerHealth: noProviders,
      timeoutMs: 1000,
    });

    const report = await service.report();

    expect(report.generatedAt).toBeGreaterThanOrEqual(before);
    expect(report.checks[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports ok with no checks and no providers', async () => {
    const service = createHealthReportService({
      probes: [],
      providerHealth: noProviders,
      timeoutMs: 1000,
      now: () => 42,
    });

    const report = await service.report();

    expect(report).toEqual({
      generatedAt: 42,
      overall: 'ok',
      checks: [],
      providers: [],
    });
  });
});

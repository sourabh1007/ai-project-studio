import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourcePressureDefaults as config } from './config.js';

const native = vi.hoisted(() => ({
  cpus: vi.fn(), freemem: vi.fn(() => 8e9), totalmem: vi.fn(() => 16e9),
  histogram: { max: 350_000_000, enable: vi.fn(), disable: vi.fn(), reset: vi.fn() },
}));
vi.mock('node:os', () => native);
vi.mock('node:perf_hooks', () => ({ monitorEventLoopDelay: () => native.histogram }));
import { createSystemResourceSampler } from './system-resource-sampler.js';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('system sampler IO lifecycle', () => {
  it('samples native counters only on its timer and disposes monitoring', () => {
    vi.useFakeTimers();
    native.cpus.mockReturnValueOnce([{ times: { idle: 10, user: 10 } }])
      .mockReturnValue([{ times: { idle: 20, user: 100 } }]);
    const monitor = createSystemResourceSampler(config);
    expect(monitor.snapshot().status).toBe('unknown');
    vi.advanceTimersByTime(config.sampleIntervalMs);
    expect(monitor.snapshot()).toMatchObject({
      status: 'pressure', cpuPercent: 90, eventLoopDelayMs: 350,
      reasons: ['high-cpu', 'event-loop-lag'],
    });
    monitor.snapshot();
    expect(native.cpus).toHaveBeenCalledTimes(2);
    monitor.dispose();
    expect(native.histogram.disable).toHaveBeenCalledOnce();
    expect(monitor.snapshot().status).toBe('unknown');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports unknown when native sampling fails', () => {
    vi.useFakeTimers();
    native.cpus.mockReturnValueOnce([]).mockImplementation(() => { throw new Error('OS unavailable'); });
    const monitor = createSystemResourceSampler(config);
    vi.advanceTimersByTime(config.sampleIntervalMs);
    expect(monitor.snapshot().status).toBe('unknown');
    expect(native.histogram.reset).toHaveBeenCalled();
    monitor.dispose();
  });
});

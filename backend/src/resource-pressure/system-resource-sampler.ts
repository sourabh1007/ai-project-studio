import { cpus, freemem, totalmem } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { ResourcePressureConfig } from './config.js';
import {
  cpuUtilization, evaluateResources, type ResourceMonitor, type ResourceReading,
} from './resource-pressure.js';

function cpuTimes(): { idle: number; total: number } {
  return cpus().reduce((sum, cpu) => ({
    idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
  }), { idle: 0, total: 0 });
}

/** Thin OS adapter. HTTP only reads the cached window; it never samples the OS. */
export function createSystemResourceSampler(config: ResourcePressureConfig): ResourceMonitor {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  let previous = cpuTimes();
  let reading: ResourceReading | undefined;
  delay.enable();
  const timer = setInterval(() => {
    try {
      const current = cpuTimes();
      reading = {
        measuredAt: Date.now(),
        cpuPercent: cpuUtilization(previous, current),
        freeMemoryBytes: freemem(),
        totalMemoryBytes: totalmem(),
        eventLoopDelayMs: delay.max / 1_000_000,
      };
      previous = current;
    } catch {
      reading = undefined;
    } finally {
      delay.reset();
    }
  }, config.sampleIntervalMs);
  timer.unref();
  return {
    snapshot: () => evaluateResources(reading, Date.now(), config),
    dispose() {
      clearInterval(timer);
      delay.disable();
      reading = undefined;
    },
  };
}

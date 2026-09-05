import type { PtySpawner } from '../terminal/pty-contract.js';
import type { PlanUsageProbe } from './plan-usage-contract.js';
import { parsePlanUsage } from './plan-usage-parser.js';

export interface PtyPlanUsageProbeDeps {
  spawner: PtySpawner;
  /** The `copilot` executable name/path (resolved by the spawner). */
  command: string;
  /** Base environment for the spawned CLI. */
  env: Record<string, string>;
  /** Working directory for the throwaway session. */
  cwd?: string;
  /** Hard cap on how long to wait for a capture before giving up (ms). */
  timeoutMs?: number;
  /** Delay before first issuing `/usage` to let the TUI boot (ms). */
  bootMs?: number;
  /** Interval between re-issuing `/usage` until the panel renders (ms). */
  retryMs?: number;
}

/**
 * Real {@link PlanUsageProbe}: drives a throwaway `copilot` pseudo-terminal,
 * issues the interactive `/usage` command, and returns the rendered panel text
 * once the AI-credit line appears (detected by re-parsing with the shared
 * parser). This is the only surface exposing the plan's quota — it is not in
 * any local file, the ACP protocol, or the custom status-line JSON — so it is
 * scraped here. IO/timing only; excluded from coverage like other adapters.
 */
export function createPtyPlanUsageProbe(
  deps: PtyPlanUsageProbeDeps,
): PlanUsageProbe {
  const timeoutMs = deps.timeoutMs ?? 45000;
  const bootMs = deps.bootMs ?? 3000;
  const retryMs = deps.retryMs ?? 4000;

  return {
    capture() {
      return new Promise<string | null>((resolve) => {
        let output = '';
        let settled = false;
        const timers: ReturnType<typeof setInterval>[] = [];

        const proc = deps.spawner.spawn({
          command: deps.command,
          args: [],
          env: deps.env,
          cwd: deps.cwd,
          cols: 140,
          rows: 45,
        });

        const finish = (result: string | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          for (const timer of timers) {
            clearInterval(timer);
          }
          clearTimeout(deadline);
          try {
            proc.kill();
          } catch {
            // best effort — process may already be gone
          }
          resolve(result);
        };

        const deadline = setTimeout(() => {
          finish(parsePlanUsage(output, '') ? output : null);
        }, timeoutMs);
        if (typeof deadline.unref === 'function') {
          deadline.unref();
        }

        proc.onData((data) => {
          output += data;
          if (parsePlanUsage(output, '') !== null) {
            finish(output);
          }
        });
        proc.onExit(() => {
          finish(parsePlanUsage(output, '') ? output : null);
        });

        const ask = (): void => proc.write('/usage\r');
        const boot = setTimeout(() => {
          ask();
          const retry = setInterval(ask, retryMs);
          if (typeof retry.unref === 'function') {
            retry.unref();
          }
          timers.push(retry);
        }, bootMs);
        if (typeof boot.unref === 'function') {
          boot.unref();
        }
      });
    },
  };
}

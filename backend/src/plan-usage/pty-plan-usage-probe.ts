import type { ProcessAdmission, ProcessPermit } from '../kernel/process-admission.js';
import type { PtyProcess, PtySpawner } from '../terminal/pty-contract.js';
import type { PlanUsageProbe } from './plan-usage-contract.js';
import type { PlanUsageProbeCommand } from './plan-usage-command.js';
import { parsePlanUsage } from './plan-usage-parser.js';
import { ConflictError } from '../kernel/error-types.js';

export interface PtyPlanUsageProbeDeps {
  spawner: PtySpawner;
  /**
   * Resolves the executable + args for a fresh probe TUI. Called once per spawn
   * (not per capture) so the probe always reflects the active provider and a
   * fresh `--session-id`. See {@link buildPlanUsageProbeCommand}.
   */
  resolveCommand: () => PlanUsageProbeCommand;
  /** Base environment for the spawned CLI. */
  env: Record<string, string>;
  /** Working directory for the throwaway session. */
  cwd?: string;
  /**
   * Admits the probe's process against the shared budget so it stops losing the
   * race for machine resources with the warm pool (which starved the cold probe
   * and made `/usage` time out, flashing "unavailable"). Optional: when absent
   * the probe spawns directly (used by simple harnesses).
   */
  admission?: ProcessAdmission;
  /** Hard cap on how long to wait for a capture before giving up (ms). */
  timeoutMs?: number;
  /** Delay before first issuing `/usage` to let a freshly spawned TUI boot (ms). */
  bootMs?: number;
  /** Interval between re-issuing `/usage` until the panel renders (ms). */
  retryMs?: number;
  /** Max time to wait for a process-admission permit before giving up (ms). */
  admitWaitMs?: number;
  usageCommand?: () => string;
  acquireExecution?: () => { release(): void };
}

/** A booted TUI kept alive between captures so refreshes reuse one process. */
interface LiveProbe {
  proc: PtyProcess;
  permit: ProcessPermit | null;
  buffer: string;
  alive: boolean;
  execution: { release(): void } | null;
}

export interface ManagedPlanUsageProbe extends PlanUsageProbe {
  stop(): void;
  shutdown(): void;
  isCapturing(): boolean;
}
/**
 * Real {@link PlanUsageProbe}: drives a `copilot`/`agency` pseudo-terminal,
 * issues the interactive `/usage` command, and returns the rendered panel text
 * once the AI-credit line appears (detected by re-parsing with the shared
 * parser). This is the only surface exposing the plan's quota — it is not in
 * any local file, the ACP protocol, or the custom status-line JSON — so it is
 * scraped here.
 *
 * The booted TUI is kept alive and reused between captures (one long-lived warm
 * probe rather than a throwaway per refresh), and its process is admitted
 * against the shared budget so it no longer competes unfairly with the warm
 * pool. IO/timing only; excluded from coverage like other adapters.
 */
export function createPtyPlanUsageProbe(
  deps: PtyPlanUsageProbeDeps,
): ManagedPlanUsageProbe {
  const timeoutMs = deps.timeoutMs ?? 45000;
  const bootMs = deps.bootMs ?? 3000;
  const retryMs = deps.retryMs ?? 4000;
  const admitWaitMs = deps.admitWaitMs ?? 20000;

  let live: LiveProbe | null = null;
  let capturing = 0;
  let stopped = false;
  const admissions = new Set<AbortController>();

  const disposeLive = (): void => {
    const current = live;
    live = null;
    if (!current) {
      return;
    }
    current.alive = false;
    try {
      current.proc.kill();
    } catch {
      // best effort — process may already be gone
    }
  };

  const acquirePermit = async (): Promise<ProcessPermit | null | 'denied'> => {
    if (!deps.admission) {
      return null;
    }
    const warm = deps.admission.tryAcquireWarm();
    if (warm) {
      return warm;
    }
    const controller = new AbortController();
    admissions.add(controller);
    const timer = setTimeout(() => controller.abort(), admitWaitMs);
    timer.unref?.();
    try {
      return await deps.admission.acquireCold(controller.signal);
    } catch {
      return 'denied';
    } finally {
      clearTimeout(timer);
      admissions.delete(controller);
    }
  };

  const spawnLive = async (): Promise<LiveProbe | null> => {
    const execution = deps.acquireExecution?.() ?? null;
    let permit: ProcessPermit | null = null;
    let proc: PtyProcess;
    try {
      const admitted = await acquirePermit();
      if (admitted === 'denied') {
        execution?.release();
        return null;
      }
      permit = admitted;
      if (stopped) {
        permit?.release();
        execution?.release();
        return null;
      }
      const command = deps.resolveCommand();
      proc = deps.spawner.spawn({
        command: command.command,
        args: command.args,
        env: deps.env,
        cwd: deps.cwd,
        cols: 140,
        rows: 45,
      });
    } catch (error) {
      permit?.release();
      execution?.release();
      throw error;
    }
    const created: LiveProbe = { proc, permit, execution, buffer: '', alive: true };
    proc.onData((data) => {
      created.buffer += data;
    });
    proc.onExit(() => {
      created.alive = false;
      created.permit?.release();
      created.permit = null;
      created.execution?.release();
      created.execution = null;
      if (live === created) {
        live = null;
      }
    });
    if (created.alive) live = created;
    permit?.onRetire(() => {
      if (live === created) {
        disposeLive();
      }
    });
    // Let a freshly spawned TUI boot before it can render `/usage`.
    await new Promise<void>((resolve) => {
      const boot = setTimeout(resolve, bootMs);
      boot.unref?.();
    });
    return created.alive ? created : null;
  };

  const scrape = (current: LiveProbe): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      let settled = false;
      // Scope the capture to output produced from this `/usage` onward so a
      // reused session yields the fresh panel, not a stale earlier render.
      current.buffer = '';

      const finish = (result: string | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(retry);
        clearTimeout(deadline);
        clearInterval(poll);
        if (result === null) {
          // A failed capture may mean a wedged TUI; drop it so the next
          // capture respawns a clean one.
          disposeLive();
        }
        resolve(result);
      };

      const tryParse = (): void => {
        if (!current.alive) {
          finish(null);
        } else if (parsePlanUsage(current.buffer, '') !== null) {
          finish(current.buffer);
        }
      };

      const ask = (): void => {
        if (!current.alive) {
          finish(null);
          return;
        }
        try {
          current.proc.write(`${deps.usageCommand?.() ?? '/usage'}\r`);
        } catch {
          finish(null);
        }
      };

      const deadline = setTimeout(() => {
        finish(parsePlanUsage(current.buffer, '') ? current.buffer : null);
      }, timeoutMs);
      deadline.unref?.();
      const retry = setInterval(ask, retryMs);
      retry.unref?.();
      const poll = setInterval(tryParse, 250);
      poll.unref?.();

      ask();
    });

  return {
    async capture() {
      if (stopped) return null;
      capturing += 1;
      try {
        if (!live || !live.alive) {
          live = await spawnLive();
        }
        if (!live) return null;
        return await scrape(live);
      } finally {
        capturing -= 1;
      }
    },
    isCapturing: () => capturing > 0,
    stop() {
      if (capturing > 0) throw new ConflictError('The quota probe is still capturing; wait for it to finish');
      stopped = true;
      disposeLive();
    },
    shutdown() {
      stopped = true;
      for (const controller of admissions) controller.abort();
      disposeLive();
    },
  };
}

import type { Clock } from '../../kernel/clock.js';

/** Lifecycle phases of a spawned CLI process. */
export type ProcessPhase = 'starting' | 'running' | 'exited';

export interface ProcessLifecycleSnapshot {
  phase: ProcessPhase;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
}

/**
 * Tracks the lifecycle of a single spawned process: when it started running,
 * when it exited, and with what code. Time comes from an injected clock.
 */
export class ProcessLifecycle {
  private phase: ProcessPhase = 'starting';
  private startedAt?: string;
  private endedAt?: string;
  private exitCode?: number | null;

  constructor(private readonly clock: Clock) {}

  markRunning(): void {
    if (this.phase !== 'starting') {
      return;
    }
    this.phase = 'running';
    this.startedAt = this.clock.isoNow();
  }

  markExited(code: number | null): void {
    if (this.phase === 'exited') {
      return;
    }
    this.phase = 'exited';
    this.exitCode = code;
    this.endedAt = this.clock.isoNow();
  }

  snapshot(): ProcessLifecycleSnapshot {
    return {
      phase: this.phase,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      exitCode: this.exitCode,
    };
  }
}

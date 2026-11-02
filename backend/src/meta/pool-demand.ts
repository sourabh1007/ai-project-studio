/**
 * Warm-pool demand telemetry. Every meta AI turn — whether it lands on a warm
 * session or spills to the cold path — is counted so the Settings page can
 * suggest how many warm sessions to keep based on *observed* peak concurrency
 * rather than a guess.
 *
 * A turn `begin()`s when it starts and `end()`s when it finishes; the tracker
 * records the instantaneous concurrency at each start into a rolling time
 * window. {@link PoolDemandTracker.suggestion} is the peak concurrency seen in
 * that window (clamped to `[1, maxSize]`), i.e. the smallest warm size that
 * would have served every request warm during the busiest recent moment.
 */
export interface DemandTrackerConfig {
  /** Clock for sample timestamps. */
  now: () => number;
  /** Rolling window (ms) over which peak demand is measured. */
  windowMs: number;
  /** Upper bound for a suggestion, so telemetry can't propose absurd sizes. */
  maxSize: number;
}

interface DemandSample {
  at: number;
  demand: number;
}

/** Tracks concurrent demand for the shared warm pool over a rolling window. */
export class PoolDemandTracker {
  private readonly samples: DemandSample[] = [];
  private head = 0;
  private current = 0;

  constructor(private readonly config: DemandTrackerConfig) {}

  /** A turn started. */
  begin(): void {
    this.current += 1;
    const at = this.config.now();
    this.prune(at);
    const demand = Math.min(this.current, this.config.maxSize);
    // A newer equal/higher peak dominates older samples until they expire.
    while (this.samples.length > this.head && this.samples[this.samples.length - 1].demand <= demand) {
      this.samples.pop();
    }
    this.samples.push({ at, demand });
  }

  /** A turn finished (success or failure). */
  end(): void {
    if (this.current > 0) {
      this.current -= 1;
    }
  }

  /** Turns currently in flight. */
  get inFlight(): number {
    return this.current;
  }

  /**
   * Suggested warm size: the peak concurrency observed within the window (never
   * below the current in-flight count), clamped to `[1, maxSize]`.
   */
  suggestion(): number {
    this.prune(this.config.now());
    const peak = Math.max(this.current, this.samples[this.head]?.demand ?? 0);
    return Math.min(this.config.maxSize, Math.max(1, peak));
  }

  private prune(now: number): void {
    const cutoff = now - this.config.windowMs;
    while (this.head < this.samples.length && this.samples[this.head].at < cutoff) {
      this.head += 1;
    }
    if (this.head > 0 && this.head * 2 >= this.samples.length) {
      this.samples.splice(0, this.head);
      this.head = 0;
    }
  }
}

/**
 * Structural port for demand telemetry. Consumers depend on this interface
 * rather than the concrete {@link PoolDemandTracker} (whose private fields
 * would otherwise force callers and tests to build a real instance).
 */
export interface PoolDemandPort {
  /** A turn started. */
  begin(): void;
  /** A turn finished. */
  end(): void;
  /** Suggested warm size from observed peak concurrency. */
  suggestion(): number;
}

/** Back-compat alias: the tracker *is* the demand registry now there is one pool. */
export type PoolDemand = PoolDemandTracker;

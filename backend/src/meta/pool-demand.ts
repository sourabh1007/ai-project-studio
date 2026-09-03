/**
 * Warm-pool demand telemetry. Every meta AI turn — whether it lands on a warm
 * session or spills to the cold path — is counted per purpose so the Settings
 * page can suggest how many warm sessions to keep based on *observed* peak
 * concurrency rather than a guess.
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

/** Tracks concurrent demand for a single purpose over a rolling window. */
export class PoolDemandTracker {
  private readonly samples: DemandSample[] = [];
  private current = 0;
  private peak = 0;

  constructor(private readonly config: DemandTrackerConfig) {}

  /** A turn for this purpose started. */
  begin(): void {
    this.current += 1;
    if (this.current > this.peak) {
      this.peak = this.current;
    }
    this.samples.push({ at: this.config.now(), demand: this.current });
  }

  /** A turn for this purpose finished (success or failure). */
  end(): void {
    if (this.current > 0) {
      this.current -= 1;
    }
  }

  /** Turns currently in flight for this purpose. */
  get inFlight(): number {
    return this.current;
  }

  /**
   * Suggested warm size: the peak concurrency observed within the window (never
   * below the current in-flight count), clamped to `[1, maxSize]`.
   */
  suggestion(): number {
    this.prune();
    let peak = this.current;
    for (const sample of this.samples) {
      if (sample.demand > peak) {
        peak = sample.demand;
      }
    }
    return Math.min(this.config.maxSize, Math.max(1, peak));
  }

  private prune(): void {
    const cutoff = this.config.now() - this.config.windowMs;
    while (this.samples.length > 0 && this.samples[0].at < cutoff) {
      this.samples.shift();
    }
  }
}

/**
 * Structural port for per-purpose demand telemetry. Consumers depend on this
 * interface rather than the concrete {@link PoolDemand} class (whose private
 * fields would otherwise force callers and tests to build a real instance).
 */
export interface PoolDemandPort {
  /** A turn for `purpose` started. */
  begin(purpose: string): void;
  /** A turn for `purpose` finished. */
  end(purpose: string): void;
  /** Suggested warm size for `purpose` from observed peak concurrency. */
  suggestion(purpose: string): number;
}

/** Registry of per-purpose demand trackers, created lazily on first use. */
export class PoolDemand implements PoolDemandPort {
  private readonly byPurpose = new Map<string, PoolDemandTracker>();

  constructor(private readonly make: () => PoolDemandTracker) {}

  private tracker(purpose: string): PoolDemandTracker {
    let existing = this.byPurpose.get(purpose);
    if (!existing) {
      existing = this.make();
      this.byPurpose.set(purpose, existing);
    }
    return existing;
  }

  /** A turn for `purpose` started. */
  begin(purpose: string): void {
    this.tracker(purpose).begin();
  }

  /** A turn for `purpose` finished. */
  end(purpose: string): void {
    this.tracker(purpose).end();
  }

  /** Suggested warm size for `purpose` from observed peak concurrency. */
  suggestion(purpose: string): number {
    return this.tracker(purpose).suggestion();
  }
}

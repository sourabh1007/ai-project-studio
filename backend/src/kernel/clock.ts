/** Wall-clock abstraction. Injectable so time-dependent logic is testable. */
export interface Clock {
  now(): Date;
  isoNow(): string;
}

export function createClock(source: () => number = Date.now): Clock {
  return {
    now: () => new Date(source()),
    isoNow: () => new Date(source()).toISOString(),
  };
}

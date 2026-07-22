import type { HrTime } from './otel-record-parser.js';

const MILLIS_PER_SECOND = 1000;
const NANOS_PER_MILLI = 1_000_000;

/** Converts an OTel hrTime tuple [seconds, nanos] to an ISO-8601 timestamp. */
export function hrTimeToIso(time: HrTime): string {
  const [seconds, nanos] = time;
  const millis = seconds * MILLIS_PER_SECOND + Math.floor(nanos / NANOS_PER_MILLI);
  return new Date(millis).toISOString();
}

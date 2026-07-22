/** A single line of the Copilot OTel file exporter, parsed into a typed record. */

export type HrTime = [number, number];

export interface OtelResource {
  attributes: Record<string, unknown>;
}

export interface OtelSpanRecord {
  kind: 'span';
  name: string;
  startTime: HrTime;
  endTime: HrTime;
  attributes: Record<string, unknown>;
  resource: OtelResource;
}

export interface OtelMetricRecord {
  kind: 'metric';
  name: string;
  dataPoints: unknown[];
}

export interface OtelOtherRecord {
  kind: 'other';
}

export type OtelRecord = OtelSpanRecord | OtelMetricRecord | OtelOtherRecord;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function asHrTime(value: unknown): HrTime {
  return Array.isArray(value) && value.length === 2
    ? [Number(value[0]) || 0, Number(value[1]) || 0]
    : [0, 0];
}

/**
 * Parses one JSONL line into a typed OTel record. Returns null for blank or
 * malformed lines so the reader/tailer is resilient to partial writes.
 */
export function parseOtelLine(line: string): OtelRecord | null {
  const trimmed = line.trim();
  if (trimmed === '') {
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') {
    return null;
  }
  const record = obj as Record<string, unknown>;
  if (record.type === 'span') {
    const resource = asRecord(record.resource);
    return {
      kind: 'span',
      name: String(record.name ?? ''),
      startTime: asHrTime(record.startTime),
      endTime: asHrTime(record.endTime),
      attributes: asRecord(record.attributes),
      resource: { attributes: asRecord(resource.attributes) },
    };
  }
  if (record.type === 'metric') {
    return {
      kind: 'metric',
      name: String(record.name ?? ''),
      dataPoints: Array.isArray(record.dataPoints) ? record.dataPoints : [],
    };
  }
  return { kind: 'other' };
}

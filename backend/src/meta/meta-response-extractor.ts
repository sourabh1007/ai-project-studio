import type { Transcript } from '../session/transcript-capture.js';

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function directResponse(
  record: Record<string, unknown>,
  responseTextKeys: readonly string[],
): string | null {
  for (const key of responseTextKeys) {
    const found = readString(record, key);
    if (found !== null) return found;
  }
  return null;
}

function eventContent(record: Record<string, unknown>): string | null {
  const data = asRecord(record.data);
  if (!data) return null;
  return (
    readString(data, 'content') ??
    readString(data, 'delta') ??
    readString(data, 'message')
  );
}

function eventDelta(record: Record<string, unknown>): string | null {
  const data = asRecord(record.data);
  if (!data) return null;
  for (const key of ['content', 'delta', 'message']) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function isDeltaEvent(type: unknown): boolean {
  return (
    type === 'assistant.message_delta' ||
    type === 'assistant.message.delta' ||
    type === 'message.delta'
  );
}

/**
 * Extracts the assistant's response text from a meta session transcript. The
 * CLI emits either one legacy JSON object or an NDJSON event stream when
 * `--output-format json` is set. Telemetry events are never returned as text.
 */
export function extractResponseText(
  transcript: Transcript | null,
  responseTextKeys: readonly string[],
): string {
  if (!transcript) {
    return '';
  }
  const raw = transcript.stdout.join('\n').trim();
  if (raw.length === 0) {
    return '';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const records: Record<string, unknown>[] = [];
    let hasJsonEvent = false;
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      try {
        const record = asRecord(JSON.parse(line));
        if (record) {
          records.push(record);
          if (typeof record.type === 'string') hasJsonEvent = true;
        }
      } catch {
        // A provider may mix diagnostics with NDJSON; ignore them once events exist.
      }
    }
    if (!hasJsonEvent) return raw;

    let finalMessage: string | null = null;
    const deltas: string[] = [];
    for (const record of records) {
      if (record.type === 'assistant.message') {
        finalMessage = eventContent(record);
      } else if (isDeltaEvent(record.type)) {
        const delta = eventDelta(record);
        if (delta !== null) deltas.push(delta);
      }
    }
    return finalMessage ?? deltas.join('');
  }

  const record = asRecord(parsed);
  if (!record) {
    return raw;
  }
  const direct = directResponse(record, responseTextKeys);
  if (direct !== null) {
    return direct;
  }
  if (record.type === 'assistant.message') {
    return eventContent(record) ?? '';
  }
  if (isDeltaEvent(record.type)) {
    return eventDelta(record) ?? '';
  }
  return typeof record.type === 'string' ? '' : raw;
}

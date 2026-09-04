/**
 * Wire protocol for the terminal WebSocket. Pure (de)serialization so both the
 * server and the browser client can share the exact same framing rules and it
 * stays trivially unit-testable. Transport (ws) lives in the excluded adapter.
 */

export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type ServerMessage =
  | { type: 'ready'; sessionId: string }
  | { type: 'output'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'exit'; code: number | null };

/** Serializes a server->client message to a WebSocket text frame. */
export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parses a raw client frame into a validated {@link ClientMessage}, or null if
 * the frame is malformed or of an unknown type. Never throws.
 */
export function decodeClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  if (parsed.type === 'input') {
    return typeof parsed.data === 'string'
      ? { type: 'input', data: parsed.data }
      : null;
  }
  if (parsed.type === 'resize') {
    return typeof parsed.cols === 'number' && typeof parsed.rows === 'number'
      ? { type: 'resize', cols: parsed.cols, rows: parsed.rows }
      : null;
  }
  return null;
}

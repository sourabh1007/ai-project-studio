/**
 * Browser-side mirror of the terminal wire protocol. Encodes client->server
 * frames (input, resize) and decodes server->client frames (ready, output,
 * exit). Pure so it is fully unit-testable without a real WebSocket.
 */

export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type ServerMessage =
  | { type: 'ready'; sessionId: string }
  | { type: 'output'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'exit'; code: number | null };

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Parses a raw server frame into a validated message, or null if malformed. */
export function decodeServerMessage(raw: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  if (parsed.type === 'ready') {
    return typeof parsed.sessionId === 'string'
      ? { type: 'ready', sessionId: parsed.sessionId }
      : null;
  }
  if (parsed.type === 'output') {
    return typeof parsed.data === 'string'
      ? { type: 'output', data: parsed.data }
      : null;
  }
  if (parsed.type === 'resize') {
    return typeof parsed.cols === 'number' && typeof parsed.rows === 'number'
      ? { type: 'resize', cols: parsed.cols, rows: parsed.rows }
      : null;
  }
  if (parsed.type === 'exit') {
    return typeof parsed.code === 'number' || parsed.code === null
      ? { type: 'exit', code: parsed.code }
      : null;
  }
  return null;
}

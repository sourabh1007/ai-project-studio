/**
 * Wire protocol for the terminal WebSocket. Pure (de)serialization so both the
 * server and the browser client can share the exact same framing rules and it
 * stays trivially unit-testable. Transport (ws) lives in the excluded adapter.
 */

export type ClientMessage =
  | { type: 'worktree-selection'; generation: number; requestId: number; choiceId: string | null }
  | { type: 'checkout-recovery'; generation: number; requestId: number; approved: boolean }
  | { type: 'ping'; generation: number; seq: number }
  | { type: 'input'; data: string; generation: number; seq: number }
  | { type: 'resize'; cols: number; rows: number; generation: number };

export type TerminalState = 'connecting' | 'bootstrapping' | 'ready' | 'reconnecting' | 'closed' | 'failed';

export type ServerMessage =
  | { type: 'worktree-selection'; requestId: number; choices: { id: string; checkoutPath: string; ref: string }[] }
  | { type: 'checkout-recovery'; requestId: number; detail: string }
  | { type: 'state'; version: 2; generation: number; state: TerminalState; inputLimit: number; detail?: string; heartbeat?: boolean }
  | { type: 'pong'; generation: number; seq: number }
  | { type: 'ack'; seq: number; generation: number; outcome: 'written' | 'rejected' | 'uncertain'; reason: string }
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
  if (!Number.isSafeInteger(parsed.generation) || (parsed.generation as number) < 0) return null;
  if (parsed.type === 'worktree-selection') {
    return Number.isSafeInteger(parsed.requestId) && (parsed.requestId as number) > 0 &&
      (parsed.choiceId === null || (typeof parsed.choiceId === 'string' && parsed.choiceId.length > 0))
      ? { type: 'worktree-selection', generation: parsed.generation as number, requestId: parsed.requestId as number, choiceId: parsed.choiceId }
      : null;
  }
  if (parsed.type === 'checkout-recovery') {
    return Number.isSafeInteger(parsed.requestId) && (parsed.requestId as number) > 0 && typeof parsed.approved === 'boolean'
      ? { type: 'checkout-recovery', generation: parsed.generation as number, requestId: parsed.requestId as number, approved: parsed.approved }
      : null;
  }
  if (parsed.type === 'ping') {
    return Number.isSafeInteger(parsed.seq) && (parsed.seq as number) > 0
      ? { type: 'ping', generation: parsed.generation as number, seq: parsed.seq as number } : null;
  }
  if (parsed.type === 'input') {
    return typeof parsed.data === 'string' && Number.isSafeInteger(parsed.seq) && (parsed.seq as number) > 0
      ? { type: 'input', data: parsed.data, generation: parsed.generation as number, seq: parsed.seq as number }
      : null;
  }
  if (parsed.type === 'resize') {
    return Number.isSafeInteger(parsed.cols) && (parsed.cols as number) > 0 &&
      Number.isSafeInteger(parsed.rows) && (parsed.rows as number) > 0
      ? { type: 'resize', cols: parsed.cols as number, rows: parsed.rows as number, generation: parsed.generation as number }
      : null;
  }
  return null;
}

/**
 * Browser-side mirror of the terminal wire protocol. Encodes client->server
 * frames (input, resize) and decodes server->client frames (ready, output,
 * exit). Pure so it is fully unit-testable without a real WebSocket.
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
  if (parsed.type === 'worktree-selection') {
    return Number.isSafeInteger(parsed.requestId) && (parsed.requestId as number) > 0 &&
      Array.isArray(parsed.choices) && parsed.choices.length > 0 &&
      parsed.choices.every((choice) => isRecord(choice) &&
        typeof choice.id === 'string' && choice.id.length > 0 &&
        typeof choice.checkoutPath === 'string' && choice.checkoutPath.length > 0 &&
        typeof choice.ref === 'string' && choice.ref.length > 0)
      ? parsed as ServerMessage : null;
  }
  if (parsed.type === 'checkout-recovery') {
    return Number.isSafeInteger(parsed.requestId) && (parsed.requestId as number) > 0 && typeof parsed.detail === 'string'
      ? { type: 'checkout-recovery', requestId: parsed.requestId as number, detail: parsed.detail }
      : null;
  }
  if (parsed.type === 'state' || parsed.type === 'ack' || parsed.type === 'pong') {
    if (!Number.isSafeInteger(parsed.generation) || (parsed.generation as number) < 0) return null;
    if (parsed.type === 'pong') {
      return Number.isSafeInteger(parsed.seq) && (parsed.seq as number) > 0
        ? { type: 'pong', generation: parsed.generation as number, seq: parsed.seq as number } : null;
    }
    if (parsed.type === 'state') {
      return parsed.version === 2 &&
        ['connecting', 'bootstrapping', 'ready', 'reconnecting', 'closed', 'failed'].includes(parsed.state as string) &&
        Number.isSafeInteger(parsed.inputLimit) && (parsed.inputLimit as number) > 0 &&
        (parsed.heartbeat === undefined || typeof parsed.heartbeat === 'boolean') &&
        (parsed.detail === undefined || typeof parsed.detail === 'string')
        ? parsed as ServerMessage : null;
    }
    return Number.isSafeInteger(parsed.seq) && (parsed.seq as number) > 0 &&
      ['written', 'rejected', 'uncertain'].includes(parsed.outcome as string) && typeof parsed.reason === 'string'
      ? parsed as ServerMessage : null;
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

/**
 * Pure helpers for speaking the Agent Client Protocol (ACP) that the Copilot
 * CLI exposes via `copilot --acp`: newline-delimited JSON-RPC 2.0 over stdio.
 *
 * A single `--acp` process boots once (paying MCP/auth startup) and then serves
 * many turns, which is exactly what the warm metasession pool needs. This module
 * keeps the wire format (encoding requests, classifying incoming messages,
 * pulling assistant text out of streaming updates) as pure functions so the
 * client and pool stay easy to test.
 */

/** A JSON-RPC request line to send to the agent. */
export interface AcpRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

/** A parsed response to one of our requests. */
export interface AcpResponseMessage {
  kind: 'response';
  id: number;
  result: Record<string, unknown> | null;
  error: { code: number; message: string } | null;
}

/** A parsed server-initiated notification (e.g. streaming `session/update`). */
export interface AcpNotification {
  kind: 'notification';
  method: string;
  params: Record<string, unknown> | null;
}

export type AcpIncoming = AcpResponseMessage | AcpNotification;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Encodes a JSON-RPC request as a single newline-terminated line. */
export function encodeRequest(
  id: number,
  method: string,
  params: unknown,
): string {
  const request: AcpRequest = { jsonrpc: '2.0', id, method, params };
  return `${JSON.stringify(request)}\n`;
}

/**
 * Parses one incoming line into a typed message, or null when the line is not a
 * JSON-RPC message we care about (blank lines, plain diagnostics, or JSON that
 * is neither a response with a numeric id nor a notification with a method).
 */
export function parseMessage(line: string): AcpIncoming | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record) {
    return null;
  }
  if (typeof record.id === 'number') {
    return {
      kind: 'response',
      id: record.id,
      result: asRecord(record.result),
      error: parseError(record.error),
    };
  }
  if (typeof record.method === 'string') {
    return {
      kind: 'notification',
      method: record.method,
      params: asRecord(record.params),
    };
  }
  return null;
}

function parseError(
  value: unknown,
): { code: number; message: string } | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const code = typeof record.code === 'number' ? record.code : -1;
  const message =
    typeof record.message === 'string' ? record.message : 'ACP error';
  return { code, message };
}

/**
 * Extracts the assistant text carried by a `session/update` notification's
 * `agent_message_chunk` payload, or null for any other update kind. Chunks
 * arrive incrementally, so callers concatenate the non-null results to rebuild
 * the full response.
 */
export function textFromUpdate(
  params: Record<string, unknown> | null,
): string | null {
  const update = asRecord(params?.update);
  if (!update || update.sessionUpdate !== 'agent_message_chunk') {
    return null;
  }
  const content = asRecord(update.content);
  if (!content || content.type !== 'text') {
    return null;
  }
  return typeof content.text === 'string' ? content.text : null;
}

/** The stop reason reported by a completed `session/prompt` turn. */
export function stopReasonOf(
  result: Record<string, unknown> | null,
): string | null {
  const reason = result?.stopReason;
  return typeof reason === 'string' ? reason : null;
}

/** Pulls the new session id out of a `session/new` result. */
export function sessionIdOf(
  result: Record<string, unknown> | null,
): string | null {
  const id = result?.sessionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

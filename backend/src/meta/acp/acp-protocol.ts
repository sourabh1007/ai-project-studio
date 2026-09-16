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

/**
 * A parsed agent-initiated request that expects a response from us (the
 * client). The prime example is `session/request_permission`, which an agent
 * sends before a tool call (e.g. writing a file) and then blocks on until we
 * reply. It carries both a numeric `id` (like a response) and a `method` (like
 * a notification), so it must be classified before the response branch.
 */
export interface AcpAgentRequest {
  kind: 'request';
  id: number;
  method: string;
  params: Record<string, unknown> | null;
}

export type AcpIncoming =
  | AcpResponseMessage
  | AcpNotification
  | AcpAgentRequest;

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

/** Encodes a JSON-RPC notification as a single newline-terminated line. */
export function encodeNotification(method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;
}

/** Encodes a successful JSON-RPC response to an agent-initiated request. */
export function encodeResult(id: number, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
}

/** Encodes a JSON-RPC error response to an agent-initiated request. */
export function encodeError(
  id: number,
  code: number,
  message: string,
): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`;
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
  const hasId = typeof record.id === 'number';
  const hasMethod = typeof record.method === 'string';
  // An agent-initiated request carries BOTH an id and a method. It must be
  // classified before the response branch below, which only checks the id —
  // otherwise a `session/request_permission` request looks like a response to
  // a request we never sent, gets dropped, and the agent blocks forever.
  if (hasId && hasMethod) {
    return {
      kind: 'request',
      id: record.id as number,
      method: record.method as string,
      params: asRecord(record.params),
    };
  }
  if (hasId) {
    return {
      kind: 'response',
      id: record.id as number,
      result: asRecord(record.result),
      error: parseError(record.error),
    };
  }
  if (hasMethod) {
    return {
      kind: 'notification',
      method: record.method as string,
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

function updateOf(
  params: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const nested = asRecord(params?.update);
  return nested ?? params;
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
  const update = updateOf(params);
  if (!update || update.sessionUpdate !== 'agent_message_chunk') {
    return null;
  }
  const content = asRecord(update.content);
  if (!content || content.type !== 'text') {
    return null;
  }
  return typeof content.text === 'string' ? content.text : null;
}

/**
 * Extracts the incremental reasoning text from an `agent_thought_chunk`
 * `session/update`, or null for any other update kind. Like message text,
 * thoughts arrive in chunks, so callers buffer them into whole lines before
 * surfacing them as live "thinking" activity — kept separate from the returned
 * response text.
 */
export function thoughtFromUpdate(
  params: Record<string, unknown> | null,
): string | null {
  const update = updateOf(params);
  if (!update || update.sessionUpdate !== 'agent_thought_chunk') {
    return null;
  }
  const content = asRecord(update.content);
  if (!content || content.type !== 'text') {
    return null;
  }
  return typeof content.text === 'string' ? content.text : null;
}

/**
 * Formats a discrete `tool_call` `session/update` (the agent reading/writing a
 * file, running a command, etc.) into a single, human-readable activity line,
 * or null for any other update kind. This is what makes the planning phase —
 * which is mostly tool use and reasoning rather than streamed prose — legible
 * instead of a silent wait.
 */
export function noticeFromUpdate(
  params: Record<string, unknown> | null,
): string | null {
  const update = updateOf(params);
  if (!update || update.sessionUpdate !== 'tool_call') {
    return null;
  }
  const title =
    typeof update.title === 'string' && update.title.trim().length > 0
      ? update.title.trim()
      : 'Working…';
  return `🔧 ${title}`;
}

/**
 * Picks the option that GRANTS an agent's `session/request_permission` request
 * so an autonomous turn (New Task planning/implementation) can proceed without
 * a human at the keyboard. Prefers a durable "always allow" so the same turn is
 * not re-prompted for every file write, then a one-time allow, then any option
 * whose kind grants, and finally the first offered option so we always send a
 * decisive reply rather than leaving the agent blocked. Returns null only when
 * the request carries no usable options.
 */
export function selectPermissionOption(
  params: Record<string, unknown> | null,
): string | null {
  const raw = Array.isArray(params?.options) ? params.options : [];
  const options = raw
    .map((option) => asRecord(option))
    .filter((option): option is Record<string, unknown> => option !== null)
    .map((option) => ({
      optionId: typeof option.optionId === 'string' ? option.optionId : null,
      kind: typeof option.kind === 'string' ? option.kind : '',
    }))
    .filter(
      (option): option is { optionId: string; kind: string } =>
        option.optionId !== null,
    );
  if (options.length === 0) {
    return null;
  }
  const byKind = (kind: string): string | null =>
    options.find((option) => option.kind === kind)?.optionId ?? null;
  return (
    byKind('allow_always') ??
    byKind('allow_once') ??
    options.find((option) => option.kind.startsWith('allow'))?.optionId ??
    options[0].optionId
  );
}

/** The stop reason reported by a completed `session/prompt` turn. */
export function stopReasonOf(
  result: Record<string, unknown> | null,
): string | null {
  const reason = result?.stopReason;
  return typeof reason === 'string' ? reason : null;
}

/** Pulls the notification's session id out of a `session/update` payload. */
export function sessionIdFromUpdate(
  params: Record<string, unknown> | null,
): string | null {
  const sessionId = params?.sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0
    ? sessionId
    : null;
}

/** Reads a `state_update` notification's state and stop reason defensively. */
export function stateFromUpdate(
  params: Record<string, unknown> | null,
): { state: string; stopReason: string | null } | null {
  const update = updateOf(params);
  if (!update || update.sessionUpdate !== 'state_update') {
    return null;
  }
  const state = update.state;
  if (typeof state !== 'string' || state.length === 0) {
    return null;
  }
  return {
    state,
    stopReason: typeof update.stopReason === 'string' ? update.stopReason : null,
  };
}

/** Pulls the new session id out of a `session/new` result. */
export function sessionIdOf(
  result: Record<string, unknown> | null,
): string | null {
  const id = result?.sessionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

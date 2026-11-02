export function claudeRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

export function parseClaudeLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return claudeRecord(value);
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export type ClaudeCharge =
  | { status: 'estimated'; unit: 'USD'; amount: number; scope: 'session' }
  | { status: 'unavailable' };

export interface ClaudeUsageSample {
  sourceId: string;
  nativeSessionId: string;
  nativeMessageId: string;
  scope: 'message' | 'session';
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  charge: ClaudeCharge;
}

/** Result usage is cumulative; never add it to per-message samples. */
export function parseClaudeUsage(line: string): ClaudeUsageSample | null {
  const record = parseClaudeLine(line);
  if (!record || (record.type !== 'assistant' && record.type !== 'result')) return null;
  const sessionId = text(record.session_id) ?? text(record.sessionId);
  const message = claudeRecord(record.message);
  const result = record.type === 'result';
  const id = result ? text(record.uuid) : text(message?.id);
  const usage = claudeRecord(result ? record.usage : message?.usage);
  if (!sessionId || !id || !usage) return null;
  const usd = result ? amount(record.total_cost_usd) : null;
  return {
    sourceId: `claude:${sessionId}:${result ? 'result' : 'message'}:${id}`,
    nativeSessionId: sessionId,
    nativeMessageId: id,
    scope: result ? 'session' : 'message',
    model: text(message?.model) ?? text(record.model),
    inputTokens: amount(usage.input_tokens),
    outputTokens: amount(usage.output_tokens),
    cacheReadTokens: amount(usage.cache_read_input_tokens),
    cacheWriteTokens: amount(usage.cache_creation_input_tokens),
    charge: usd === null ? { status: 'unavailable' } : { status: 'estimated', unit: 'USD', amount: usd, scope: 'session' },
  };
}

export interface ClaudeHistoryRecord {
  nativeSessionId: string;
  nativeMessageId: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  cwd: string | null;
  model: string | null;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const block = claudeRecord(item);
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

export interface ClaudeParseLimits {
  maxBytes: number;
  maxRecords: number;
}

/** Call only with bounded worker-read input, never whole repositories in HTTP. */
export function parseClaudeHistory(
  jsonl: string,
  limits: ClaudeParseLimits = { maxBytes: 4 * 1024 * 1024, maxRecords: 10_000 },
): ClaudeHistoryRecord[] {
  if (Buffer.byteLength(jsonl, 'utf8') > limits.maxBytes) throw new Error('Claude history exceeds byte limit');
  const records: ClaudeHistoryRecord[] = [];
  const seen = new Set<string>();
  const lines = jsonl.split(/\r?\n/);
  if (lines.length > limits.maxRecords) throw new Error('Claude history exceeds record limit');
  for (const line of lines) {
    const record = parseClaudeLine(line);
    if (!record || (record.type !== 'user' && record.type !== 'assistant') || record.isMeta === true) continue;
    const sessionId = text(record.sessionId) ?? text(record.session_id);
    const message = claudeRecord(record.message);
    const id = text(record.uuid) ?? text(message?.id);
    if (!sessionId || !id || !message) continue;
    const key = `${sessionId}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const body = contentText(message.content);
    if (!body) continue;
    records.push({
      nativeSessionId: sessionId,
      nativeMessageId: id,
      role: record.type,
      text: body,
      timestamp: text(record.timestamp) ?? '',
      cwd: text(record.cwd),
      model: text(message.model),
    });
  }
  return records;
}

export function claudeResultText(line: string): string | null {
  const record = parseClaudeLine(line);
  return record?.type === 'result' && record.is_error !== true ? text(record.result) : null;
}

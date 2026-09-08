import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { UsageEvent } from '../../usage/usage-contract.js';
import type { UsageCaptureRead } from '../../usage/usage-capture-contract.js';

export interface CliUsageStoreDeps {
  /** Absolute path to the CLI's session-store.db. */
  databasePath: string;
}

/** One inference request the CLI recorded in `assistant_usage_events`. */
export interface CliUsageRow {
  sessionId: string;
  /** Snapshot-local ordinal. Durable capture assigns identities in its own ledger. */
  turnIndex: number;
  /** Model actually used for the request, if the CLI recorded one. */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Raw AI usage units in nano-AIU the CLI charged for the request. */
  totalNanoAiu: number;
  /** Premium-request multiplier the CLI applied to the request. */
  requestMultiplier: number | null;
  createdAt: string;
}

interface RawUsageRow {
  id: number;
  session_id: string;
  model: string | null;
  input_tokens: number | bigint | null;
  output_tokens: number | bigint | null;
  reasoning_tokens: number | bigint | null;
  total_nano_aiu: number | bigint | null;
  request_multiplier: number | null;
  created_at: string;
}

/** Nano-AIU per AI credit (AIC), matching the vendor CLI's own conversion. */
const NANO_AIU_PER_AIC = 1_000_000_000;

/** Provider-neutral context needed to attribute a CLI usage row to a Session. */
export interface CliUsageContext {
  featureId: string;
  provider: string;
  requestedModel: string;
}

/**
 * Reads the per-request usage the Copilot/Agency CLI records in its own
 * `session-store.db` (`assistant_usage_events`), keyed by session id. Because
 * every workspace session launches the CLI with `--session-id <ourId>`, the
 * CLI's rows are already attributed to our Session. Opens the store read-only
 * per call. Absence, unavailable cost, locks and schema drift are NOT empty
 * successful captures. The provider does not expose an authoritative finality
 * marker, so even an exhausted scan remains recoverable.
 */
export interface CliUsageStore {
  readonly sourceId: string;
  available(): boolean;
  /** Legacy full snapshot reader; never use its ordinals as capture checkpoints. */
  listBySession(sessionId: string): CliUsageRow[];
  /**
   * Bounds returned/materialized rows using keyset pagination. Without a
   * provider change journal, corrections require repeated full scan cycles.
   * SQLite scan cost still depends on provider-owned indexes; we never add one
   * to somebody else's database.
   */
  readUsagePage(sessionId: string, context: CliUsageContext, cursor: string | null, limit: number): UsageCaptureRead;
}

export function createCliUsageStore(deps: CliUsageStoreDeps): CliUsageStore {
  const sourceId = resolve(deps.databasePath);
  function raw(sessionId: string, cursor: string | null, limit: number): RawUsageRow[] {
    if (!existsSync(deps.databasePath)) {
      throw new CliUsageReadError('retrying', 'source-missing');
    }
    const db = new DatabaseSync(deps.databasePath, { readOnly: true });
    try {
      // The CLI records a row per inference, including nested `sub-agent`
      // requests (identified by a non-null `parent_tool_call_id`). Its own
      // per-session "AIC used" figure counts only the primary agent's turns, so
      // we exclude sub-agent rows to keep our session meter in lockstep with the
      // CLI. Guarded by a column check so older CLI schemas still work.
      const columns = db
        .prepare(`PRAGMA table_info(assistant_usage_events)`)
        .all() as { name: string; type: string; pk: number }[];
      if (columns.length === 0) throw new CliUsageReadError('retrying', 'source-not-ready');
      const required = ['session_id', 'model', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'total_nano_aiu', 'created_at'];
      if (!columns.some((c) => c.name === 'id' && c.type.toUpperCase() === 'INTEGER' && c.pk === 1)
        || required.some((name) => !columns.some((c) => c.name === name))) {
        throw new CliUsageReadError('unsupported', 'source-schema-unsupported');
      }
      const hasParent = columns.some((c) => c.name === 'parent_tool_call_id');
      const multiplier = columns.some((c) => c.name === 'request_multiplier') ? 'request_multiplier' : 'NULL AS request_multiplier';
      const parentFilter = hasParent ? ' AND parent_tool_call_id IS NULL' : '';
      const result = db
        .prepare(
          `SELECT id, session_id, model, input_tokens, output_tokens,
                  reasoning_tokens, total_nano_aiu, ${multiplier},
                  created_at
             FROM assistant_usage_events
             WHERE session_id = ?${parentFilter}${cursor === null ? '' : ' AND id > ?'}
             ORDER BY id ASC LIMIT ?`,
        )
        .all(...(cursor === null ? [sessionId, limit] : [sessionId, Number(cursor), limit])) as unknown as RawUsageRow[];
      return result;
    } finally {
      db.close();
    }
  }

  function mapRow(row: RawUsageRow, index: number): CliUsageRow {
    if (!Number.isSafeInteger(row.id) || typeof row.created_at !== 'string' || row.created_at.length === 0) {
      throw new CliUsageReadError('unsupported', 'source-identity-unsupported');
    }
    return {
      sessionId: row.session_id, turnIndex: index, model: row.model,
      inputTokens: toNumber(row.input_tokens), outputTokens: toNumber(row.output_tokens),
      reasoningTokens: toNumber(row.reasoning_tokens),
      totalNanoAiu: toNumber(row.total_nano_aiu),
      requestMultiplier: row.request_multiplier, createdAt: row.created_at,
    };
  }

  return {
    sourceId,
    available() {
      return existsSync(deps.databasePath);
    },
    listBySession(sessionId) {
      return raw(sessionId, null, -1).map(mapRow);
    },
    readUsagePage(sessionId, context, cursor, limit) {
      try {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000
          || (cursor !== null && !/^-?\d+$/.test(cursor))
          || (cursor !== null && !Number.isSafeInteger(Number(cursor)))) {
          throw new CliUsageReadError('unsupported', 'invalid-capture-cursor');
        }
        const rows = raw(sessionId, cursor, limit + 1);
        const page = rows.slice(0, limit);
        const result: Extract<UsageCaptureRead, { status: 'ready' }> = {
          status: 'ready', sourceId, final: false,
          nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null,
          rows: [],
        };
        for (const row of page) {
          try {
            result.rows.push({
              sourceKey: JSON.stringify([row.id, row.created_at]),
              event: toUsageEvent(mapRow(row, 0), context),
            });
          } catch (error) {
            if (!(error instanceof CliUsageReadError)) throw error;
            result.issue = { status: error.status, reason: error.reason };
          }
        }
        return result;
      } catch (error) {
        if (error instanceof CliUsageReadError) {
          return { status: error.status, sourceId, reason: error.reason };
        }
        const code = error instanceof Error && 'errcode' in error ? error.errcode : null;
        return {
          status: 'retrying', sourceId,
          reason: code === 5 || code === 6 ? 'source-locked' : 'source-read-failed',
        };
      }
    },
  };
}

class CliUsageReadError extends Error {
  constructor(readonly status: 'retrying' | 'unsupported', readonly reason: string) {
    super(reason);
  }
}
/**
 * Maps a CLI usage row onto the canonical {@link UsageEvent} the credit/record
 * pipeline consumes. `cost` is the vendor's AIC figure (nano-AIU ÷ 1e9) so the
 * provider-cost credit strategy yields AIC-denominated credits that match the
 * CLI's own "AIC used" display.
 */
export function toUsageEvent(
  row: CliUsageRow,
  context: CliUsageContext,
): UsageEvent {
  return {
    sessionId: row.sessionId,
    featureId: context.featureId,
    turnIndex: row.turnIndex,
    provider: context.provider,
    requestedModel: context.requestedModel,
    resolvedModel: row.model ?? context.requestedModel,
    operation: 'chat',
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningOutputTokens: row.reasoningTokens,
    cost: row.totalNanoAiu / NANO_AIU_PER_AIC,
    nanoAiu: row.totalNanoAiu,
    serviceRequestId: null,
    startedAt: row.createdAt,
    endedAt: row.createdAt,
  };
}

function toNumber(value: number | bigint | null): number {
  const n = Number(value);
  if (value === null || !Number.isFinite(n) || n < 0) {
    throw new CliUsageReadError('retrying', 'source-values-not-ready');
  }
  return n;
}

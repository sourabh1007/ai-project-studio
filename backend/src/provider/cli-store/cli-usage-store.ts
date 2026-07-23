import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { UsageEvent } from '../../usage/usage-contract.js';

export interface CliUsageStoreDeps {
  /** Absolute path to the CLI's session-store.db. */
  databasePath: string;
}

/** One inference request the CLI recorded in `assistant_usage_events`. */
export interface CliUsageRow {
  sessionId: string;
  /** Stable 0-based ordinal within the session (append-only insertion order). */
  turnIndex: number;
  /** Model actually used for the request, if the CLI recorded one. */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Raw AI usage units in nano-AIU the CLI charged for the request. */
  totalNanoAiu: number;
  /** Premium-request multiplier the CLI applied to the request. */
  requestMultiplier: number;
  createdAt: string;
}

interface RawUsageRow {
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
 * per call (WAL-safe while the CLI keeps writing) and degrades to an empty list
 * on any failure — missing file, lock, schema drift — so live usage capture
 * never breaks the app because of the external store.
 */
export interface CliUsageStore {
  available(): boolean;
  listBySession(sessionId: string): CliUsageRow[];
}

export function createCliUsageStore(deps: CliUsageStoreDeps): CliUsageStore {
  function raw(sessionId: string): RawUsageRow[] {
    if (!existsSync(deps.databasePath)) {
      return [];
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(deps.databasePath, { readOnly: true });
    } catch {
      return [];
    }
    try {
      const result = db
        .prepare(
          `SELECT session_id, model, input_tokens, output_tokens,
                  reasoning_tokens, total_nano_aiu, request_multiplier,
                  created_at
             FROM assistant_usage_events
             WHERE session_id = ?
             ORDER BY id ASC`,
        )
        .all(sessionId) as unknown as RawUsageRow[];
      db.close();
      return result;
    } catch {
      db.close();
      return [];
    }
  }

  return {
    available() {
      return existsSync(deps.databasePath);
    },
    listBySession(sessionId) {
      return raw(sessionId).map((row, index) => ({
        sessionId: row.session_id,
        turnIndex: index,
        model: row.model,
        inputTokens: toNumber(row.input_tokens),
        outputTokens: toNumber(row.output_tokens),
        reasoningTokens: toNumber(row.reasoning_tokens),
        totalNanoAiu: toNumber(row.total_nano_aiu),
        requestMultiplier: toNumber(row.request_multiplier),
        createdAt: row.created_at,
      }));
    },
  };
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
  if (value === null) {
    return 0;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

import type { DatabaseSync } from 'node:sqlite';
import type { UsageCaptureRepo, UsageCaptureState, UsageCaptureStatus } from '../usage/usage-capture-contract.js';
import { UsageCaptureIdentityError, usageCapturePayloadSchema } from '../usage/usage-capture-contract.js';

interface StateRow {
  session_id: string;
  source_id: string;
  cursor: string | null;
  replay_cursor: number | null;
  final_scan: number;
  replay_clean: number;
  source_done: number;
  replay_done: number;
  status: UsageCaptureStatus;
  reason: string | null;
}

function mapState(row: StateRow): UsageCaptureState {
  return {
    sessionId: row.session_id, sourceId: row.source_id, cursor: row.cursor, replayCursor: row.replay_cursor,
    finalScan: row.final_scan === 1, replayClean: row.replay_clean === 1,
    sourceDone: row.source_done === 1, replayDone: row.replay_done === 1,
    status: row.status, reason: row.reason,
  };
}

export function createUsageCaptureRepo(db: DatabaseSync): UsageCaptureRepo {
  const assertAutocommit = (): void => {
    if (db.isTransaction) throw new UsageCaptureIdentityError('capture-transaction-unsupported');
  };
  const state = db.prepare('SELECT * FROM usage_capture_state WHERE session_id = ?');
  const save = db.prepare(`INSERT INTO usage_capture_state
    (session_id, source_id, cursor, replay_cursor, final_scan, replay_clean, source_done, replay_done, status, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET source_id=excluded.source_id,
    cursor=excluded.cursor, replay_cursor=excluded.replay_cursor,
    final_scan=excluded.final_scan, replay_clean=excluded.replay_clean,
    source_done=excluded.source_done, replay_done=excluded.replay_done,
    status=excluded.status, reason=excluded.reason`);
  const unfinished = db.prepare("SELECT * FROM usage_capture_state WHERE status != 'complete' ORDER BY session_id");
  const firstUnfinishedPage = db.prepare(`SELECT * FROM usage_capture_state
    WHERE status != 'complete' ORDER BY session_id COLLATE BINARY LIMIT ?`);
  const nextUnfinishedPage = db.prepare(`SELECT * FROM usage_capture_state
    WHERE status != 'complete' AND session_id COLLATE BINARY > ?
    ORDER BY session_id COLLATE BINARY LIMIT ?`);
  const identity = db.prepare('SELECT turn_index, fingerprint FROM usage_capture_rows WHERE session_id = ? AND source_key = ?');
  const reserve = db.prepare('INSERT INTO usage_capture_rows (session_id, source_key, turn_index, fingerprint, event_payload) VALUES (?, ?, ?, NULL, ?)');
  const stage = db.prepare('UPDATE usage_capture_rows SET event_payload = ? WHERE session_id = ? AND source_key = ? AND event_payload != ?');
  const replay = db.prepare(`SELECT source_key, turn_index, fingerprint, event_payload FROM usage_capture_rows
    WHERE session_id = ? AND turn_index > ? ORDER BY turn_index LIMIT ?`);
  const acknowledge = db.prepare('UPDATE usage_capture_rows SET fingerprint = ? WHERE session_id = ? AND source_key = ?');
  const deleteRows = db.prepare('DELETE FROM usage_capture_rows WHERE session_id = ?');
  const deleteState = db.prepare('DELETE FROM usage_capture_state WHERE session_id = ?');
  const next = db.prepare(`SELECT MAX(
    (SELECT COALESCE(MAX(turn_index), -1) FROM usage_events WHERE session_id = ?),
    (SELECT COALESCE(MAX(turn_index), -1) FROM usage_capture_rows WHERE session_id = ?)) + 1 AS next`);
  // Adopt a pre-watermark record only when its immutable attribution matches.
  // Multiple possible matches are ambiguous: never arbitrarily overwrite one.
  const legacy = db.prepare(`SELECT turn_index FROM usage_events u
    WHERE session_id = ? AND started_at = ?
    AND NOT EXISTS (SELECT 1 FROM usage_capture_rows c
      WHERE c.session_id = u.session_id AND c.turn_index = u.turn_index)
    ORDER BY turn_index LIMIT 2`);

  return {
    get(sessionId) {
      const row = state.get(sessionId) as unknown as StateRow | undefined;
      return row ? mapState(row) : null;
    },
    save(s) {
      assertAutocommit();
      save.run(s.sessionId, s.sourceId, s.cursor, s.replayCursor ?? null,
        s.finalScan ? 1 : 0, s.replayClean ? 1 : 0, s.sourceDone ? 1 : 0, s.replayDone ? 1 : 0,
        s.status, s.reason);
    },
    listUnfinished() { return (unfinished.all() as unknown as StateRow[]).map(mapState); },
    listUnfinishedPage(afterSessionId, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new RangeError('Capture page limit must be an integer between 1 and 1000');
      }
      const rows = (afterSessionId === null
        ? firstUnfinishedPage.all(limit + 1)
        : nextUnfinishedPage.all(afterSessionId, limit + 1)) as unknown as StateRow[];
      const items = rows.slice(0, limit).map(mapState);
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].sessionId : null };
    },
    reserve(sessionId, sourceKey, event) {
      assertAutocommit();
      const known = identity.get(sessionId, sourceKey) as { turn_index: number; fingerprint: string | null } | undefined;
      if (known) {
        const canonical = usageCapturePayloadSchema.parse({ ...event, turnIndex: known.turn_index });
        const payload = JSON.stringify(canonical);
        stage.run(payload, sessionId, sourceKey, payload);
        return { turnIndex: known.turn_index, fingerprint: known.fingerprint, event: canonical };
      }
      const candidates = legacy.all(sessionId, event.startedAt) as { turn_index: number }[];
      if (candidates.length > 1) throw new UsageCaptureIdentityError('legacy-identity-ambiguous');
      const turnIndex = candidates.length === 1
        ? candidates[0].turn_index
        : (next.get(sessionId, sessionId) as { next: number }).next;
      const canonical = usageCapturePayloadSchema.parse({ ...event, turnIndex });
      reserve.run(sessionId, sourceKey, turnIndex, JSON.stringify(canonical));
      return { turnIndex, fingerprint: null, event: canonical };
    },
    listReplay(sessionId, afterTurnIndex, limit) {
      const rows = replay.all(sessionId, afterTurnIndex ?? -1, limit) as {
        source_key: string; turn_index: number; fingerprint: string | null; event_payload: string;
      }[];
      return rows.map((row) => {
        if (row.event_payload === '') {
          return { sourceKey: row.source_key, turnIndex: row.turn_index, fingerprint: row.fingerprint, event: null };
        }
        const event = usageCapturePayloadSchema.parse(JSON.parse(row.event_payload));
        if (event.sessionId !== sessionId || event.turnIndex !== row.turn_index) {
          throw new UsageCaptureIdentityError('capture-payload-identity-mismatch');
        }
        return { sourceKey: row.source_key, turnIndex: row.turn_index, fingerprint: row.fingerprint, event };
      });
    },
    acknowledge(sessionId, sourceKey, fingerprint) { assertAutocommit(); acknowledge.run(fingerprint, sessionId, sourceKey); },
    deleteBySession(sessionId) {
      deleteRows.run(sessionId);
      deleteState.run(sessionId);
    },
  };
}

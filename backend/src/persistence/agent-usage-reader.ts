import type { DatabaseSync } from 'node:sqlite';
import type { AgentUsageReader } from '../agents/agent-usage-reader-port.js';

interface UsageRow {
  usage_json: string | null;
}

interface UsageSnapshot {
  credits: number | null;
  nanoAiu: number | null;
}

function parseSnapshot(raw: string | null): UsageSnapshot | null {
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw) as Partial<UsageSnapshot>;
  return {
    credits: typeof parsed.credits === 'number' ? parsed.credits : null,
    nanoAiu: typeof parsed.nanoAiu === 'number' ? parsed.nanoAiu : null,
  };
}

/**
 * Reads per-agent usage from the `meta_operations` ledger, aggregating the
 * completed, usage-recorded operations tagged with an agent's `usageLabel`.
 * Each operation is one logical AI run, so counting rows yields the run count
 * and summing the usage snapshot yields the totals to average over.
 */
export function createAgentUsageReader(db: DatabaseSync): AgentUsageReader {
  const select = db.prepare(
    `SELECT usage_json FROM meta_operations
     WHERE label = ? AND state = 'completed' AND usage_state = 'recorded'`,
  );
  return {
    aggregateByLabel(label) {
      const rows = select.all(label) as unknown as UsageRow[];
      let runs = 0;
      let credits = 0;
      let creditsSeen = false;
      let nanoAiu = 0;
      let nanoSeen = false;
      for (const row of rows) {
        runs += 1;
        const snapshot = parseSnapshot(row.usage_json);
        if (!snapshot) {
          continue;
        }
        if (snapshot.credits !== null) {
          credits += snapshot.credits;
          creditsSeen = true;
        }
        if (snapshot.nanoAiu !== null) {
          nanoAiu += snapshot.nanoAiu;
          nanoSeen = true;
        }
      }
      return {
        credits: creditsSeen ? credits : null,
        nanoAiu: nanoSeen ? nanoAiu : null,
        runs,
      };
    },
  };
}

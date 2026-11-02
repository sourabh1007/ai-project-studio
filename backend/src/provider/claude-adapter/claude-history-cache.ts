import type { CopilotHistoryReader, SessionHistory, SessionPrompt } from '../../copilot-history/copilot-history-contract.js';
import type { ImportableSession } from '../provider-contract.js';
import type { ClaudeConfig } from './config.js';
import { parseClaudeHistory, parseClaudeUsage, type ClaudeHistoryRecord, type ClaudeUsageSample } from './claude-protocol.js';

export interface ClaudeHistoryFile {
  /** Discovered path under projects/<project>/<session>.jsonl, never inferred. */
  path: string;
  jsonl: string;
}

export interface ClaudeHistoryDiscovery {
  /** Must bound directory traversal, byte reads and execution off the API loop. */
  read(request: { directory: string; maxSessions: number; maxBytes: number; signal: AbortSignal }): Promise<ClaudeHistoryFile[]>;
}

export interface ClaudeHistoryCache extends CopilotHistoryReader {
  refresh(signal: AbortSignal): Promise<void>;
  listImportable(): ImportableSession[];
  readUsagePage(sessionId: string, cursor: string | null, limit: number): {
    samples: readonly ClaudeUsageSample[];
    nextCursor: string | null;
    highWaterCursor: string | null;
  } | null;
  snapshot(): ClaudeHistorySnapshot;
  replace(snapshot: ClaudeHistorySnapshot): void;
}

export interface ClaudeHistorySnapshot {
  sessions: [string, ClaudeHistoryRecord[]][];
  usage: [string, ClaudeUsageSample[]][] | null;
}

export function createClaudeHistoryCache(config: ClaudeConfig, discovery?: ClaudeHistoryDiscovery): ClaudeHistoryCache {
  let sessions = new Map<string, ClaudeHistoryRecord[]>();
  let usage: Map<string, ClaudeUsageSample[]> | null = null;
  return {
    snapshot() {
      return { sessions: [...sessions], usage: usage === null ? null : [...usage] };
    },
    replace(snapshot) {
      sessions = new Map(snapshot.sessions);
      usage = snapshot.usage === null ? null : new Map(snapshot.usage);
    },
    async refresh(signal) {
      if (!discovery) throw new Error('Native history must be refreshed in a worker');
      const files = await discovery.read({
        directory: config.historyDirectory,
        maxSessions: config.historyMaxSessions,
        maxBytes: config.historyMaxBytes,
        signal,
      });
      if (signal.aborted) return;
      if (files.length > config.historyMaxSessions) throw new Error('Claude history exceeds session limit');
      const next = new Map<string, ClaudeHistoryRecord[]>();
      const nextUsage = new Map<string, Map<string, ClaudeUsageSample>>();
      let bytes = 0;
      for (const file of files) {
        bytes += Buffer.byteLength(file.jsonl, 'utf8');
        if (bytes > config.historyMaxBytes) throw new Error('Claude history exceeds total byte limit');
        for (const record of parseClaudeHistory(file.jsonl, {
          maxBytes: config.historyMaxBytes,
          maxRecords: config.historyMaxRecords,
        })) {
          const entries = next.get(record.nativeSessionId) ?? [];
          entries.push(record);
          next.set(record.nativeSessionId, entries);
          if (next.size > config.historyMaxSessions) throw new Error('Claude history exceeds session limit');
        }
        for (const line of file.jsonl.split(/\r?\n/)) {
          const sample = parseClaudeUsage(line);
          if (!sample) continue;
          const entries = nextUsage.get(sample.nativeSessionId) ?? new Map<string, ClaudeUsageSample>();
          entries.set(sample.sourceId, sample);
          nextUsage.set(sample.nativeSessionId, entries);
          if (nextUsage.size > config.historyMaxSessions) throw new Error('Claude usage exceeds session limit');
        }
      }
      sessions = next;
      usage = new Map([...nextUsage].map(([id, entries]) => [id, [...entries.values()]]));
    },
    readUsagePage(id, cursor, limit) {
      if (!usage) return null;
      const offset = cursor === null ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0) {
        throw new Error('Invalid Claude usage page');
      }
      const entries = usage.get(id) ?? [];
      const end = Math.min(offset + Math.min(limit, config.historyMaxRecords), entries.length);
      const samples = entries.slice(offset, end);
      return {
        samples,
        nextCursor: end < entries.length ? String(end) : null,
        highWaterCursor: samples.length > 0 ? String(end) : cursor,
      };
    },
    read(ids): SessionHistory[] {
      return ids.flatMap((id) => {
        const records = sessions.get(id);
        if (!records) return [];
        return [{
          sessionId: id,
          summary: null,
          firstUserMessage: records.find((record) => record.role === 'user')?.text ?? null,
          checkpoints: [],
        }];
      });
    },
    prompts(id): SessionPrompt[] {
      const prompts: SessionPrompt[] = [];
      for (const record of sessions.get(id) ?? []) {
        if (record.role === 'user') {
          prompts.push({
            index: prompts.length, text: record.text, at: record.timestamp,
            response: null, status: 'unanswered', answeredAt: null, durationMs: null,
          });
        } else {
          const latest = prompts.at(-1);
          if (!latest) continue;
          latest.response = latest.response ? `${latest.response}\n${record.text}` : record.text;
          latest.status = 'answered';
          latest.answeredAt = record.timestamp || null;
          const elapsed = Date.parse(record.timestamp) - Date.parse(latest.at);
          latest.durationMs = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
        }
      }
      return prompts;
    },
    listImportable() {
      return [...sessions].map(([id, records]) => {
        const first = records[0];
        const last = records[records.length - 1];
        return {
          externalId: id, provider: 'claude',
          title: records.find((record) => record.role === 'user')?.text.slice(0, 120) ?? 'Claude Code session',
          cwd: first.cwd, repository: null, branch: null,
          model: [...records].reverse().find((record) => record.model !== null)?.model ?? null,
          messageCount: records.length, createdAt: first.timestamp, updatedAt: last.timestamp,
        };
      });
    },
  };
}

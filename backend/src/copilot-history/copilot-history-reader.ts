import type { CopilotHistoryConfig } from './config.js';
import type {
  CheckpointSummary,
  CopilotHistoryReader,
  CopilotHistorySource,
  SessionHistory,
  SessionPrompt,
} from './copilot-history-contract.js';

export interface CopilotHistoryReaderDeps {
  source: CopilotHistorySource;
  config: CopilotHistoryConfig;
  /** Wall clock used to bound the live "answering" indicator; defaults to Date.now. */
  now?: () => number;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Leading sentinels of prompts the studio injects itself — the interactive
 * session bootstrap block and the internal metasession scaffolding — as opposed
 * to prompts a human actually typed. The history pane shows real user/system
 * conversation, so these are filtered out. Each sentinel is the stable opening
 * line of an app-authored template:
 *  - `# Session Bootstrap Context` — session-bootstrap/session-bootstrap.ts
 *  - `You maintain a durable, shared knowledge base` — context-store/config.ts
 *  - `An interactive AI coding CLI session` — self-heal/self-recovery diagnosis
 *  - `The MCP (Model Context Protocol) server` — MCP self-healing metasessions
 */
const INJECTED_PROMPT_SENTINELS = [
  '# Session Bootstrap Context',
  'You maintain a durable, shared knowledge base',
  'An interactive AI coding CLI session',
  'The MCP (Model Context Protocol) server',
];

/** True when `text` is an app-injected prompt rather than a human-entered one. */
export function isInjectedPrompt(text: string): boolean {
  return INJECTED_PROMPT_SENTINELS.some((sentinel) => text.startsWith(sentinel));
}

/**
 * Turns the CLI store's raw session/checkpoint rows into per-session history.
 * Checkpoints are ordered newest-first, capped, and their overviews truncated
 * per config. Sessions with no history still appear (empty checkpoints, null
 * summary) so callers can render every session they asked about.
 */
export function createCopilotHistoryReader(
  deps: CopilotHistoryReaderDeps,
): CopilotHistoryReader {
  const { source, config } = deps;
  const now = deps.now ?? (() => Date.now());

  return {
    read(sessionIds) {
      if (sessionIds.length === 0 || !source.available()) {
        return sessionIds.map((sessionId) => ({
          sessionId,
          summary: null,
          firstUserMessage: null,
          checkpoints: [],
        }));
      }

      const summaryById = new Map<
        string,
        { summary: string | null; firstUserMessage: string | null }
      >();
      for (const row of source.sessionSummaries(sessionIds)) {
        summaryById.set(row.id, {
          summary: row.summary,
          firstUserMessage: row.first_user_message,
        });
      }

      const checkpointsById = new Map<string, CheckpointSummary[]>();
      for (const row of source.checkpoints(sessionIds)) {
        const list = checkpointsById.get(row.session_id) ?? [];
        list.push({
          number: row.checkpoint_number,
          title: row.title ?? '',
          overview: truncate(row.overview ?? '', config.maxOverviewChars),
          createdAt: row.created_at,
        });
        checkpointsById.set(row.session_id, list);
      }

      return sessionIds.map((sessionId): SessionHistory => {
        const checkpoints = (checkpointsById.get(sessionId) ?? [])
          .sort((a, b) => b.number - a.number)
          .slice(0, config.maxCheckpointsPerSession);
        const summary = summaryById.get(sessionId);
        return {
          sessionId,
          summary: summary?.summary ?? null,
          firstUserMessage: summary?.firstUserMessage ?? null,
          checkpoints,
        };
      });
    },

    prompts(sessionId) {
      if (!source.available()) {
        return [];
      }
      const allRows = source.userMessages(sessionId).map((row) => ({
        index: row.turn_index,
        text: (row.user_message ?? '').trim(),
        response: (row.assistant_response ?? '').trim(),
        at: row.timestamp ?? '',
      }));
      const rows = allRows.filter(
        (row) => row.text.length > 0 && !isInjectedPrompt(row.text),
      );
      const eventMs = source
        .usageEventTimes(sessionId)
        .map((iso) => Date.parse(iso))
        .filter((ms) => !Number.isNaN(ms));
      const prompts = rows.map((row, i): SessionPrompt => {
        const hasResponse = row.response.length > 0;
        const isLast = i === rows.length - 1;
        const status: SessionPrompt['status'] = hasResponse
          ? 'answered'
          : isLast
            ? 'answering'
            : 'unanswered';
        const answeredAt = hasResponse
          ? answerCompletedAt(row.at, rows[i + 1]?.at ?? null, eventMs)
          : null;
        const promptMs = Date.parse(row.at);
        const durationMs =
          answeredAt && !Number.isNaN(promptMs)
            ? Math.max(0, Date.parse(answeredAt) - promptMs)
            : null;
        return {
          index: row.index,
          text: row.text,
          at: row.at,
          response: hasResponse ? row.response : null,
          status,
          answeredAt,
          durationMs,
        };
      });
      const inFlight = buildInFlightPrompt(
        allRows,
        source.latestActivityTurn(sessionId),
        eventMs,
        now(),
        config.activeAnswerWindowMs,
      );
      return inFlight ? [...prompts, inFlight] : prompts;
    },
  };
}

/**
 * Builds a synthetic live "answering" row for an in-flight turn the CLI store
 * has not finalised yet. The CLI persists a turn's prompt/response text only at
 * the next turn boundary, so a just-submitted prompt is otherwise invisible
 * until the user asks again. Usage events, however, are written live as the
 * assistant responds: when the latest event's turn index runs ahead of every
 * persisted turn and is recent, the assistant is actively answering right now.
 * Returns null when there is no such turn or activity has gone stale (so the
 * indicator self-clears instead of sticking if the CLI never writes the turn).
 */
function buildInFlightPrompt(
  rows: { index: number }[],
  activityTurn: number | null,
  eventMs: number[],
  nowMs: number,
  windowMs: number,
): SessionPrompt | null {
  if (activityTurn === null) {
    return null;
  }
  const maxTurn = rows.reduce((max, row) => Math.max(max, row.index), -1);
  if (activityTurn <= maxTurn) {
    return null;
  }
  const latestEventMs = eventMs.length ? eventMs[eventMs.length - 1] : NaN;
  if (Number.isNaN(latestEventMs) || nowMs - latestEventMs > windowMs) {
    return null;
  }
  return {
    index: activityTurn,
    text: '',
    at: new Date(latestEventMs).toISOString(),
    response: null,
    status: 'answering',
    answeredAt: null,
    durationMs: null,
    pending: true,
  };
}

/**
 * Derives when a prompt's answer completed by taking the latest usage event
 * that falls between this prompt and the next one. The usage events' own
 * turn_index is unreliable, so timing is matched purely by wall-clock window.
 * Returns an ISO string, or null when the prompt time is unknown or the window
 * holds no events.
 */
function answerCompletedAt(
  promptAt: string,
  nextPromptAt: string | null,
  eventMs: number[],
): string | null {
  const start = Date.parse(promptAt);
  if (Number.isNaN(start)) {
    return null;
  }
  const nextMs = nextPromptAt ? Date.parse(nextPromptAt) : NaN;
  const end = Number.isNaN(nextMs) ? Infinity : nextMs;
  let latest = -1;
  for (const ms of eventMs) {
    if (ms >= start && ms < end && ms > latest) {
      latest = ms;
    }
  }
  return latest >= 0 ? new Date(latest).toISOString() : null;
}

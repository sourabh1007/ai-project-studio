import type { CopilotHistoryConfig } from './config.js';
import type {
  CheckpointSummary,
  CopilotHistoryReader,
  CopilotHistorySource,
  LivePromptSource,
  LivePromptTurn,
  SessionHistory,
  SessionPrompt,
} from './copilot-history-contract.js';

export interface CopilotHistoryReaderDeps {
  source: CopilotHistorySource;
  config: CopilotHistoryConfig;
  /**
   * Live event-log source used to surface the current prompt (and its streaming
   * reply) before the CLI store persists them. Optional: when absent the reader
   * falls back to a text-less, activity-derived "answering" indicator.
   */
  livePrompts?: LivePromptSource;
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
 * Separator that `composeBootstrappedPrompt` places between the launch-only
 * bootstrap context and the human's actual request. A session launched with a
 * prompt (planner/task/headless) sends both as a single CLI message, so the
 * first turn's `user_message` is the whole bootstrap block with the request
 * appended after this marker.
 */
const USER_REQUEST_MARKER = '\n\n## User Request\n\n';

/**
 * Extracts the human-authored request embedded in a launch prompt. Returns the
 * trailing `## User Request` text so the very first prompt of a launched session
 * shows in history like any typed one, or null when the injected block carries
 * no request (pure bootstrap or an internal metasession scaffold).
 */
export function extractUserRequest(text: string): string | null {
  const marker = text.indexOf(USER_REQUEST_MARKER);
  if (marker < 0) {
    return null;
  }
  const request = text.slice(marker + USER_REQUEST_MARKER.length).trim();
  return request.length > 0 ? request : null;
}

/**
 * Maps a raw CLI user message to the text shown in prompt history, or null when
 * it should be hidden. Genuine typed prompts pass through (trimmed); blank
 * messages and app-injected prompts are hidden — except a launch prompt, whose
 * embedded `## User Request` is surfaced so a launched session's first prompt is
 * never lost.
 */
export function toVisiblePrompt(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (isInjectedPrompt(trimmed)) {
    const request = extractUserRequest(trimmed);
    // A launch wrapper whose embedded request is itself an app template (e.g. an
    // internal metasession) stays hidden; only a genuine request surfaces.
    return request !== null && !isInjectedPrompt(request) ? request : null;
  }
  return trimmed;
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
        text: toVisiblePrompt(row.user_message ?? ''),
        response: (row.assistant_response ?? '').trim(),
        at: row.timestamp ?? '',
      }));
      const rows = allRows.filter(
        (row): row is typeof row & { text: string } => row.text !== null,
      );
      const eventMs = source
        .usageEventTimes(sessionId)
        .map((iso) => Date.parse(iso))
        .filter((ms) => !Number.isNaN(ms));
      const live = deps.livePrompts?.latest(sessionId) ?? null;
      const nowMs = now();
      const latestEventMs = eventMs[eventMs.length - 1] ?? NaN;
      const answering = !Number.isNaN(latestEventMs) &&
        nowMs - latestEventMs <= config.activeAnswerWindowMs;
      const latest = rows[rows.length - 1];
      const matchesSaved = live !== null && latest !== undefined &&
        toVisiblePrompt(live.text) === latest.text &&
        (live.at === latest.at || !live.at || !latest.at ||
          Date.parse(live.at) === Date.parse(latest.at));
      const prompts = rows.map((row, i): SessionPrompt => {
        const isLast = i === rows.length - 1;
        const currentLive = isLast && matchesSaved ? live : null;
        const response = currentLive?.response?.trim() || row.response || null;
        const status: SessionPrompt['status'] =
          currentLive && (!row.response || currentLive.completedAt !== undefined)
            ? livePromptStatus(currentLive, response, answering)
            : response ? 'answered' : isLast ? 'answering' : 'unanswered';
        const answeredAt = status !== 'answered' ? null
          : currentLive?.completedAt !== undefined ? currentLive.completedAt
            : answerCompletedAt(row.at, rows[i + 1]?.at ?? null, eventMs);
        const promptMs = Date.parse(row.at);
        const durationMs =
          answeredAt && !Number.isNaN(promptMs)
            ? Math.max(0, Date.parse(answeredAt) - promptMs)
            : null;
        return {
          index: row.index,
          text: row.text,
          at: row.at,
          response,
          status,
          answeredAt,
          durationMs,
        };
      });
      const inFlight = buildInFlightPrompt(
        allRows,
        source.latestActivityTurn(sessionId),
        eventMs,
        nowMs,
        config.activeAnswerWindowMs,
        live,
        matchesSaved,
      );
      return inFlight ? [...prompts, inFlight] : prompts;
    },
  };
}

function livePromptStatus(
  live: LivePromptTurn,
  response: string | null,
  answering: boolean,
): SessionPrompt['status'] {
  if (live.completedAt !== undefined || !answering) {
    return response ? 'answered' : 'unanswered';
  }
  return 'answering';
}

/**
 * Builds a synthetic live row for the current turn the CLI store has not
 * finalised yet. The store persists a turn's prompt/response text only at the
 * next turn boundary, so a just-submitted prompt is otherwise invisible until
 * the user asks again.
 *
 * When a live event-log turn is supplied (`live`), it is authoritative: its
 * real prompt and reply remain visible even before persistence catches up.
 * Recorded completion takes precedence over recent billing activity; the
 * activity window is only a fallback for logs without a turn-end event.
 *
 * When no live turn is available (no event log, or it was unreadable), the
 * reader falls back to the legacy behaviour: usage events are written live as
 * the assistant responds, so a latest event-turn beyond every persisted turn,
 * seen recently, implies an in-flight turn — surfaced as a text-less, self-
 * clearing "answering" placeholder.
 */
function buildInFlightPrompt(
  rows: { index: number }[],
  activityTurn: number | null,
  eventMs: number[],
  nowMs: number,
  windowMs: number,
  live: LivePromptTurn | null,
  matchesSaved: boolean,
): SessionPrompt | null {
  const maxTurn = rows.reduce((max, row) => Math.max(max, row.index), -1);

  if (live) {
    const liveText = toVisiblePrompt(live.text);
    if (liveText === null || matchesSaved) {
      return null;
    }
    const latestEventMs = eventMs.length ? eventMs[eventMs.length - 1] : NaN;
    const answering =
      !Number.isNaN(latestEventMs) && nowMs - latestEventMs <= windowMs;
    const response =
      live.response && live.response.trim().length > 0
        ? live.response.trim()
        : null;
    const answeredAt = response ? live.completedAt ?? null : null;
    const promptMs = Date.parse(live.at);
    return {
      index: maxTurn + 1,
      text: liveText,
      at: live.at,
      response,
      status: livePromptStatus(live, response, answering),
      answeredAt,
      durationMs: answeredAt && !Number.isNaN(promptMs)
        ? Math.max(0, Date.parse(answeredAt) - promptMs)
        : null,
      pending: true,
    };
  }

  if (activityTurn === null) {
    return null;
  }
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

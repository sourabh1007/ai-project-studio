import type { CopilotHistoryConfig } from './config.js';
import {
  PromptHistoryUnavailableError,
  type CheckpointSummary,
  type CopilotHistorySource,
  type LivePromptSource,
  type LivePromptTurn,
  type PromptHistoryReader,
  type SessionHistory,
  type SessionPrompt,
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
  /**
   * Called when the live event log exists but could not be read in time (or at
   * all). The prompt read then degrades to store-only history; this hook lets
   * the composition root surface that degraded freshness.
   */
  onLiveReadFailure?: (sessionId: string, error: unknown) => void;
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
): PromptHistoryReader {
  const { source, config } = deps;
  const now = deps.now ?? (() => Date.now());

  return {
    async recentPrompts(sessionId, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !source.recentUserMessages) {
        throw new PromptHistoryUnavailableError('Bounded prompt history is unavailable');
      }
      const raw = source.recentUserMessages(sessionId, limit);
      const prompts: SessionPrompt[] = raw.flatMap((row) => {
        const text = toVisiblePrompt(row.user_message ?? '');
        return text === null ? [] : [{
          index: row.turn_index, text, at: row.timestamp ?? '',
          response: row.assistant_response, status: row.assistant_response ? 'answered' as const : 'unanswered' as const,
          answeredAt: null, durationMs: null,
        }];
      });
      const live = await readLive(sessionId);
      if (live?.preceding?.length) {
        return mergeLiveTurns(prompts, raw.at(-1)?.turn_index ?? -1, live, now(), config.activeAnswerWindowMs, 8000).slice(-limit);
      }
      const text = live && toVisiblePrompt(live.text);
      if (live && text) {
        const last = prompts.at(-1);
        const matches = last?.text === text.slice(0, 8000) && last.at === live.at;
        const turn: SessionPrompt = {
          index: matches ? last.index : (raw.at(-1)?.turn_index ?? -1) + 1,
          text: text.slice(0, 8000), at: live.at, response: live.response?.slice(0, 8000) ?? null,
          status: live.queued ? 'unanswered' : live.completedAt !== undefined || (matches && last.status === 'answered') ? 'answered' : 'answering',
          answeredAt: live.completedAt ?? null, durationMs: null, pending: true,
          ...(live.queued ? { queued: true } : {}),
        };
        if (matches) prompts[prompts.length - 1] = turn;
        else prompts.push(turn);
      }
      return prompts.slice(-limit);
    },
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

    async prompts(sessionId) {
      if (!source.available()) {
        return [];
      }
      // Throws PromptHistoryUnavailableError when an existing store is unreadable.
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
      const live = await readLive(sessionId);
      const nowMs = now();
      const latestEventMs = eventMs[eventMs.length - 1] ?? NaN;
      const windowMs = config.activeAnswerWindowMs;
      const latest = rows[rows.length - 1];
      const matchesSaved = live !== null && latest !== undefined &&
        toVisiblePrompt(live.text) === latest.text &&
        (live.at === latest.at || !live.at || !latest.at ||
          Date.parse(live.at) === Date.parse(latest.at));
      const liveActive = live !== null && isRecent(
        nowMs, windowMs, latestEventMs, Date.parse(live.lastActivityAt ?? ''), Date.parse(live.at),
      );
      const inFlight = buildInFlightPrompt(
        allRows,
        source.latestActivityTurn(sessionId),
        eventMs,
        nowMs,
        windowMs,
        live,
        matchesSaved,
        liveActive,
      );
      const prompts = rows.map((row, i): SessionPrompt => {
        const isLast = i === rows.length - 1 && !inFlight;
        const currentLive = i === rows.length - 1 && matchesSaved ? live : null;
        const liveResponse = currentLive?.response?.trim() || null;
        // Prefer the final live text once the turn completed; mid-turn keep the
        // longer of the live (tail-bounded) and stored text so neither can
        // regress the visible reply.
        const response = liveResponse && row.response &&
          currentLive?.completedAt === undefined && row.response.length > liveResponse.length
          ? row.response
          : liveResponse || row.response || null;
        // A turn nobody is working on any more must not spin forever.
        const rowActive = isRecent(nowMs, windowMs, latestEventMs, Date.parse(row.at));
        const status: SessionPrompt['status'] =
          currentLive && (!row.response || currentLive.completedAt !== undefined)
            ? livePromptStatus(currentLive, response, liveActive)
            : response ? 'answered' : isLast && rowActive ? 'answering' : 'unanswered';
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
      if (live?.preceding?.length) {
        return mergeLiveTurns(prompts, allRows.reduce((max, row) => Math.max(max, row.index), -1), live, nowMs, windowMs);
      }
      return inFlight ? [...prompts, inFlight] : prompts;
    },
  };

  /** Bounded live-log read. An absent log is null; a failed, hung or rejected read is unavailable. */
  async function readLive(sessionId: string): Promise<LivePromptTurn | null> {
    const livePrompts = deps.livePrompts;
    if (!livePrompts) {
      return null;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const turn = await Promise.race([
        (async () => livePrompts.latest(sessionId, controller.signal))(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Live prompt read exceeded ${config.livePromptTimeoutMs}ms`);
            controller.abort(error);
            reject(error);
          }, config.livePromptTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      return turn;
    } catch (error) {
      clearTimeout(timer);
      deps.onLiveReadFailure?.(sessionId, error);
      // Older store-only history would silently erase a live turn the client already shows.
      throw new PromptHistoryUnavailableError('Live prompt history could not be read. Showing the last loaded prompts.', { cause: error });
    }
  }
}

/** True when any finite timestamp lies within `windowMs` of now (either side, for clock skew). */
function isRecent(nowMs: number, windowMs: number, ...timesMs: number[]): boolean {
  return timesMs.some((ms) => !Number.isNaN(ms) && Math.abs(nowMs - ms) <= windowMs);
}

function livePromptStatus(
  live: LivePromptTurn,
  response: string | null,
  active: boolean,
): SessionPrompt['status'] {
  if (live.queued) return 'unanswered';
  if (live.completedAt !== undefined || !active) {
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
 * Recorded completion takes precedence over recent activity; the activity
 * window is only a fallback for logs without a turn-end event.
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
  liveActive: boolean,
): SessionPrompt | null {
  const maxTurn = rows.reduce((max, row) => Math.max(max, row.index), -1);

  if (live) {
    const liveText = toVisiblePrompt(live.text);
    if (liveText === null || matchesSaved) {
      return null;
    }
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
      status: livePromptStatus(live, response, liveActive),
      answeredAt,
      durationMs: answeredAt && !Number.isNaN(promptMs)
        ? Math.max(0, Date.parse(answeredAt) - promptMs)
        : null,
      pending: true,
      ...(live.queued ? { queued: true } : {}),
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

function mergeLiveTurns(
  saved: SessionPrompt[],
  maxIndex: number,
  latest: LivePromptTurn,
  nowMs: number,
  windowMs: number,
  maxChars?: number,
): SessionPrompt[] {
  const result = [...saved];
  const key = (text: string, at: string) => `${Number.isNaN(Date.parse(at)) ? at : Date.parse(at)}\0${text}`;
  const positions = new Map<string, number[]>();
  saved.forEach((prompt, index) => {
    const identity = key(prompt.text, prompt.at);
    const list = positions.get(identity) ?? [];
    list.push(index);
    positions.set(identity, list);
  });
  for (const turn of [...latest.preceding!, latest]) {
    const visible = toVisiblePrompt(turn.text);
    if (visible === null) continue;
    const text = visible.slice(0, maxChars);
    const position = positions.get(key(text, turn.at))?.shift();
    const previous = position === undefined ? undefined : result[position];
    const liveResponse = turn.response?.trim().slice(0, maxChars) || null;
    const response = previous?.response && turn.completedAt === undefined &&
      previous.response.length > (liveResponse?.length ?? 0)
      ? previous.response : liveResponse || previous?.response || null;
    const active = isRecent(nowMs, windowMs, Date.parse(turn.lastActivityAt ?? ''), Date.parse(turn.at));
    const status = livePromptStatus(turn, response, active);
    const answeredAt = status === 'answered' ? turn.completedAt ?? previous?.answeredAt ?? null : null;
    const promptMs = Date.parse(turn.at);
    const prompt: SessionPrompt = {
      index: previous?.index ?? ++maxIndex, text, at: turn.at, response, status, answeredAt,
      durationMs: answeredAt && !Number.isNaN(promptMs) ? Math.max(0, Date.parse(answeredAt) - promptMs) : null,
      ...(!previous ? { pending: true } : {}),
      ...(turn.queued ? { queued: true } : {}),
    };
    if (position === undefined) result.push(prompt);
    else result[position] = prompt;
  }
  return result;
}

/**
 * Derives completion from the latest usage event before the next prompt.
 * Native turn-end evidence takes precedence when prompts overlap.
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

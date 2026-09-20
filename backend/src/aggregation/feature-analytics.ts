import type { Clock } from '../kernel/clock.js';
import type { Session } from '../session/session-contract.js';
import type { TreeGroup } from '../feature-tree/feature-tree-contract.js';
import type {
  AggregateReader,
  FeatureAnalytics,
  GroupInfo,
  SessionBreakdown,
  SessionUsage,
  UsageOrigin,
  UsageTotals,
  WorkspaceStats,
} from './aggregation-contract.js';

/** Membership/timing source for feature analytics. */
export interface SessionLister {
  /**
   * Every session for a feature including internal-scope metasessions, so
   * headless IDE AI work (PR review, summaries) is counted in analytics.
   */
  listByFeatureAll(featureId: string): Session[];
  listAll(): Session[];
}

/** Group-membership source so sessions can be nested under their group. */
export interface GroupLister {
  listByFeature(featureId: string): TreeGroup[];
}

/** Feature-level analytics: usage rollups joined with session timing. */
export interface FeatureAnalyticsService {
  forFeature(featureId: string): FeatureAnalytics;
  workspaceTotals(): UsageTotals;
  workspaceStats(): WorkspaceStats;
}

export interface FeatureAnalyticsDeps {
  reader: AggregateReader;
  sessions: SessionLister;
  groups: GroupLister;
  clock: Clock;
}

/** IDE metasessions are headless AI the IDE runs for the user; dev sessions are
 * interactive user sessions. Tag each so the dashboard can label its origin. */
function originOf(session: Session): UsageOrigin {
  return session.kind === 'meta' ? 'ide' : 'user';
}

/** Usage totals for a session row, or an empty (running) placeholder. */
function totalsFor(usage: SessionUsage | undefined): UsageTotals {
  return usage
    ? {
        sessions: 1,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
        cost: usage.cost,
        credits: usage.credits,
        nanoAiu: usage.nanoAiu,
      }
    : EMPTY_USAGE;
}

/**
 * Active wall-clock time on a session in milliseconds. Uses the session's
 * end time, or the current time while the session is still running. Returns 0
 * when the start time is missing or unparseable.
 */
export function sessionActiveMs(
  startedAt: string | null,
  endedAt: string | null,
  nowMs: number,
): number {
  if (!startedAt) {
    return 0;
  }
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) {
    return 0;
  }
  const parsedEnd = endedAt ? Date.parse(endedAt) : nowMs;
  const end = Number.isNaN(parsedEnd) ? nowMs : parsedEnd;
  return Math.max(0, end - start);
}

const EMPTY_USAGE = {
  sessions: 1,
  inputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  cost: 0,
  credits: 0,
  nanoAiu: 0,
};

function sortKey(session: Session): number {
  const ref = session.startedAt ?? session.createdAt;
  const parsed = Date.parse(ref);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

export function createFeatureAnalytics(
  deps: FeatureAnalyticsDeps,
): FeatureAnalyticsService {
  const { reader, sessions, groups, clock } = deps;
  return {
    forFeature(featureId) {
      const nowMs = clock.now().getTime();
      const usageBySession = new Map(
        reader.bySession(featureId).map((usage) => [usage.sessionId, usage]),
      );
      const members = sessions
        .listByFeatureAll(featureId)
        .slice()
        .sort((a, b) => sortKey(a) - sortKey(b));

      const bySession: SessionBreakdown[] = members.map((session) => {
        const usage = usageBySession.get(session.id);
        return {
          sessionId: session.id,
          provider: session.provider,
          kind: session.kind,
          status: session.status,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          activeMs: sessionActiveMs(session.startedAt, session.endedAt, nowMs),
          groupId: session.groupId ?? null,
          origin: originOf(session),
          ...totalsFor(usage),
        };
      });

      // Warm-ACP agent runs (bug-bash testers, task agents) reuse a pooled
      // session, so they are never persisted as feature sessions. Surface each
      // as a session row from its usage snapshot so agent usage is visible and
      // counted instead of silently dropped. Skip any id already persisted so a
      // run is never counted twice.
      const memberIds = new Set(members.map((session) => session.id));
      for (const agent of reader.warmAgentSessions(featureId)) {
        if (memberIds.has(agent.sessionId)) {
          continue;
        }
        bySession.push({
          sessionId: agent.sessionId,
          provider: agent.provider,
          kind: 'meta',
          status: 'completed',
          startedAt: agent.capturedAt,
          endedAt: agent.capturedAt,
          activeMs: 0,
          groupId: null,
          origin: 'agent',
          label: agent.label,
          ...totalsFor(usageBySession.get(agent.sessionId)),
        });
      }

      const featureGroups: GroupInfo[] = groups
        .listByFeature(featureId)
        .map((group) => ({
          id: group.id,
          name: group.name,
          kind: group.kind,
          parentGroupId: group.parentGroupId ?? null,
        }));

      const totals: UsageTotals = {
        ...reader.featureTotals(featureId),
        sessions: bySession.length,
      };
      const totalActiveMs = bySession.reduce(
        (sum, session) => sum + session.activeMs,
        0,
      );

      return {
        totals,
        byModel: reader.byModel(featureId),
        byProvider: reader.byProvider(featureId),
        byDay: reader.byDay(featureId),
        bySession,
        byMcpServer: reader.byMcpServer(featureId),
        groups: featureGroups,
        timing: { totalActiveMs },
      };
    },
    workspaceTotals() {
      return reader.workspaceTotals();
    },
    workspaceStats() {
      const all = sessions.listAll();
      const visible = all.filter((session) => session.scope !== 'internal');
      return {
        totals: reader.workspaceTotals(),
        activeSessions: visible.filter(
          (session) => session.status === 'running',
        ).length,
        totalSessions: visible.length,
      };
    },
  };
}

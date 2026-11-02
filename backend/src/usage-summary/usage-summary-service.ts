import type { UsageTotals } from '../aggregation/aggregation-contract.js';
import type {
  FeatureUsageSummary,
  UsageSummary,
  UsageSummaryNode,
  UsageSummaryReader,
  UsageSummaryService,
  UsageSummaryState,
} from './usage-summary-contract.js';

interface Acc {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  cost: number | null;
  credits: number | null;
  nanoAiu: number | null;
  knownCost: number;
  knownCredits: number;
  knownNanoAiu: number;
  unavailableCharges: number;
  usdEstimate: number | undefined;
  withoutUsage: number;
}

function emptyAcc(): Acc {
  return {
    sessions: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
    cost: 0, credits: 0, nanoAiu: 0, knownCost: 0, knownCredits: 0, knownNanoAiu: 0,
    unavailableCharges: 0, usdEstimate: undefined, withoutUsage: 0,
  };
}

function plus(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

function addTotals(acc: Acc, row: UsageTotals): void {
  acc.sessions += row.sessions;
  acc.inputTokens += row.inputTokens;
  acc.outputTokens += row.outputTokens;
  acc.reasoningOutputTokens += row.reasoningOutputTokens;
  acc.knownCost += row.knownCost ?? row.cost ?? 0;
  acc.knownCredits += row.knownCredits ?? row.credits ?? 0;
  acc.knownNanoAiu += row.knownNanoAiu ?? row.nanoAiu ?? 0;
  acc.unavailableCharges += row.unavailableCharges ?? (row.credits === null ? 1 : 0);
  acc.cost = plus(acc.cost, row.cost);
  acc.credits = plus(acc.credits, row.credits);
  acc.nanoAiu = plus(acc.nanoAiu, row.nanoAiu);
  if (row.usdEstimate != null) acc.usdEstimate = (acc.usdEstimate ?? 0) + row.usdEstimate;
}

function addAcc(acc: Acc, child: Acc): void {
  acc.sessions += child.sessions;
  acc.inputTokens += child.inputTokens;
  acc.outputTokens += child.outputTokens;
  acc.reasoningOutputTokens += child.reasoningOutputTokens;
  acc.knownCost += child.knownCost;
  acc.knownCredits += child.knownCredits;
  acc.knownNanoAiu += child.knownNanoAiu;
  acc.unavailableCharges += child.unavailableCharges;
  acc.cost = plus(acc.cost, child.cost);
  acc.credits = plus(acc.credits, child.credits);
  acc.nanoAiu = plus(acc.nanoAiu, child.nanoAiu);
  acc.withoutUsage += child.withoutUsage;
  if (child.usdEstimate !== undefined) acc.usdEstimate = (acc.usdEstimate ?? 0) + child.usdEstimate;
}

function stateOf(acc: Acc): UsageSummaryState {
  if (acc.sessions === 0) return 'none';
  if (acc.sessions === acc.withoutUsage) return 'empty';
  if (acc.credits !== null && acc.nanoAiu !== null) return 'complete';
  return acc.knownCredits > 0 || acc.knownNanoAiu > 0 ? 'partial' : 'unavailable';
}

function toNode(acc: Acc): UsageSummaryNode {
  const partial = acc.unavailableCharges > 0;
  const totals: UsageTotals = {
    sessions: acc.sessions,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    reasoningOutputTokens: acc.reasoningOutputTokens,
    cost: acc.cost,
    credits: acc.credits,
    nanoAiu: acc.nanoAiu,
    ...(partial ? {
      knownCost: acc.knownCost, knownCredits: acc.knownCredits,
      knownNanoAiu: acc.knownNanoAiu, unavailableCharges: acc.unavailableCharges,
    } : {}),
    ...(acc.usdEstimate === undefined ? {} : { usdEstimate: acc.usdEstimate }),
  };
  return { totals, state: stateOf(acc), sessionsWithoutUsage: acc.withoutUsage };
}

const UNATTRIBUTED = 'unattributed';

/**
 * Pure fold of every feature/group/session usage row into per-feature and
 * per-group totals. Each usage row lands in exactly one node, then totals roll
 * up through an acyclic parent map (group -> group/feature, feature -> group or
 * feature), so nested descendants are counted once. Cyclic or dangling parents
 * are detached instead of dropping or double counting usage; usage of unknown
 * features surfaces as `unattributed`.
 */
export function createUsageSummaryService(deps: { reader: UsageSummaryReader }): UsageSummaryService {
  return {
    summary(): UsageSummary {
      const { reader } = deps;
      const features = reader.features();
      const groups = reader.groups();
      const featureIds = new Set(features.map((f) => f.id));
      const groupById = new Map(groups.filter((g) => featureIds.has(g.featureId)).map((g) => [g.id, g]));

      const parent = new Map<string, string | null>();
      const reaches = (from: string | null, target: string): boolean => {
        for (let at = from; at !== null; at = parent.get(at) ?? null) {
          if (at === target) return true;
        }
        return false;
      };
      const attach = (id: string, ...candidates: Array<string | null>): void => {
        const chosen = candidates.find((c) => c !== null && !reaches(c, id));
        parent.set(id, chosen ?? null);
      };
      for (const group of groupById.values()) {
        const raw = group.parentGroupId;
        const rawParent = raw !== null && groupById.get(raw)?.featureId === group.featureId ? `g:${raw}` : null;
        attach(`g:${group.id}`, rawParent, `f:${group.featureId}`, null);
      }
      for (const feature of features) {
        const viaGroup = feature.parentGroupId !== null && groupById.has(feature.parentGroupId)
          ? `g:${feature.parentGroupId}` : null;
        const viaFeature = feature.parentFeatureId !== null && featureIds.has(feature.parentFeatureId)
          ? `f:${feature.parentFeatureId}` : null;
        attach(`f:${feature.id}`, viaGroup, viaFeature, null);
      }

      const direct = new Map<string, Acc>();
      const accFor = (id: string): Acc => {
        let acc = direct.get(id);
        if (!acc) {
          acc = emptyAcc();
          direct.set(id, acc);
        }
        return acc;
      };
      const nodeFor = (featureId: string, groupId: string | null): string => {
        if (!featureIds.has(featureId)) return UNATTRIBUTED;
        const group = groupId === null ? undefined : groupById.get(groupId);
        return group !== undefined && group.featureId === featureId ? `g:${group.id}` : `f:${featureId}`;
      };

      const sessionNode = new Map<string, string>();
      for (const session of reader.sessions()) {
        sessionNode.set(session.id, nodeFor(session.featureId, session.groupId));
      }
      const withUsage = new Set<string>();
      for (const row of reader.usage()) {
        const known = sessionNode.get(row.sessionId);
        addTotals(accFor(known ?? nodeFor(row.featureId, null)), row);
        withUsage.add(row.sessionId);
      }
      for (const [sessionId, node] of sessionNode) {
        if (withUsage.has(sessionId)) continue;
        const acc = accFor(node);
        acc.sessions += 1;
        acc.withoutUsage += 1;
      }

      const children = new Map<string, string[]>();
      for (const [id, up] of parent) {
        const key = up ?? UNATTRIBUTED;
        children.set(key, [...(children.get(key) ?? []), id]);
      }
      const rolled = new Map<string, Acc>();
      const roll = (id: string): Acc => {
        const memo = rolled.get(id);
        if (memo) return memo;
        const acc = emptyAcc();
        const own = direct.get(id);
        if (own) addAcc(acc, own);
        for (const child of children.get(id) ?? []) addAcc(acc, roll(child));
        rolled.set(id, acc);
        return acc;
      };

      const result: Record<string, FeatureUsageSummary> = {};
      for (const feature of features) {
        result[feature.id] = { featureId: feature.id, ...toNode(roll(`f:${feature.id}`)), groups: {} };
      }
      for (const group of groupById.values()) {
        result[group.featureId].groups[group.id] = toNode(roll(`g:${group.id}`));
      }

      // Groups always fall back to their feature, so only usage of unknown features is unattributed.
      const unattributed = direct.get(UNATTRIBUTED);
      return { features: result, unattributed: unattributed ? toNode(unattributed) : null };
    },
  };
}

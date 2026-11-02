import type { GroupInfo, SessionBreakdown, UsageTotals } from './types.js';

export interface UsageTreeTotals extends UsageTotals {
  activeMs: number;
}

export interface FeatureUsageTreeNode {
  type: 'feature';
  id: 'feature';
  name: 'Feature';
  totals: UsageTreeTotals;
  /** Deleted-session usage already folded into 	otals; it has no child row. */
  retained?: UsageTreeTotals;
  children: Array<GroupUsageTreeNode | SessionUsageTreeNode>;
}

export interface GroupUsageTreeNode {
  type: 'group';
  id: string;
  name: string;
  kind: GroupInfo['kind'];
  totals: UsageTreeTotals;
  /** Deleted-session usage already folded into 	otals; it has no child row. */
  retained?: UsageTreeTotals;
  children: Array<GroupUsageTreeNode | SessionUsageTreeNode>;
}

export interface SessionUsageTreeNode {
  type: 'session';
  id: string;
  name: string;
  origin: SessionBreakdown['origin'];
  totals: UsageTreeTotals;
  session: SessionBreakdown;
}

export type UsageTreeNode =
  | FeatureUsageTreeNode
  | GroupUsageTreeNode
  | SessionUsageTreeNode;

export function buildUsageTree(
  groups: GroupInfo[],
  bySession: SessionBreakdown[],
  retained?: UsageTotals,
): FeatureUsageTreeNode {
  const root: FeatureUsageTreeNode = {
    type: 'feature',
    id: 'feature',
    name: 'Feature',
    totals: emptyTotals(),
    children: [],
  };
  const groupNodes = new Map<string, GroupUsageTreeNode>();

  for (const group of groups) {
    if (groupNodes.has(group.id)) continue;
    groupNodes.set(group.id, {
      type: 'group',
      id: group.id,
      name: group.name,
      kind: group.kind,
      totals: emptyTotals(),
      children: [],
    });
  }

  const linked = new Set<string>();
  for (const group of groups) {
    if (linked.has(group.id)) continue;
    linked.add(group.id);
    const node = groupNodes.get(group.id)!;
    const parent =
      group.parentGroupId === null ? root : groupNodes.get(group.parentGroupId);
    if (parent === undefined) {
      root.children.push(node);
    } else {
      parent.children.push(node);
    }
  }

  attachCycles(root, groups, groupNodes);

  const seenSessions = new Set<string>();
  for (const session of bySession) {
    if (seenSessions.has(session.sessionId)) continue;
    seenSessions.add(session.sessionId);
    const node: SessionUsageTreeNode = {
      type: 'session',
      id: session.sessionId,
      name: session.sessionId,
      origin: session.origin,
      totals: totalsForSession(session),
      session,
    };
    const parent = session.groupId === null ? root : groupNodes.get(session.groupId);
    if (parent === undefined) {
      root.children.push(node);
    } else {
      parent.children.push(node);
    }
  }

  rollUp(root);
  if (retained !== undefined && retained.sessions > 0) {
    const merged = { ...root.totals };
    addTotals(merged, { ...retained, activeMs: 0 });
    root.totals = finalizeTotals(merged);
    root.retained = { ...retained, activeMs: 0 };
  }
  return root;
}

/** Groups in a parent cycle are unreachable from the root; surface them there instead of dropping their usage. */
function attachCycles(
  root: FeatureUsageTreeNode,
  groups: GroupInfo[],
  groupNodes: Map<string, GroupUsageTreeNode>,
): void {
  const reached = new Set<GroupUsageTreeNode>();
  const mark = (node: FeatureUsageTreeNode | GroupUsageTreeNode): void => {
    for (const child of node.children) {
      if (child.type === 'group' && !reached.has(child)) {
        reached.add(child);
        mark(child);
      }
    }
  };
  mark(root);
  for (const group of groups) {
    const node = groupNodes.get(group.id)!;
    if (reached.has(node)) continue;
    const parent = groupNodes.get(group.parentGroupId!)!;
    parent.children.splice(parent.children.indexOf(node), 1);
    root.children.push(node);
    reached.add(node);
    mark(node);
  }
}

function rollUp(node: UsageTreeNode): UsageTreeTotals {
  if (node.type === 'session') {
    return node.totals;
  }
  const total = emptyTotals();
  total.knownCost = 0;
  total.knownCredits = 0;
  total.knownNanoAiu = 0;
  total.unavailableCharges = 0;
  for (const child of node.children) {
    addTotals(total, rollUp(child));
  }
  node.totals = finalizeTotals(total);
  return node.totals;
}

function totalsForSession(session: SessionBreakdown): UsageTreeTotals {
  return finalizeTotals({
    sessions: 1,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    reasoningOutputTokens: session.reasoningOutputTokens,
    cost: session.cost,
    credits: session.credits,
    nanoAiu: session.nanoAiu,
    knownCost: session.knownCost ?? session.cost ?? 0,
    knownCredits: session.knownCredits ?? session.credits ?? 0,
    knownNanoAiu: session.knownNanoAiu ?? session.nanoAiu ?? 0,
    unavailableCharges: session.unavailableCharges ?? (session.credits === null ? 1 : 0),
    ...(session.usdEstimate == null ? {} : { usdEstimate: session.usdEstimate }),
    activeMs: session.activeMs,
  });
}

/** Known partial amounts are only meaningful while some charge is unavailable. */
function finalizeTotals(total: UsageTreeTotals): UsageTreeTotals {
  if (total.unavailableCharges !== undefined && total.unavailableCharges > 0) {
    return total;
  }
  const { knownCost, knownCredits, knownNanoAiu, unavailableCharges, ...rest } = total;
  void knownCost; void knownCredits; void knownNanoAiu; void unavailableCharges;
  return rest;
}

function emptyTotals(): UsageTreeTotals {
  return {
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    cost: 0,
    credits: 0,
    nanoAiu: 0,
    activeMs: 0,
  };
}

function addTotals(total: UsageTreeTotals, add: UsageTreeTotals): void {
  total.sessions += add.sessions;
  total.inputTokens += add.inputTokens;
  total.outputTokens += add.outputTokens;
  total.reasoningOutputTokens += add.reasoningOutputTokens;
  total.knownCost = (total.knownCost ?? total.cost ?? 0) + (add.knownCost ?? add.cost ?? 0);
  total.knownCredits = (total.knownCredits ?? total.credits ?? 0) + (add.knownCredits ?? add.credits ?? 0);
  total.knownNanoAiu = (total.knownNanoAiu ?? total.nanoAiu ?? 0) + (add.knownNanoAiu ?? add.nanoAiu ?? 0);
  total.cost = total.cost === null || add.cost === null ? null : total.cost + add.cost;
  total.credits = total.credits === null || add.credits === null ? null : total.credits + add.credits;
  total.nanoAiu = total.nanoAiu === null || add.nanoAiu === null ? null : total.nanoAiu + add.nanoAiu;
  total.unavailableCharges = (total.unavailableCharges ?? 0) + (add.unavailableCharges ?? 0);
  if (add.usdEstimate != null) total.usdEstimate = (total.usdEstimate ?? 0) + add.usdEstimate;
  total.activeMs += add.activeMs;
}

/** How trustworthy a node's native charge total is. */
export type UsageReliability = 'none' | 'complete' | 'partial' | 'unavailable';

/**
 * Explicit state for a rolled-up node: `none` has no sessions, `complete` has
 * every charge reported, `partial` has some known and some unavailable charges
 * (use `known*` as a lower bound), `unavailable` has no reported charge at all.
 * Tokens are always counts, so they stay valid in every state.
 */
export function usageReliability(totals: UsageTreeTotals): UsageReliability {
  if (totals.sessions === 0) return 'none';
  if (totals.credits !== null && totals.nanoAiu !== null) return 'complete';
  return (totals.knownNanoAiu ?? 0) > 0 || (totals.knownCredits ?? 0) > 0
    ? 'partial'
    : 'unavailable';
}

/**
 * Flat id -> rolled-up totals for the feature root (`'feature'`) and every
 * group, each including all nested descendants exactly once. Lets an explorer
 * badge any group from the one feature-usage payload it already fetched.
 */
export function usageTotalsByNode(tree: FeatureUsageTreeNode): Map<string, UsageTreeTotals> {
  const byId = new Map<string, UsageTreeTotals>();
  const visit = (node: FeatureUsageTreeNode | GroupUsageTreeNode): void => {
    byId.set(node.id, node.totals);
    for (const child of node.children) {
      if (child.type === 'group') visit(child);
    }
  };
  visit(tree);
  return byId;
}

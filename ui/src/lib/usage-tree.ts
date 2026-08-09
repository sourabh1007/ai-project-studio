import type { GroupInfo, SessionBreakdown, UsageTotals } from './types.js';

export interface UsageTreeTotals extends UsageTotals {
  activeMs: number;
}

export interface FeatureUsageTreeNode {
  type: 'feature';
  id: 'feature';
  name: 'Feature';
  totals: UsageTreeTotals;
  children: Array<GroupUsageTreeNode | SessionUsageTreeNode>;
}

export interface GroupUsageTreeNode {
  type: 'group';
  id: string;
  name: string;
  kind: GroupInfo['kind'];
  totals: UsageTreeTotals;
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
    groupNodes.set(group.id, {
      type: 'group',
      id: group.id,
      name: group.name,
      kind: group.kind,
      totals: emptyTotals(),
      children: [],
    });
  }

  for (const group of groups) {
    const node = groupNodes.get(group.id)!;
    const parent =
      group.parentGroupId === null ? root : groupNodes.get(group.parentGroupId);
    if (parent === undefined) {
      root.children.push(node);
    } else {
      parent.children.push(node);
    }
  }

  for (const session of bySession) {
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
  return root;
}

function rollUp(node: UsageTreeNode): UsageTreeTotals {
  if (node.type === 'session') {
    return node.totals;
  }
  const total = emptyTotals();
  for (const child of node.children) {
    addTotals(total, rollUp(child));
  }
  node.totals = total;
  return total;
}

function totalsForSession(session: SessionBreakdown): UsageTreeTotals {
  return {
    sessions: 1,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    reasoningOutputTokens: session.reasoningOutputTokens,
    cost: session.cost,
    credits: session.credits,
    nanoAiu: session.nanoAiu,
    activeMs: session.activeMs,
  };
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
  total.cost += add.cost;
  total.credits += add.credits;
  total.nanoAiu += add.nanoAiu;
  total.activeMs += add.activeMs;
}

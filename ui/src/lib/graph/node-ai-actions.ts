/**
 * Pure, DOM-free catalog of node-scoped AI actions — the contextual "ask AI
 * about this node" operations surfaced in the AI side panel and the universal
 * command bar. Kept free of React/DOM and backend coupling so it can be unit
 * tested to 100% and reused by the panel, the command bar, and the (later)
 * backend client without duplicating the action list.
 *
 * Actions are *data*, not scattered buttons: the UI renders whichever actions
 * `actionsForTier` says apply, so the canvas stays clean.
 */

import type { NodeTier } from './graph-model.js';

/** Stable identifiers for each node-scoped AI action. */
export type NodeAiActionId =
  | 'explain'
  | 'why-exists'
  | 'who-depends-on'
  | 'call-path'
  | 'callers'
  | 'callees'
  | 'ownership'
  | 'related-prs'
  | 'tests'
  | 'usage'
  | 'architecture-impact';

/** A single AI action definition. */
export interface NodeAiAction {
  id: NodeAiActionId;
  /** Short imperative label for the panel/bar. */
  label: string;
  /** One-line hint describing what the action answers. */
  hint: string;
  /** Node tiers this action is meaningful for. */
  tiers: readonly NodeTier[];
}

const ALL_TIERS: readonly NodeTier[] = ['group', 'type', 'member'];

/**
 * The full action catalog in display order. Behavioural actions (call-path,
 * callers, callees) only apply to callable `member` nodes; structural and
 * ownership actions apply more broadly.
 */
export const NODE_AI_ACTIONS: readonly NodeAiAction[] = [
  {
    id: 'explain',
    label: 'Explain this',
    hint: 'Plain-English summary of what this is and does',
    tiers: ALL_TIERS,
  },
  {
    id: 'why-exists',
    label: 'Why does this exist',
    hint: 'Rationale and responsibilities',
    tiers: ALL_TIERS,
  },
  {
    id: 'who-depends-on',
    label: 'Who depends on this',
    hint: 'Inbound dependents across the codebase',
    tiers: ALL_TIERS,
  },
  {
    id: 'call-path',
    label: 'Show call path',
    hint: 'Reachable call chain through this node',
    tiers: ['member'],
  },
  {
    id: 'callers',
    label: 'Show callers',
    hint: 'Functions that call this',
    tiers: ['member'],
  },
  {
    id: 'callees',
    label: 'Show callees',
    hint: 'Functions this calls',
    tiers: ['member'],
  },
  {
    id: 'ownership',
    label: 'Show ownership',
    hint: 'Owning team / recent authors',
    tiers: ['group', 'type'],
  },
  {
    id: 'related-prs',
    label: 'Show related PRs',
    hint: 'Pull requests that touched this',
    tiers: ALL_TIERS,
  },
  {
    id: 'tests',
    label: 'Show tests',
    hint: 'Tests exercising this',
    tiers: ['type', 'member'],
  },
  {
    id: 'usage',
    label: 'Show usage',
    hint: 'Where and how often this is used',
    tiers: ['type', 'member'],
  },
  {
    id: 'architecture-impact',
    label: 'Show architecture impact',
    hint: 'Blast radius of changing this',
    tiers: ['group', 'type'],
  },
];

/** The actions applicable to a node of the given `tier`, in catalog order. */
export function actionsForTier(tier: NodeTier): NodeAiAction[] {
  return NODE_AI_ACTIONS.filter((action) => action.tiers.includes(tier));
}

/** Looks up a single action by id, or `undefined` when unknown. */
export function findNodeAiAction(
  id: string,
): NodeAiAction | undefined {
  return NODE_AI_ACTIONS.find((action) => action.id === id);
}

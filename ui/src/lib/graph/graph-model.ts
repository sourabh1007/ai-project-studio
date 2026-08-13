/**
 * Pure, DOM-free graph model for the reusable graph engine — provider-agnostic
 * and independent of React Flow / Dagre so it can be unit tested to 100% and
 * drive *any* future graph (PR change-graph, architecture view, call graphs).
 *
 * It encodes **progressive disclosure / semantic zoom**: nodes carry a `tier`
 * and only the tiers appropriate to the current zoom level are shown. Zoomed
 * out you see high-level groups; zooming in reveals types, then members.
 */

/**
 * A node's level of detail, from coarsest to finest:
 * - `group`  — services / projects / assemblies / high-level clusters.
 * - `type`   — classes / interfaces / modules.
 * - `member` — methods / fields / individual call sites.
 */
export type NodeTier = 'group' | 'type' | 'member';

/** How much detail is currently rendered, derived from the viewport zoom. */
export type ZoomLevel = 'overview' | 'mid' | 'detail';

/** A source node before layout — position is assigned later by the layout engine. */
export interface GraphInputNode {
  id: string;
  tier: NodeTier;
  label: string;
  /** Optional parent group id, used to collapse detail into its group. */
  groupId?: string;
}

/** A directed relationship between two node ids. */
export interface GraphInputEdge {
  id: string;
  source: string;
  target: string;
}

/** A normalised, de-duplicated graph ready for tier-based filtering. */
export interface GraphModel {
  nodes: GraphInputNode[];
  edges: GraphInputEdge[];
}

/** The tiers revealed at each zoom level (cumulative, coarse → fine). */
const TIERS_BY_LEVEL: Record<ZoomLevel, ReadonlySet<NodeTier>> = {
  overview: new Set<NodeTier>(['group']),
  mid: new Set<NodeTier>(['group', 'type']),
  detail: new Set<NodeTier>(['group', 'type', 'member']),
};

/** Default zoom thresholds (React Flow zoom scale) for level transitions. */
export const ZOOM_MID_THRESHOLD = 0.6;
export const ZOOM_DETAIL_THRESHOLD = 1.2;

/**
 * Maps a viewport zoom `scale` to a semantic `ZoomLevel`. Below the mid
 * threshold only groups show; between mid and detail, types appear; at/above the
 * detail threshold, members appear. Never renders full detail while zoomed out.
 */
export function zoomLevelForScale(scale: number): ZoomLevel {
  if (scale < ZOOM_MID_THRESHOLD) {
    return 'overview';
  }
  if (scale < ZOOM_DETAIL_THRESHOLD) {
    return 'mid';
  }
  return 'detail';
}

/**
 * Normalises raw nodes/edges into a `GraphModel`: drops duplicate node ids
 * (first wins) and drops edges whose endpoints are not both present, so the
 * layout/render layers never see dangling references.
 */
export function buildGraphModel(
  nodes: readonly GraphInputNode[],
  edges: readonly GraphInputEdge[],
): GraphModel {
  const byId = new Map<string, GraphInputNode>();
  for (const node of nodes) {
    if (!byId.has(node.id)) {
      byId.set(node.id, node);
    }
  }
  const validEdges = edges.filter(
    (edge) => byId.has(edge.source) && byId.has(edge.target),
  );
  return { nodes: [...byId.values()], edges: validEdges };
}

/** The set of node tiers visible at a given zoom level. */
export function tiersForLevel(level: ZoomLevel): ReadonlySet<NodeTier> {
  return TIERS_BY_LEVEL[level];
}

/**
 * The nodes visible at `level` — those whose tier is revealed at that level.
 * This is the core of progressive disclosure.
 */
export function visibleNodes(
  model: GraphModel,
  level: ZoomLevel,
): GraphInputNode[] {
  const tiers = TIERS_BY_LEVEL[level];
  return model.nodes.filter((node) => tiers.has(node.tier));
}

/**
 * The edges visible at `level`: only edges whose *both* endpoints are visible.
 * Edges touching a hidden (too-detailed) node are rolled up rather than dangling.
 */
export function visibleEdges(
  model: GraphModel,
  level: ZoomLevel,
): GraphInputEdge[] {
  const visible = new Set(visibleNodes(model, level).map((node) => node.id));
  return model.edges.filter(
    (edge) => visible.has(edge.source) && visible.has(edge.target),
  );
}

/** Count of direct relationships (in + out) per node id, for node badges. */
export function relationshipCounts(model: GraphModel): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (id: string): void => {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  for (const edge of model.edges) {
    bump(edge.source);
    bump(edge.target);
  }
  return counts;
}

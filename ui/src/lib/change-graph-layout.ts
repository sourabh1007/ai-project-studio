import type {
  ChangeGraphCategory,
  ChangeGraphEdgeCall,
  ChangeGraphNode,
  ChangeGraphNodeKind,
  ChangeGraphStep,
} from './types.js';

/** A changed-file node placed on the canvas, in absolute coordinates. */
export interface PlacedNode {
  /** Repo-relative path (stable id and lookup key). */
  path: string;
  /** The project box this node belongs to. */
  projectId: string;
  /** Compact label (the file's basename). */
  label: string;
  /** Whether this is a changed file (orange) or a boundary caller (blue). */
  kind: ChangeGraphNodeKind;
  /** Absolute top-left of the node's cell. */
  x: number;
  y: number;
  /** Node cell width, sized to its label so text never overflows. */
  width: number;
}

/** A project box grouping the changed files that belong to one project. */
export interface PlacedBox {
  /** Stable project id. */
  id: string;
  /** Display name shown on the box header. */
  name: string;
  /** Number of nodes of the rendered category inside this box. */
  count: number;
  /**
   * When true the box is rendered as a single compact module tile with no inner
   * file nodes; clicking it expands the module to reveal its files and edges.
   */
  collapsed: boolean;
  /** Absolute top-left of the box and its size. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A reference edge placed between two node centres, in absolute coordinates. */
export interface PlacedEdge {
  from: string;
  to: string;
  calls: ChangeGraphEdgeCall[];
  highlightsChanges: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A fully placed change graph for one category, ready to render as SVG. */
export interface ChangeGraphLayout {
  boxes: PlacedBox[];
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  /** Total canvas size spanned by the placed boxes. */
  width: number;
  height: number;
}

/** Layout geometry constants (kept here so the render stays declarative). */
export const NODE_MIN_W = 132;
export const NODE_H = 40;
export const NODE_GAP = 14;
export const BOX_PAD = 16;
export const BOX_TITLE_H = 30;
export const BOX_GAP = 28;
/** Approx. width of one monospace label glyph at the node font size. */
export const LABEL_CHAR_W = 7.7;
/** Horizontal padding inside a node cell, added around its label. */
export const NODE_LABEL_PAD = 24;
/** Approx. width of one title glyph, used to keep long box titles unclipped. */
export const TITLE_CHAR_W = 8;
/** The width the box flow wraps at, matched to the SVG viewBox width. */
export const MAX_ROW_WIDTH = 1600;
/**
 * A module/project box is collapsed to a single tile once it holds more than
 * this many nodes of the rendered category, so a change that touches many files
 * in one module (or is referenced by many callers) shows as one module box the
 * user can expand on demand instead of flooding the canvas.
 */
export const COLLAPSE_MIN_NODES = 2;
/** Height of a collapsed module tile (title row plus a compact hint row). */
export const COLLAPSED_BOX_H = 58;
const FOCUSED_COL_GAP = 96;
const FOCUSED_ROW_GAP = 34;

/** The trailing path segment used as a compact node label. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** Joins a deduped list into `first +N` once it exceeds a single entry. */
function summarizeNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names[0]} +${names.length - 1}`;
}

/** Distinct, trimmed, non-empty values from a raw list, preserving order. */
function distinct(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

/**
 * A human-readable arrow label describing what the source file references in the
 * target file. Reads in the direction the arrow points ("from" calls "to"):
 *
 * - `caller() → Symbol` — function `caller` in the source calls/uses class
 *   `Symbol` declared in the target.
 * - `init Symbol` — `Symbol` is referenced at module/field/type scope (no
 *   enclosing function), i.e. it is being initialised or used as a base type.
 *
 * Many-to-one relationships are deduped and capped with `+N` so a dense edge
 * stays legible instead of listing every caller or symbol.
 */
export function formatEdgeLabel(
  calls: ReadonlyArray<ChangeGraphEdgeCall> | undefined,
): string {
  const list = calls ?? [];
  if (list.length === 0) return '';
  const symbols = distinct(list.map((call) => call.symbol));
  const callers = distinct(list.map((call) => call.caller));
  const symbolText = summarizeNames(symbols);
  if (callers.length === 0) {
    return symbolText ? `init ${symbolText}` : '';
  }
  const callerText = summarizeNames(callers.map((caller) => `${caller}()`));
  return symbolText ? `${callerText} → ${symbolText}` : callerText;
}

/** The node cell width needed to fit a label without overflow. */
function nodeWidthFor(label: string): number {
  return Math.max(
    NODE_MIN_W,
    Math.ceil(label.length * LABEL_CHAR_W) + NODE_LABEL_PAD,
  );
}

/** The centre point of a placed node, where its edges connect. */
export function nodeCenter(node: PlacedNode): { x: number; y: number } {
  return { x: node.x + node.width / 2, y: node.y + NODE_H / 2 };
}

/** A rectangle described by its centre and half extents, for edge clipping. */
export interface AnchorRect {
  /** Centre coordinates of the rectangle. */
  x: number;
  y: number;
  /** Half the rectangle's width and height. */
  halfW: number;
  halfH: number;
}

/** The border point of `rect` on the ray from its centre toward `(tx, ty)`. */
function borderPointToward(
  rect: AnchorRect,
  tx: number,
  ty: number,
): { x: number; y: number } {
  const dx = tx - rect.x;
  const dy = ty - rect.y;
  if (dx === 0 && dy === 0) {
    return { x: rect.x, y: rect.y };
  }
  const scaleX =
    dx === 0 ? Number.POSITIVE_INFINITY : rect.halfW / Math.abs(dx);
  const scaleY =
    dy === 0 ? Number.POSITIVE_INFINITY : rect.halfH / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: rect.x + dx * scale, y: rect.y + dy * scale };
}

/**
 * Clips the centre-to-centre segment between two rectangles to their borders,
 * so a connecting edge leaves the source box at its edge and meets the target
 * box at its edge instead of running through the box interior (which draws the
 * arrow on top of the box label and looks clumsy). Concentric rectangles fall
 * back to their shared centre.
 */
export function clipEdgeBetween(
  a: AnchorRect,
  b: AnchorRect,
): { x1: number; y1: number; x2: number; y2: number } {
  const start = borderPointToward(a, b.x, b.y);
  const end = borderPointToward(b, a.x, a.y);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

function edgeCalls(edge: { calls?: ChangeGraphEdgeCall[] }): ChangeGraphEdgeCall[] {
  return edge.calls ?? [];
}

interface BoxPlan {
  id: string;
  name: string;
  paths: string[];
  collapsed: boolean;
  cols: number;
  nodeWidth: number;
  width: number;
  height: number;
}

/** The box width needed to keep a title (plus its count suffix) unclipped. */
function titleWidthFor(name: string): number {
  return Math.ceil((name.length + 4) * TITLE_CHAR_W) + BOX_PAD * 2;
}

/** Plans one box's grid dimensions from the files it owns. */
function planBox(
  id: string,
  name: string,
  paths: string[],
  collapsed: boolean,
): BoxPlan {
  if (collapsed) {
    // A collapsed module shows only its title tile; no inner grid is placed.
    const width = Math.max(NODE_MIN_W, titleWidthFor(name));
    return {
      id,
      name,
      paths,
      collapsed: true,
      cols: 1,
      nodeWidth: NODE_MIN_W,
      width,
      height: COLLAPSED_BOX_H,
    };
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(paths.length)));
  const rows = Math.max(1, Math.ceil(paths.length / cols));
  // Every cell in a box shares one width (the widest label) so the grid stays
  // aligned and no label spills into its neighbour.
  const nodeWidth = paths.reduce(
    (max, path) => Math.max(max, nodeWidthFor(basename(path))),
    NODE_MIN_W,
  );
  const gridWidth = cols * nodeWidth + (cols - 1) * NODE_GAP + BOX_PAD * 2;
  // Keep the box at least as wide as its title (plus the count suffix).
  const width = Math.max(gridWidth, titleWidthFor(name));
  const height =
    BOX_TITLE_H + rows * NODE_H + (rows - 1) * NODE_GAP + BOX_PAD * 2;
  return { id, name, paths, collapsed: false, cols, nodeWidth, width, height };
}

/** Options controlling which project boxes render collapsed to a module tile. */
export interface ChangeGraphLayoutOptions {
  /** Project ids to render as a single collapsed module tile. */
  collapsed?: ReadonlySet<string>;
}

/**
 * Deterministically lays out one category of a PR's change graph: every changed
 * file becomes a node, nodes are grouped into their project's square box, boxes
 * flow left-to-right and wrap, and reference edges connect node centres. Pure
 * geometry so the render stays stable across re-renders. Only nodes of the given
 * `category` are placed, and only edges whose *both* endpoints are placed are
 * drawn, so the two graphs (code, test) stay independent.
 *
 * Projects listed in `options.collapsed` render as a single module tile instead
 * of a grid of file nodes; their file nodes are omitted and their incident edges
 * are re-anchored to the module tile (edges internal to a collapsed module are
 * dropped, and parallel module-to-module edges are merged).
 */
export function buildChangeGraphLayout(
  step: ChangeGraphStep,
  category: ChangeGraphCategory,
  options?: ChangeGraphLayoutOptions,
): ChangeGraphLayout {
  const collapsedProjects = options?.collapsed;
  const nodesInCategory = step.nodes.filter(
    (node) => node.category === category,
  );

  // Group the category's nodes by project, preserving each project's first
  // appearance order.
  const pathsByProject = new Map<string, string[]>();
  for (const node of nodesInCategory) {
    const bucket = pathsByProject.get(node.projectId);
    if (bucket) {
      bucket.push(node.path);
    } else {
      pathsByProject.set(node.projectId, [node.path]);
    }
  }

  const projectName = new Map<string, string>();
  for (const project of step.projects) {
    projectName.set(project.id, project.name);
  }

  const kindByPath = new Map<string, ChangeGraphNodeKind>();
  const projectByPath = new Map<string, string>();
  for (const node of nodesInCategory) {
    kindByPath.set(node.path, node.kind);
    projectByPath.set(node.path, node.projectId);
  }

  const plans: BoxPlan[] = [];
  for (const [projectId, paths] of pathsByProject) {
    plans.push(
      planBox(
        projectId,
        projectName.get(projectId) ?? projectId,
        paths,
        collapsedProjects?.has(projectId) ?? false,
      ),
    );
  }

  const boxes: PlacedBox[] = [];
  const nodes: PlacedNode[] = [];
  const boxRect = new Map<string, AnchorRect>();

  let rowX = 0;
  let rowY = 0;
  let rowHeight = 0;
  let canvasWidth = 0;

  for (const plan of plans) {
    if (rowX > 0 && rowX + plan.width > MAX_ROW_WIDTH) {
      rowY += rowHeight + BOX_GAP;
      rowX = 0;
      rowHeight = 0;
    }
    const boxX = rowX;
    const boxY = rowY;
    boxes.push({
      id: plan.id,
      name: plan.name,
      count: plan.paths.length,
      collapsed: plan.collapsed,
      x: boxX,
      y: boxY,
      width: plan.width,
      height: plan.height,
    });
    boxRect.set(plan.id, {
      x: boxX + plan.width / 2,
      y: boxY + plan.height / 2,
      halfW: plan.width / 2,
      halfH: plan.height / 2,
    });
    if (!plan.collapsed) {
      plan.paths.forEach((path, i) => {
        const col = i % plan.cols;
        const row = Math.floor(i / plan.cols);
        nodes.push({
          path,
          projectId: plan.id,
          label: basename(path),
          kind: kindByPath.get(path) as ChangeGraphNodeKind,
          x: boxX + BOX_PAD + col * (plan.nodeWidth + NODE_GAP),
          y: boxY + BOX_TITLE_H + BOX_PAD + row * (NODE_H + NODE_GAP),
          width: plan.nodeWidth,
        });
      });
    }
    rowX += plan.width + BOX_GAP;
    rowHeight = Math.max(rowHeight, plan.height);
    canvasWidth = Math.max(canvasWidth, rowX - BOX_GAP);
  }

  const nodeByPath = new Map<string, PlacedNode>();
  for (const node of nodes) {
    nodeByPath.set(node.path, node);
  }

  // Resolve an edge endpoint to its drawing anchor: the placed file node when
  // its module is expanded, or the collapsed module tile otherwise. The anchor
  // carries the rectangle extents so edges can be clipped to the box border.
  const anchorFor = (
    path: string,
  ): { id: string; rect: AnchorRect } | null => {
    const node = nodeByPath.get(path);
    if (node) {
      const c = nodeCenter(node);
      return {
        id: path,
        rect: { x: c.x, y: c.y, halfW: node.width / 2, halfH: NODE_H / 2 },
      };
    }
    const projectId = projectByPath.get(path);
    if (projectId === undefined) {
      return null;
    }
    // Every project id present in `projectByPath` was planned above, so its box
    // rectangle is always recorded — the lookup cannot miss.
    const rect = boxRect.get(projectId)!;
    return { id: `box:${projectId}`, rect };
  };

  const edges: PlacedEdge[] = [];
  const edgeByKey = new Map<string, PlacedEdge>();
  for (const edge of step.edges) {
    const a = anchorFor(edge.from);
    const b = anchorFor(edge.to);
    if (!a || !b || a.id === b.id) {
      // Both endpoints must resolve, and edges internal to a single collapsed
      // module (same anchor) are hidden until the module is expanded.
      continue;
    }
    const calls = edgeCalls(edge);
    const key = `${a.id}\u0000${b.id}`;
    const existing = edgeByKey.get(key);
    if (existing) {
      existing.calls = [...existing.calls, ...calls];
      existing.highlightsChanges =
        existing.highlightsChanges || calls.length > 0;
      continue;
    }
    const placed: PlacedEdge = {
      from: a.id,
      to: b.id,
      calls,
      highlightsChanges: calls.length > 0,
      ...clipEdgeBetween(a.rect, b.rect),
    };
    edgeByKey.set(key, placed);
    edges.push(placed);
  }

  const height = plans.length > 0 ? rowY + rowHeight : 0;
  return { boxes, nodes, edges, width: canvasWidth, height };
}

function placedNodeFor(
  node: ChangeGraphNode,
  x: number,
  y: number,
): PlacedNode {
  const label = basename(node.path);
  return {
    path: node.path,
    projectId: node.projectId,
    label,
    kind: node.kind,
    x,
    y,
    width: nodeWidthFor(label),
  };
}

/**
 * Builds a compact one-hop layout for a single file: the focused file is placed
 * in the middle, files that call it are placed on the left, and files it calls
 * are placed on the right. Only same-category incident edges are included.
 */
export function buildFocusedChangeGraphLayout(
  step: ChangeGraphStep,
  category: ChangeGraphCategory,
  focusPath: string,
): ChangeGraphLayout {
  const focus = step.nodes.find(
    (node) => node.path === focusPath && node.category === category,
  );
  if (!focus) {
    return { boxes: [], nodes: [], edges: [], width: 0, height: 0 };
  }

  const nodeByPath = new Map(
    step.nodes
      .filter((node) => node.category === category)
      .map((node) => [node.path, node]),
  );
  const incidentEdges = step.edges.filter(
    (edge) =>
      (edge.from === focusPath || edge.to === focusPath) &&
      nodeByPath.has(edge.from) &&
      nodeByPath.has(edge.to),
  );

  const leftPaths = new Set<string>();
  const rightPaths = new Set<string>();
  for (const edge of incidentEdges) {
    if (edge.to === focusPath) {
      leftPaths.add(edge.from);
    }
    if (edge.from === focusPath) {
      rightPaths.add(edge.to);
    }
  }
  for (const path of leftPaths) {
    if (rightPaths.has(path)) {
      leftPaths.delete(path);
    }
  }

  const ordered = step.nodes.map((node) => node.path);
  const left = ordered.filter((path) => leftPaths.has(path));
  const right = ordered.filter((path) => rightPaths.has(path));
  const leftWidth = left.reduce(
    (max, path) => Math.max(max, nodeWidthFor(basename(path))),
    0,
  );
  const focusWidth = nodeWidthFor(basename(focus.path));
  const rightWidth = right.reduce(
    (max, path) => Math.max(max, nodeWidthFor(basename(path))),
    0,
  );
  const sideRows = Math.max(left.length, right.length, 1);
  const height = Math.max(
    NODE_H,
    sideRows * NODE_H + (sideRows - 1) * FOCUSED_ROW_GAP,
  );
  const focusX = leftWidth > 0 ? leftWidth + FOCUSED_COL_GAP : 0;
  const rightX = focusX + focusWidth + (rightWidth > 0 ? FOCUSED_COL_GAP : 0);
  const focusY = Math.round((height - NODE_H) / 2);
  const nodes: PlacedNode[] = [];

  left.forEach((path, i) => {
    nodes.push(
      placedNodeFor(
        nodeByPath.get(path) as ChangeGraphNode,
        0,
        i * (NODE_H + FOCUSED_ROW_GAP),
      ),
    );
  });
  nodes.push(placedNodeFor(focus, focusX, focusY));
  right.forEach((path, i) => {
    nodes.push(
      placedNodeFor(
        nodeByPath.get(path) as ChangeGraphNode,
        rightX,
        i * (NODE_H + FOCUSED_ROW_GAP),
      ),
    );
  });

  const placedByPath = new Map(nodes.map((node) => [node.path, node]));
  const edges: PlacedEdge[] = [];
  for (const edge of incidentEdges) {
    const from = placedByPath.get(edge.from) as PlacedNode;
    const to = placedByPath.get(edge.to) as PlacedNode;
    const a = nodeCenter(from);
    const b = nodeCenter(to);
    edges.push({
      from: edge.from,
      to: edge.to,
      calls: edgeCalls(edge),
      highlightsChanges: edgeCalls(edge).length > 0,
      ...clipEdgeBetween(
        { x: a.x, y: a.y, halfW: from.width / 2, halfH: NODE_H / 2 },
        { x: b.x, y: b.y, halfW: to.width / 2, halfH: NODE_H / 2 },
      ),
    });
  }

  const width = rightWidth > 0 ? rightX + rightWidth : focusX + focusWidth;
  return { boxes: [], nodes, edges, width, height };
}

/** Looks up a node in a step by path, for the selection panel. */
export function findNode(
  step: ChangeGraphStep,
  path: string,
): ChangeGraphNode | null {
  return step.nodes.find((node) => node.path === path) ?? null;
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  findNode,
  fitZoom,
  formatEdgeLabel,
  NODE_H,
  type FlowRole,
} from '../../lib/change-graph-layout.js';
import { useChangeGraphLayout } from './use-change-graph-layout.js';
import { segmentTestMethods, segmentAnnotatedTestMethods } from '../../lib/test-method-diff.js';
import type {
  ChangeGraphAnnotations,
  ChangeGraphCategory,
  ChangeGraphNode,
  ChangeGraphStep,
  PrChangeKind,
  TestMethodExplanation,
} from '../../lib/types.js';
import {
  CommentableDiff,
  CommentableDiffLines,
  FileLevelThreads,
  type PrCommentsController,
} from './pr-comments.js';
import { GraphChat, FindingChat, type GraphChatSend } from './graph-chat.js';
import { AiIcon, AiChatIcon } from '../../components/icons.js';
import { rightSideLines } from '../../lib/diff-lines.js';

/** Placeholders the backend writes for a file whose English is not yet produced. */
const UNEXPLAINED_WHAT_IT_DOES = 'No description was produced for this file.';
const UNEXPLAINED_WHAT_CHANGED = 'No change summary was produced.';

/** Padding added around the placed layout so labels are never clipped. */
const CANVAS_PAD = 40;
const FOCUSED_CANVAS_PAD = 28;

/** A user-applied positional offset (in SVG units) for a draggable element. */
interface DragOffset {
  dx: number;
  dy: number;
}

const ZERO_OFFSET: DragOffset = { dx: 0, dy: 0 };

/**
 * Lets the user drag graph elements (module boxes, or focused-view file nodes)
 * to reposition them at will, on top of the deterministic auto-layout. Offsets
 * are keyed by a stable id (project id or file path) and expressed in SVG units,
 * so they stay correct under zoom (a client-pixel delta is divided by the live
 * zoom). Pointer capture keeps a drag tracking even when the cursor briefly
 * leaves the element. `moved` distinguishes a real drag from a click so the
 * trailing click never doubles as a select/expand.
 */
function useDragOffsets(zoom: number) {
  const [offsets, setOffsets] = useState<Record<string, DragOffset>>({});
  const state = useRef<{
    id: string;
    x: number;
    y: number;
    dx0: number;
    dy0: number;
  } | null>(null);
  const moved = useRef(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const start = (e: React.PointerEvent, id: string) => {
    // Keep the canvas pan (bound to the scroll container) from also firing.
    e.stopPropagation();
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture is best-effort */
    }
    const current = offsets[id] ?? ZERO_OFFSET;
    state.current = {
      id,
      x: e.clientX,
      y: e.clientY,
      dx0: current.dx,
      dy0: current.dy,
    };
    moved.current = false;
  };

  const move = (e: React.PointerEvent) => {
    const d = state.current;
    if (!d) {
      return;
    }
    const mdx = e.clientX - d.x;
    const mdy = e.clientY - d.y;
    if (Math.abs(mdx) + Math.abs(mdy) > 3) {
      moved.current = true;
    }
    const z = zoomRef.current || 1;
    setOffsets((prev) => ({
      ...prev,
      [d.id]: { dx: d.dx0 + mdx / z, dy: d.dy0 + mdy / z },
    }));
  };

  const end = (e: React.PointerEvent) => {
    if (!state.current) {
      return;
    }
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* nothing to release */
    }
    state.current = null;
  };

  const of = (id: string): DragOffset => offsets[id] ?? ZERO_OFFSET;
  const reset = () => setOffsets({});

  const handlers = (id: string) => ({
    onPointerDown: (e: React.PointerEvent) => start(e, id),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
  });

  return { of, reset, handlers, movedRef: moved };
}

/** A positioned rectangle (already including any drag offset). */
interface ExtentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The bounding extent of all graph content, never smaller than the base layout
 * size. Because dragged nodes/boxes carry offsets that can push them outside the
 * original layout box (in any direction), the SVG viewBox must grow to enclose
 * them — otherwise the diagram is clipped/truncated the moment a tile is dragged
 * past an edge. `minX`/`minY` can go negative (drag up/left); callers translate
 * the content by `pad - min` so nothing is ever cut off and scrollbars appear.
 */
function contentExtent(
  baseW: number,
  baseH: number,
  rects: ExtentRect[],
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = 0;
  let minY = 0;
  let maxX = baseW;
  let maxY = baseH;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Whether a node still carries the build-time placeholders rather than a real,
 * on-demand English explanation. The deterministic graph writes placeholders for
 * every node; the plain-English description is fetched lazily when clicked.
 */
function nodeNeedsExplanation(node: ChangeGraphNode): boolean {
  return (
    node.whatItDoes.trim().length === 0 ||
    node.whatItDoes === UNEXPLAINED_WHAT_IT_DOES ||
    node.whatChanged.trim().length === 0 ||
    node.whatChanged === UNEXPLAINED_WHAT_CHANGED
  );
}

/**
 * The syntactic-review findings for a node, normalised to a string list. Tolerates
 * legacy persisted reviews that stored a single prose string (split into lines)
 * so a graph produced before the list contract still renders as findings.
 */
function reviewFindings(review: ChangeGraphNode['review']): string[] {
  const raw = Array.isArray(review)
    ? review
    : typeof review === 'string'
      ? (review as string).split('\n')
      : [];
  return raw
    .map((entry) => String(entry).replace(/^[-*\u2022]\s*/, '').trim())
    .filter((entry) => entry.length > 0);
}

/** Human label for a change kind, tuned for the code vs test legend. */
function changeKindLabel(
  kind: PrChangeKind,
  category: ChangeGraphCategory,
): string {
  if (category === 'test') {
    if (kind === 'added') {
      return 'New test';
    }
    if (kind === 'deleted') {
      return 'Removed test';
    }
    return 'Updated test';
  }
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** The change kinds shown in a category's legend, in display order. */
const LEGEND_KINDS: PrChangeKind[] = ['added', 'modified', 'deleted', 'renamed'];

/** Renders a unified diff with per-line +/- colour coding. */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, '').split('\n');
  return (
    <pre className="cg-diff" aria-label="File diff">
      {lines.map((line, i) => {
        const first = line.charAt(0);
        const cls =
          first === '+' && !line.startsWith('+++')
            ? 'cg-diff-add'
            : first === '-' && !line.startsWith('---')
              ? 'cg-diff-del'
              : first === '@'
                ? 'cg-diff-hunk'
                : line.startsWith('diff ') ||
                    line.startsWith('index ') ||
                    line.startsWith('+++') ||
                    line.startsWith('---')
                  ? 'cg-diff-meta'
                  : 'cg-diff-ctx';
        return (
          <span key={i} className={`cg-diff-line ${cls}`}>
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}

/** Finds the per-method explanation whose name matches a diff segment's name. */
function explanationForSegment(
  name: string | null,
  methods: TestMethodExplanation[],
): string | null {
  if (!name) {
    return null;
  }
  const target = name.trim().toLowerCase();
  const hit = methods.find((m) => {
    const candidate = m.name.trim().toLowerCase();
    return (
      candidate === target ||
      candidate.includes(target) ||
      target.includes(candidate)
    );
  });
  return hit?.whatChanged.trim() || null;
}

/**
 * Renders a test file's diff split into per-test-method blocks: each block is
 * headed by the method name (or "File setup" for the preamble), badged when the
 * PR changed it, and — when the backend produced one — carries a plain-English
 * explanation of what changed in that specific test. Falls back to a single
 * plain diff when the file could not be segmented into methods.
 */
function SegmentedDiffView({
  diff,
  methods,
}: {
  diff: string;
  methods: TestMethodExplanation[];
}) {
  const segments = useMemo(() => segmentTestMethods(diff), [diff]);
  if (segments.length <= 1) {
    return <DiffView diff={diff} />;
  }
  return (
    <div className="cg-test-methods">
      {segments.map((segment, i) => {
        const explanation = explanationForSegment(segment.name, methods);
        return (
          <div
            key={i}
            className={`cg-test-method${segment.changed ? ' cg-test-method-changed' : ''}`}
          >
            <div className="cg-test-method-head">
              <span className="cg-test-method-name">
                {segment.name ?? 'File setup'}
              </span>
              {segment.changed && (
                <span className="cg-test-method-badge">Changed</span>
              )}
            </div>
            {explanation && (
              <p className="cg-test-method-explain">{explanation}</p>
            )}
            <DiffView diff={segment.diff} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The commentable counterpart of {@link SegmentedDiffView}: a test file's diff
 * split into per-test-method blocks (each headed by the method name, badged when
 * changed, and carrying its plain-English explanation), where every new-side
 * line is clickable to post an inline PR comment — the same commenting the code
 * diff offers. File-level threads render once above all segments so they are not
 * duplicated per method. Falls back to a single whole-file commentable diff when
 * the file could not be segmented into methods.
 */
function CommentableSegmentedDiff({
  comments,
  path,
  diff,
  methods,
}: {
  comments: PrCommentsController;
  path: string;
  diff: string;
  methods: TestMethodExplanation[];
}) {
  const segments = useMemo(() => segmentAnnotatedTestMethods(diff), [diff]);
  if (segments.length <= 1) {
    return <CommentableDiff comments={comments} path={path} diff={diff} />;
  }
  const presentLines = new Set<number>();
  for (const segment of segments) {
    for (const line of segment.lines) {
      if (line.rightLine !== null) {
        presentLines.add(line.rightLine);
      }
    }
  }
  return (
    <div className="cg-test-methods">
      <FileLevelThreads comments={comments} path={path} presentLines={presentLines} />
      {segments.map((segment, i) => {
        const explanation = explanationForSegment(segment.name, methods);
        return (
          <div
            key={i}
            className={`cg-test-method${segment.changed ? ' cg-test-method-changed' : ''}`}
          >
            <div className="cg-test-method-head">
              <span className="cg-test-method-name">
                {segment.name ?? 'File setup'}
              </span>
              {segment.changed && (
                <span className="cg-test-method-badge">Changed</span>
              )}
            </div>
            {explanation && (
              <p className="cg-test-method-explain">{explanation}</p>
            )}
            <CommentableDiffLines
              comments={comments}
              path={path}
              lines={segment.lines}
            />
          </div>
        );
      })}
    </div>
  );
}

function FocusedFileGraph({
  step,
  category,
  focusPath,
  onNavigate,
  onChat,
}: {
  step: ChangeGraphStep;
  category: ChangeGraphCategory;
  focusPath: string;
  /** Opens another node's file popup when its tile is clicked. */
  onNavigate?: (path: string) => void;
  /** Sends a turn of the "explain this diagram" chat; enables the AI panel. */
  onChat?: GraphChatSend;
}) {
  const [showCallers, setShowCallers] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // Whether any external caller (blue boundary node) exists for this category,
  // so the toggle can be disabled when there is nothing to reveal.
  const hasBoundary = useMemo(
    () =>
      step.nodes.some(
        (node) => node.category === category && node.kind === 'boundary',
      ),
    [step.nodes, category],
  );
  // With callers hidden, drop boundary nodes of this category (and any edge that
  // touches them) so the focused view shows only the change and its real
  // neighbours instead of a hairball of external callers.
  const layoutStep = useMemo<ChangeGraphStep>(() => {
    if (showCallers) {
      return step;
    }
    const nodes = step.nodes.filter(
      (node) => !(node.category === category && node.kind === 'boundary'),
    );
    const remaining = new Set(nodes.map((node) => node.path));
    const edges = step.edges.filter(
      (edge) => remaining.has(edge.from) && remaining.has(edge.to),
    );
    return { ...step, nodes, edges };
  }, [step, category, showCallers]);
  const layout = useChangeGraphLayout({
    kind: 'focused',
    step: layoutStep,
    category,
    focusPath,
  });

  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Per-file drag offsets so the user can pull individual nodes apart at will.
  const nodeDrag = useDragOffsets(zoom);
  // Grow the viewBox to enclose every node including its live drag offset, so a
  // node dragged past the original layout edge is never clipped; the content is
  // then translated by `pad - min` and the scroll container reveals the rest.
  const { minX, minY, maxX, maxY } = contentExtent(
    layout.width,
    layout.height,
    layout.nodes.map((n) => {
      const off = nodeDrag.of(n.path);
      return { x: n.x + off.dx, y: n.y + off.dy, w: n.width, h: NODE_H };
    }),
  );
  const viewW = Math.max(360, maxX - minX + FOCUSED_CANVAS_PAD * 2);
  const viewH = Math.max(132, maxY - minY + FOCUSED_CANVAS_PAD * 2);
  const originX = FOCUSED_CANVAS_PAD - minX;
  const originY = FOCUSED_CANVAS_PAD - minY;
  // Fit the focused graph within its visible canvas on load and when the
  // available space changes, so it opens fully visible instead of overflowing.
  // Keyed on natural size + fullscreen (not zoom) so manual zoom is preserved.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    setZoom(fitZoom(el.clientWidth, el.clientHeight, viewW, viewH));
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }, [viewW, viewH, fullscreen]);
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(
    null,
  );
  useEffect(() => {
    if (!fullscreen) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) {
      return;
    }
    e.preventDefault();
    setZoom((z) => Math.min(2.4, Math.max(0.4, z - e.deltaY * 0.0012)));
  }
  function onPointerDown(e: React.PointerEvent) {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      sl: el.scrollLeft,
      st: el.scrollTop,
    };
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    const el = scrollRef.current;
    if (!d || !el) {
      return;
    }
    el.scrollLeft = d.sl - (e.clientX - d.x);
    el.scrollTop = d.st - (e.clientY - d.y);
  }
  function onPointerUp() {
    drag.current = null;
  }

  const svg = (
    <svg
      className="cg-focused-svg"
      width={viewW * zoom}
      height={viewH * zoom}
      viewBox={`0 0 ${viewW} ${viewH}`}
      role="img"
      aria-label="Focused file connection graph"
    >
      <defs>
        <marker
          id="cg-focused-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="cg-arrow-head" />
        </marker>
        <marker
          id="cg-focused-arrow-pr"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="cg-arrow-head-pr" />
        </marker>
      </defs>
      <g transform={`translate(${originX} ${originY})`}>
        {layout.edges.map((edge) => {
          const label = formatEdgeLabel(edge.calls);
          const highlighted = edge.highlightsChanges;
          const offFrom = nodeDrag.of(edge.from);
          const offTo = nodeDrag.of(edge.to);
          const x1 = edge.x1 + offFrom.dx;
          const y1 = edge.y1 + offFrom.dy;
          const x2 = edge.x2 + offTo.dx;
          const y2 = edge.y2 + offTo.dy;
          return (
            <g key={`${edge.from}->${edge.to}`} className="cg-focused-edge">
              <line
                className={`cg-link${highlighted ? ' cg-link-pr' : ''}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                markerEnd={
                  highlighted
                    ? 'url(#cg-focused-arrow-pr)'
                    : 'url(#cg-focused-arrow)'
                }
              />
              {label && (
                <text
                  className={`cg-link-label${highlighted ? ' cg-link-label-pr' : ''}`}
                  x={(x1 + x2) / 2}
                  y={(y1 + y2) / 2 - 7}
                  textAnchor="middle"
                >
                  {label}
                </text>
              )}
            </g>
          );
        })}
        {layout.nodes.map((node) => {
          const isFocus = node.path === focusPath;
          const clickable = !isFocus && onNavigate !== undefined;
          const off = nodeDrag.of(node.path);
          return (
            <g
              key={node.path}
              className={`cg-filenode cg-draggable cg-filenode-${node.kind}${node.flow ? ` cg-flow-${node.flow}` : ''}${isFocus ? ' cg-filenode-selected' : ''}${clickable ? ' cg-filenode-nav' : ''}`}
              transform={`translate(${node.x + off.dx} ${node.y + off.dy})`}
              {...nodeDrag.handlers(node.path)}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={clickable ? `Open ${node.label}` : undefined}
              onClick={
                clickable
                  ? () => {
                      if (nodeDrag.movedRef.current) {
                        return;
                      }
                      onNavigate(node.path);
                    }
                  : undefined
              }
              onKeyDown={
                clickable
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onNavigate(node.path);
                      }
                    }
                  : undefined
              }
            >
              <rect
                className="cg-filenode-rect"
                width={node.width}
                height={NODE_H}
                rx={6}
              />
              <text
                className="cg-filenode-label"
                x={node.width / 2}
                y={NODE_H / 2 + 4}
                textAnchor="middle"
              >
                {node.label}
              </text>
              {node.flow && (
                <FlowMarker flow={node.flow} nodeWidth={node.width} />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );

  const controls = (
    <div className="cg-controls" role="group" aria-label="Zoom controls">
      {onChat && (
        <button
          type="button"
          className={`cg-ai-toggle${chatOpen ? ' cg-ai-on' : ''}`}
          onClick={() => setChatOpen((o) => !o)}
          aria-pressed={chatOpen}
          title="Explain this diagram and ask questions about it"
        >
          <AiIcon size={14} /> Explain
        </button>
      )}
      <button
        type="button"
        className={`cg-callers-toggle${showCallers ? ' cg-callers-on' : ''}`}
        onClick={() => setShowCallers((s) => !s)}
        aria-pressed={showCallers}
        disabled={!hasBoundary && !showCallers}
        title={
          !hasBoundary
            ? 'No external callers were found for these changes'
            : showCallers
              ? 'Hide external callers to focus on the changed files'
              : 'Show external callers (the files that call the changed code)'
        }
      >
        {showCallers ? 'Hide callers' : 'Show external callers'}
      </button>
      <button
        type="button"
        onClick={() => setZoom((z) => Math.min(2.4, z + 0.2))}
        aria-label="Zoom in"
      >
        +
      </button>
      <button
        type="button"
        onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}
        aria-label="Zoom out"
      >
        −
      </button>
      <button
        type="button"
        onClick={() => {
          setZoom(1);
          nodeDrag.reset();
          scrollRef.current?.scrollTo({ top: 0, left: 0 });
        }}
        aria-label="Reset view"
      >
        ⟲
      </button>
      <button
        type="button"
        onClick={() => setFullscreen((f) => !f)}
        aria-label={fullscreen ? 'Exit full screen' : 'Open full screen'}
        title={fullscreen ? 'Exit full screen (Esc)' : 'Open full screen'}
      >
        {fullscreen ? '×' : '⛶'}
      </button>
    </div>
  );

  const body = (
    <div className={`cg-focused-wrap${fullscreen ? ' cg-focused-full' : ''}`}>
      <div
        className="cg-scroll"
        ref={scrollRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {svg}
      </div>
      {controls}
      {onChat && chatOpen && (
        <GraphChat
          category={category}
          onSend={onChat}
          onClose={() => setChatOpen(false)}
        />
      )}
      {layout.edges.length === 0 && !fullscreen && (
        <p className="muted">No direct file connections were found for this file.</p>
      )}
    </div>
  );

  return fullscreen
    ? createPortal(
        <div
          className="cg-fullscreen cg-fullscreen-over"
          role="dialog"
          aria-modal="true"
          aria-label="Focused file diagram full screen"
        >
          {body}
        </div>,
        document.body,
      )
    : body;
}

/** The detail panel content for the currently selected node. */
function SelectionPanel({
  step,
  node,
  category,
  explaining,
  comments,
  onClose,
  onNavigate,
  onChat,
}: {
  step: ChangeGraphStep;
  node: ChangeGraphNode;
  category: ChangeGraphCategory;
  explaining: boolean;
  comments?: PrCommentsController;
  onClose: () => void;
  /** Replaces the popup with another file's popup (clicked in the node graph). */
  onNavigate?: (path: string) => void;
  /** Sends a turn of the focused diagram's "explain this" chat; enables it. */
  onChat?: GraphChatSend;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const [activeFinding, setActiveFinding] = useState<number | null>(null);
  const label = node.path.split(/[\\/]/).pop() ?? node.path;
  if (node.kind === 'boundary') {
    return createPortal(
      <div className="cg-modal-overlay" onClick={onClose}>
        <aside
          className="cg-panel"
          aria-label={`${label} details`}
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="cg-panel-head">
            <span className="cg-panel-kind cg-panel-kind-boundary">Caller</span>
            <button
              type="button"
              className="cg-panel-close"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </header>
          <h4 className="cg-panel-title">{label}</h4>
          <p className="cg-panel-path">{node.path}</p>
          {node.module && (
            <p className="cg-panel-summary">Module: {node.module}</p>
          )}
          <div className="cg-panel-section">
            <span className="cg-panel-label">Why it's shown</span>
            <p>
              This file is not part of the PR. It calls into the changed code, so
              it marks the boundary of who is calling the change.
            </p>
          </div>
        </aside>
      </div>,
      document.body,
    );
  }
  const pendingExplanation = explaining && nodeNeedsExplanation(node);
  return createPortal(
    <div className="cg-modal-overlay" onClick={onClose}>
      <aside
        className="cg-panel"
        aria-label={`${label} details`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cg-panel-head">
          <span className="cg-panel-kind cg-panel-kind-file">File</span>
          {node.changeKind && (
            <span className={`cg-badge cg-badge-${node.changeKind}`}>
              {changeKindLabel(node.changeKind, category)}
            </span>
          )}
          <button
            type="button"
            className="cg-panel-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <h4 className="cg-panel-title">{label}</h4>
        <p className="cg-panel-path">{node.path}</p>
        {node.module && (
          <p className="cg-panel-summary">Module: {node.module}</p>
        )}
        <div className="cg-panel-section">
          <span className="cg-panel-label">What this does</span>
          {pendingExplanation ? (
            <p className="cg-panel-explaining muted">
              <span className="cg-spinner" aria-hidden="true" />
              Explaining this file…
            </p>
          ) : (
            <p>{node.whatItDoes}</p>
          )}
        </div>
        {!pendingExplanation && (
          <div className="cg-panel-section">
            <span className="cg-panel-label">
              {category === 'test'
                ? 'What this test change means'
                : 'What this change means'}
            </span>
            <p>{node.whatChanged}</p>
          </div>
        )}
        <div className="cg-panel-section">
          <span className="cg-panel-label">Focused node diagram</span>
          <FocusedFileGraph
            step={step}
            category={category}
            focusPath={node.path}
            onNavigate={onNavigate}
            onChat={onChat}
          />
        </div>
        <div className="cg-panel-section">
          <span className="cg-panel-label">
            {category === 'test'
              ? 'Test diff — grouped by test method · click a line to comment'
              : 'Code diff — click a line to comment'}
          </span>
          {node.diff.trim() ? (
            category === 'test' ? (
              comments ? (
                <CommentableSegmentedDiff
                  comments={comments}
                  path={node.path}
                  diff={node.diff}
                  methods={node.testMethods ?? []}
                />
              ) : (
                <SegmentedDiffView
                  diff={node.diff}
                  methods={node.testMethods ?? []}
                />
              )
            ) : comments ? (
              <CommentableDiff
                comments={comments}
                path={node.path}
                diff={node.diff}
              />
            ) : (
              <DiffView diff={node.diff} />
            )
          ) : (
            <p className="muted">
              No diff is available for this file (it may have been truncated from
              the bounded PR diff).
            </p>
          )}
        </div>
        {!pendingExplanation &&
          (() => {
            const findings = reviewFindings(node.review);
            const anchorLine = (() => {
              if (!node.diff) return null;
              const rl = rightSideLines(node.diff);
              const hit = rl.find((l) => l.kind === 'added') ?? rl[0];
              return hit ? hit.line : null;
            })();
            const onFindingComment =
              comments && anchorLine != null
                ? async (body: string) =>
                    (await comments.add({
                      path: node.path,
                      line: anchorLine,
                      body,
                    })) != null
                : undefined;
            return (
              <div className="cg-panel-section">
                <span className="cg-panel-label">Syntactic review</span>
                {findings.length === 0 ? (
                  <p className="cg-review-clean">
                    ✓ Syntactically the file is looking fine.
                  </p>
                ) : (
                  <ul className="cg-review-list">
                    {findings.map((finding, i) => (
                      <li key={i} className="cg-finding">
                        <div className="cg-finding-row">
                          <span className="cg-finding-text">{finding}</span>
                          {onChat && (
                            <button
                              type="button"
                              className={`cg-finding-ai${
                                activeFinding === i ? ' is-active' : ''
                              }`}
                              onClick={() =>
                                setActiveFinding(
                                  activeFinding === i ? null : i,
                                )
                              }
                              aria-label="Discuss this finding with AI"
                              aria-expanded={activeFinding === i}
                              title="Discuss, fix, or comment with AI"
                            >
                              <AiChatIcon size={15} />
                            </button>
                          )}
                        </div>
                        {activeFinding === i && onChat && (
                          <FindingChat
                            finding={finding}
                            filePath={node.path}
                            category={category}
                            onSend={onChat}
                            onComment={onFindingComment}
                            onClose={() => setActiveFinding(null)}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })()}
      </aside>
    </div>,
    document.body,
  );
}

/**
 * A small pinned note the "Explain" chat attaches to a node. Rendered as a
 * label chip below the node so the reviewer sees the AI's annotation in place on
 * the diagram. Long text is clipped by the backend, so it always fits one line.
 */
function NoteBadge({ text, nodeWidth }: { text: string; nodeWidth: number }) {
  return (
    <g className="cg-note" transform={`translate(0 ${NODE_H + 4})`}>
      <title>{text}</title>
      <rect
        className="cg-note-rect"
        x={0}
        y={0}
        width={nodeWidth}
        height={16}
        rx={4}
      />
      <text className="cg-note-text" x={nodeWidth / 2} y={11} textAnchor="middle">
        {text}
      </text>
    </g>
  );
}


/** A colour-coded legend for the change kinds present in this category. */
function Legend({
  kinds,
  category,
  hasBoundary,
  hasStart,
  hasEnd,
}: {
  kinds: Set<PrChangeKind>;
  category: ChangeGraphCategory;
  hasBoundary: boolean;
  hasStart: boolean;
  hasEnd: boolean;
}) {
  const shown = LEGEND_KINDS.filter((kind) => kinds.has(kind));
  if (shown.length === 0 && !hasBoundary && !hasStart && !hasEnd) {
    return null;
  }
  return (
    <div className="cg-legend" aria-label="Legend">
      {shown.map((kind) => (
        <span key={kind} className="cg-legend-item">
          <span className={`cg-legend-dot cg-badge-${kind}`} aria-hidden="true" />
          {changeKindLabel(kind, category)}
        </span>
      ))}
      {hasBoundary && (
        <span className="cg-legend-item">
          <span className="cg-legend-dot cg-legend-dot-boundary" aria-hidden="true" />
          Calls the change
        </span>
      )}
      {hasStart && (
        <span className="cg-legend-item">
          <svg className="cg-legend-flow" width="12" height="12" aria-hidden="true">
            <FlowGlyph flow="start" cx={6} cy={6} />
          </svg>
          Flow start (entry)
        </span>
      )}
      {hasEnd && (
        <span className="cg-legend-item">
          <svg className="cg-legend-flow" width="12" height="12" aria-hidden="true">
            <FlowGlyph flow="end" cx={6} cy={6} />
          </svg>
          Flow end (leaf)
        </span>
      )}
    </div>
  );
}

/** The bare shape for a flow marker: a triangle for `start`, a square for `end`. */
function FlowGlyph({
  flow,
  cx,
  cy,
}: {
  flow: FlowRole;
  cx: number;
  cy: number;
}) {
  return flow === 'start' ? (
    <path
      className="cg-flow-glyph"
      d={`M ${cx - 3} ${cy - 3.4} L ${cx + 3.4} ${cy} L ${cx - 3} ${cy + 3.4} Z`}
    />
  ) : (
    <rect
      className="cg-flow-glyph"
      x={cx - 3}
      y={cy - 3}
      width={6}
      height={6}
      rx={1}
    />
  );
}

/**
 * A small entry (`start`) / leaf (`end`) marker drawn at a placed node's
 * top-right corner. The shape (triangle vs. square) — not just colour — encodes
 * the role, so the marker stays legible for colour-blind users.
 */
function FlowMarker({ flow, nodeWidth }: { flow: FlowRole; nodeWidth: number }) {
  const cx = nodeWidth - 6;
  const cy = 0;
  return (
    <g className={`cg-flow-marker cg-flow-marker-${flow}`}>
      <title>
        {flow === 'start'
          ? 'Flow start — entry point (nothing calls it)'
          : 'Flow end — leaf (calls nothing)'}
      </title>
      <circle className="cg-flow-badge" cx={cx} cy={cy} r={6.5} />
      <FlowGlyph flow={flow} cx={cx} cy={cy} />
    </g>
  );
}

/**
 * A deterministic reference graph of a PR's changed files for one `category`.
 * Every changed file is an orange node grouped into its project's square box;
 * directed edges connect a file to the changed files whose types it references.
 * Clicking a node reveals what it does, what the change means and the actual
 * diff (the English is fetched lazily). Scroll to zoom, drag to pan.
 */
export function ChangeGraph({
  step,
  category,
  explaining,
  onExplainFile,
  onChat,
  comments,
}: {
  step: ChangeGraphStep;
  category: ChangeGraphCategory;
  /** Paths whose lazy English explanation is currently being generated. */
  explaining?: ReadonlySet<string>;
  /** Requests the on-demand English explanation for a file's diff. */
  onExplainFile?: (path: string) => void;
  /** Sends a turn of the "explain this diagram" chat; enables the AI panel. */
  onChat?: GraphChatSend;
  /** Live PR comments controller; enables the inline comment box in the popup. */
  comments?: PrCommentsController;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  // A diagram overlay the "Explain" chat can attach to its answers: spotlighted
  // nodes, an ordered flow to trace, and short notes pinned to files. Cleared
  // with the toolbar button. Null until the chat returns an overlay.
  const [annotations, setAnnotations] = useState<ChangeGraphAnnotations | null>(
    null,
  );
  // Zoom multiplies the SVG's pixel size; navigation is native scrolling inside
  // the box (see cg-scroll), so a graph larger than the box always gets real
  // scrollbars instead of overflowing the card and pushing controls off-screen.
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The graph opens focused on the changed files themselves. External callers
  // ("Calls the change" — blue boundary nodes) are what turn a large PR into an
  // edge hairball, so they are hidden by default and revealed on demand. No
  // information is lost: the toggle brings every caller and edge straight back.
  const [showCallers, setShowCallers] = useState(false);
  // Opens the whole canvas as a full-viewport overlay so a dense graph has room
  // to breathe and every control stays reachable regardless of the card size.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);
  // Project ids the user has expanded from their default collapsed module tile.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(
    null,
  );
  // True once the pointer has moved far enough to count as a pan, so the trailing
  // click after a drag is not misread as a node selection.
  const panned = useRef(false);

  // The step actually laid out: with callers hidden, boundary nodes of this
  // category and every edge touching them are dropped, so the canvas shows only
  // the changed modules and the calls between them. Projects that existed solely
  // to host a caller disappear too, which is what tames the hairball.
  const layoutStep = useMemo<ChangeGraphStep>(() => {
    if (showCallers) {
      return step;
    }
    const nodes = step.nodes.filter(
      (node) => !(node.category === category && node.kind === 'boundary'),
    );
    const remaining = new Set(nodes.map((node) => node.path));
    const edges = step.edges.filter(
      (edge) => remaining.has(edge.from) && remaining.has(edge.to),
    );
    return { ...step, nodes, edges };
  }, [step, category, showCallers]);

  // Every project/module is collapsible so the graph opens as a broad, module
  // level overview: each project renders as a single tile with merged
  // module→module edges instead of a hairball of individual files. Clicking a
  // tile expands just that module to reveal its files and their edges.
  const collapsible = useMemo(() => {
    const set = new Set<string>();
    for (const node of layoutStep.nodes) {
      if (node.category === category) {
        set.add(node.projectId);
      }
    }
    return set;
  }, [layoutStep.nodes, category]);

  const collapsedSet = useMemo(() => {
    const set = new Set<string>();
    for (const id of collapsible) {
      if (!expanded.has(id)) {
        set.add(id);
      }
    }
    return set;
  }, [collapsible, expanded]);

  const collapsedList = useMemo(() => [...collapsedSet], [collapsedSet]);
  const layout = useChangeGraphLayout({
    kind: 'full',
    step: layoutStep,
    category,
    collapsed: collapsedList,
  });
  // User-applied drag offsets keyed by project id. Dragging a module box moves
  // the box, its file nodes, and every edge endpoint anchored to that module, so
  // the whole module travels together and its connections stay attached.
  const boxDrag = useDragOffsets(zoom);
  // Maps a placed file node's path to its owning project so an edge endpoint
  // that anchors on a node (expanded module) still shifts with that module.
  const nodeProject = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of layout.nodes) {
      map.set(node.path, node.projectId);
    }
    return map;
  }, [layout.nodes]);
  // Resolves an edge endpoint's anchor id to the project whose offset moves it:
  // a `box:<id>` tile anchor, or a file-node path inside an expanded module.
  const projectOfAnchor = (anchorId: string): string | undefined =>
    anchorId.startsWith('box:') ? anchorId.slice(4) : nodeProject.get(anchorId);
  const offsetOfAnchor = (anchorId: string): DragOffset => {
    const projectId = projectOfAnchor(anchorId);
    return projectId === undefined ? ZERO_OFFSET : boxDrag.of(projectId);
  };
  const kindsPresent = useMemo(() => {
    const set = new Set<PrChangeKind>();
    for (const node of step.nodes) {
      if (node.category === category && node.changeKind) {
        set.add(node.changeKind);
      }
    }
    return set;
  }, [step.nodes, category]);
  const hasBoundary = useMemo(
    () =>
      step.nodes.some(
        (node) => node.category === category && node.kind === 'boundary',
      ),
    [step.nodes, category],
  );
  // Projects that contain at least one changed file in this category. Their
  // module tiles are tinted light orange so a glance shows which modules the PR
  // actually changes, versus modules shown only because they call the change.
  const changedProjects = useMemo(() => {
    const set = new Set<string>();
    for (const node of step.nodes) {
      if (node.category === category && node.kind === 'changed') {
        set.add(node.projectId);
      }
    }
    return set;
  }, [step.nodes, category]);

  // Derived overlay lookups: which nodes are spotlighted, which node carries a
  // pinned note, and which directed file pairs form the traced flow. The flow is
  // matched in both directions so it highlights the diagram edge regardless of
  // whether the call flows with or against the reference arrow.
  const highlightSet = useMemo(
    () => new Set(annotations?.highlight ?? []),
    [annotations],
  );
  const noteByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const note of annotations?.notes ?? []) {
      map.set(note.path, note.text);
    }
    return map;
  }, [annotations]);
  const flowEdgeSet = useMemo(() => {
    const set = new Set<string>();
    const flow = annotations?.focusFlow ?? [];
    for (let i = 0; i + 1 < flow.length; i += 1) {
      set.add(`${flow[i]}\u0000${flow[i + 1]}`);
      set.add(`${flow[i + 1]}\u0000${flow[i]}`);
    }
    return set;
  }, [annotations]);
  const hasAnnotations =
    highlightSet.size > 0 || noteByPath.size > 0 || flowEdgeSet.size > 0;

  if (layout.boxes.length === 0) {
    return (
      <div className="cg-empty">
        <p>No {category === 'test' ? 'test' : 'code'} changes in this PR.</p>
        <p className="muted">
          {category === 'test'
            ? 'This PR does not add or modify any test files.'
            : 'This PR does not change any production code files.'}
        </p>
      </div>
    );
  }

  const selectedNode = selected ? findNode(step, selected) : null;
  // Grow the viewBox to enclose every box/node including its live drag offset so
  // dragging a tile past the layout edge never clips the diagram; the content is
  // shifted by `pad - min` and the scroll container reveals the overflow.
  const { minX, minY, maxX, maxY } = contentExtent(layout.width, layout.height, [
    ...layout.boxes.map((b) => {
      const o = boxDrag.of(b.id);
      return { x: b.x + o.dx, y: b.y + o.dy, w: b.width, h: b.height };
    }),
    ...layout.nodes.map((n) => {
      const o = boxDrag.of(n.projectId);
      return { x: n.x + o.dx, y: n.y + o.dy, w: n.width, h: NODE_H };
    }),
  ]);
  const viewW = maxX - minX + CANVAS_PAD * 2;
  const viewH = maxY - minY + CANVAS_PAD * 2;
  const originX = CANVAS_PAD - minX;
  const originY = CANVAS_PAD - minY;

  // Fit the whole graph within the visible canvas on load (and whenever the
  // available space changes, e.g. entering/leaving fullscreen) so a graph larger
  // than the card is never clipped or overflowing on first paint. Runs after
  // layout so the container is measured; keyed on the graph's natural size and
  // fullscreen — not on `zoom` — so a later manual zoom is preserved until the
  // graph itself changes size.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    setZoom(fitZoom(el.clientWidth, el.clientHeight, viewW, viewH));
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }, [viewW, viewH, fullscreen]);

  function activate(node: { path: string }) {
    // A pan gesture ends with a synthetic click; ignore it so dragging the
    // canvas never opens a node's detail panel.
    if (panned.current) {
      return;
    }
    setSelected(node.path);
    const full = findNode(step, node.path);
    if (
      full &&
      full.kind === 'changed' &&
      onExplainFile &&
      nodeNeedsExplanation(full) &&
      !explaining?.has(full.path)
    ) {
      onExplainFile(full.path);
    }
  }

  function toggleProject(id: string) {
    // A pan gesture ends with a synthetic click; ignore it so dragging never
    // expands or collapses a module.
    if (panned.current) {
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // Ctrl/Cmd + wheel zooms; a plain wheel scrolls the box natively. Zoom is only
  // intercepted with a modifier so the scrollbars remain the primary navigation.
  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) {
      return;
    }
    e.preventDefault();
    setZoom((z) => Math.min(2.4, Math.max(0.4, z - e.deltaY * 0.0012)));
  }

  function onPointerDown(e: React.PointerEvent) {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      sl: el.scrollLeft,
      st: el.scrollTop,
    };
    panned.current = false;
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    const el = scrollRef.current;
    if (!d || !el) {
      return;
    }
    // Only treat this as a pan once the pointer clearly moves; a tiny jitter on a
    // click must still register as a node selection.
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) {
      panned.current = true;
    }
    // Drag-to-pan drives the native scroll offsets so it composes with the
    // scrollbars instead of a separate transform.
    el.scrollLeft = d.sl - (e.clientX - d.x);
    el.scrollTop = d.st - (e.clientY - d.y);
  }

  function onPointerUp() {
    drag.current = null;
  }

  const graph = (
    <>
      <div className={`cg-canvas${fullscreen ? ' cg-canvas-full' : ''}`}>
        <div
          className="cg-scroll"
          ref={scrollRef}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <svg
            className="cg-svg"
            width={viewW * zoom}
            height={viewH * zoom}
            viewBox={`0 0 ${viewW} ${viewH}`}
            role="application"
            aria-label="Changed files graph"
          >
            <defs>
              <marker
                id="cg-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="cg-arrow-head" />
              </marker>
              <marker
                id="cg-arrow-pr"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="cg-arrow-head-pr" />
              </marker>
              <marker
                id="cg-arrow-flow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="cg-arrow-head-flow" />
              </marker>
            </defs>
            <g
              transform={`translate(${originX} ${originY})`}
          >
            {layout.boxes.map((box) => {
              const canToggle = box.collapsed || collapsible.has(box.id);
              const changed = changedProjects.has(box.id);
              const off = boxDrag.of(box.id);
              return (
                <g
                  key={box.id}
                  className={`cg-box cg-draggable${box.collapsed ? ' cg-box-collapsed' : ''}${box.flow ? ` cg-flow-${box.flow}` : ''}${canToggle ? ' cg-box-toggle' : ''}${changed ? ' cg-box-changed' : ''}`}
                  transform={`translate(${off.dx} ${off.dy})`}
                  {...boxDrag.handlers(box.id)}
                  onClick={
                    canToggle
                      ? () => {
                          if (boxDrag.movedRef.current) {
                            return;
                          }
                          toggleProject(box.id);
                        }
                      : undefined
                  }
                  role={canToggle ? 'button' : undefined}
                  tabIndex={canToggle ? 0 : undefined}
                  onKeyDown={
                    canToggle
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleProject(box.id);
                          }
                        }
                      : undefined
                  }
                >
                  <rect
                    className="cg-box-rect"
                    x={box.x}
                    y={box.y}
                    width={box.width}
                    height={box.height}
                    rx={10}
                  />
                  <text className="cg-box-title" x={box.x + 12} y={box.y + 17}>
                    {canToggle && (
                      <tspan className="cg-box-caret">
                        {box.collapsed ? '▸ ' : '▾ '}
                      </tspan>
                    )}
                    {box.name}
                    <tspan className="cg-box-count"> · {box.count}</tspan>
                  </text>
                  {box.collapsed && (
                    <text
                      className="cg-box-hint"
                      x={box.x + 12}
                      y={box.y + 35}
                    >
                      {box.count} file{box.count === 1 ? '' : 's'} — click to
                      expand
                    </text>
                  )}
                  {box.collapsed && box.flow && (
                    <g transform={`translate(${box.x + box.width} ${box.y})`}>
                      <FlowMarker flow={box.flow} nodeWidth={0} />
                    </g>
                  )}
                </g>
              );
            })}
            {layout.edges.map((edge, i) => {
              const label = formatEdgeLabel(edge.calls);
              const offFrom = offsetOfAnchor(edge.from);
              const offTo = offsetOfAnchor(edge.to);
              const x1 = edge.x1 + offFrom.dx;
              const y1 = edge.y1 + offFrom.dy;
              const x2 = edge.x2 + offTo.dx;
              const y2 = edge.y2 + offTo.dy;
              const onFlow = flowEdgeSet.has(`${edge.from}\u0000${edge.to}`);
              return (
                <g key={`${edge.from}->${edge.to}`}>
                  <line
                    className={`cg-link${edge.highlightsChanges ? ' cg-link-pr' : ''}${onFlow ? ' cg-link-flow' : ''}`}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    markerEnd={
                      onFlow
                        ? 'url(#cg-arrow-flow)'
                        : edge.highlightsChanges
                          ? 'url(#cg-arrow-pr)'
                          : 'url(#cg-arrow)'
                    }
                    style={{ animationDelay: `${i * 18}ms` }}
                  />
                  {label && (
                    <text
                      className={`cg-link-label${edge.highlightsChanges ? ' cg-link-label-pr' : ''}`}
                      x={(x1 + x2) / 2}
                      y={(y1 + y2) / 2 - 7}
                      textAnchor="middle"
                    >
                      {label}
                    </text>
                  )}
                </g>
              );
            })}
            {layout.nodes.map((node, i) => {
              const isSel = node.path === selected;
              const off = boxDrag.of(node.projectId);
              const highlighted = highlightSet.has(node.path);
              const note = noteByPath.get(node.path);
              return (
                <g
                  key={node.path}
                  className={`cg-filenode cg-draggable cg-filenode-${node.kind}${node.flow ? ` cg-flow-${node.flow}` : ''}${highlighted ? ' cg-filenode-spotlight' : ''}${isSel ? ' cg-filenode-selected' : ''}`}
                  transform={`translate(${node.x + off.dx} ${node.y + off.dy})`}
                  style={{ animationDelay: `${i * 20}ms` }}
                  {...boxDrag.handlers(node.projectId)}
                  onClick={() => {
                    if (boxDrag.movedRef.current) {
                      return;
                    }
                    activate(node);
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      activate(node);
                    }
                  }}
                >
                  <rect
                    className="cg-filenode-rect"
                    width={node.width}
                    height={NODE_H}
                    rx={6}
                  />
                  <text
                    className="cg-filenode-label"
                    x={node.width / 2}
                    y={NODE_H / 2 + 4}
                    textAnchor="middle"
                  >
                    {node.label}
                  </text>
                  {node.flow && (
                    <FlowMarker flow={node.flow} nodeWidth={node.width} />
                  )}
                  {note && <NoteBadge text={note} nodeWidth={node.width} />}
                </g>
              );
            })}
          </g>
        </svg>
        </div>
        <div className="cg-controls" role="group" aria-label="Zoom controls">
          {onChat && (
            <button
              type="button"
              className={`cg-ai-toggle${chatOpen ? ' cg-ai-on' : ''}`}
              onClick={() => setChatOpen((o) => !o)}
              aria-pressed={chatOpen}
              title="Explain this diagram and ask questions about it"
            >
              <AiIcon size={14} /> Explain
            </button>
          )}
          {hasAnnotations && (
            <button
              type="button"
              className="cg-clear-annotations"
              onClick={() => setAnnotations(null)}
              title="Remove the highlights, flow and notes the chat added"
            >
              Clear highlights
            </button>
          )}
          <button
            type="button"
            className={`cg-callers-toggle${showCallers ? ' cg-callers-on' : ''}`}
            onClick={() => setShowCallers((s) => !s)}
            aria-pressed={showCallers}
            disabled={!hasBoundary && !showCallers}
            title={
              !hasBoundary
                ? 'No external callers were found for these changes'
                : showCallers
                  ? 'Hide external callers to focus on the changed files'
                  : 'Show external callers (the files that call the changed code)'
            }
          >
            {showCallers ? 'Hide callers' : 'Show external callers'}
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(2.4, z + 0.2))}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => {
              setZoom(1);
              boxDrag.reset();
              scrollRef.current?.scrollTo({ top: 0, left: 0 });
            }}
            aria-label="Reset view"
          >
            ⟲
          </button>
          <button
            type="button"
            onClick={() => setFullscreen((f) => !f)}
            aria-label={fullscreen ? 'Exit full screen' : 'Open full screen'}
            title={fullscreen ? 'Exit full screen (Esc)' : 'Open full screen'}
          >
            {fullscreen ? '×' : '⛶'}
          </button>
        </div>
        <Legend
          kinds={kindsPresent}
          category={category}
          hasBoundary={hasBoundary}
          hasStart={
            layout.nodes.some((n) => n.flow === 'start') ||
            layout.boxes.some((b) => b.flow === 'start')
          }
          hasEnd={
            layout.nodes.some((n) => n.flow === 'end') ||
            layout.boxes.some((b) => b.flow === 'end')
          }
        />
        {onChat && chatOpen && (
          <GraphChat
            category={category}
            onSend={onChat}
            onAnnotations={setAnnotations}
            onClose={() => setChatOpen(false)}
          />
        )}
      </div>
      {selectedNode && (
        <SelectionPanel
          step={step}
          node={selectedNode}
          category={category}
          explaining={explaining?.has(selectedNode.path) ?? false}
          comments={comments}
          onClose={() => setSelected(null)}
          onNavigate={(path) => activate({ path })}
          onChat={onChat}
        />
      )}
    </>
  );
  return fullscreen
    ? createPortal(
        <div
          className="cg-fullscreen"
          role="dialog"
          aria-modal="true"
          aria-label="Change graph full screen"
        >
          {graph}
        </div>,
        document.body,
      )
    : <div className="cg-wrap">{graph}</div>;
}

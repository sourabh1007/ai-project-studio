import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  buildFocusedChangeGraphLayout,
  buildChangeGraphLayout,
  findNode,
  NODE_H,
} from '../../lib/change-graph-layout.js';
import type {
  ChangeGraphCategory,
  ChangeGraphNode,
  ChangeGraphStep,
  PrChangeKind,
} from '../../lib/types.js';
import { FileCommentBox, type PrCommentsController } from './pr-comments.js';

/** Placeholders the backend writes for a file whose English is not yet produced. */
const UNEXPLAINED_WHAT_IT_DOES = 'No description was produced for this file.';
const UNEXPLAINED_WHAT_CHANGED = 'No change summary was produced.';

/** Padding added around the placed layout so labels are never clipped. */
const CANVAS_PAD = 40;
const FOCUSED_CANVAS_PAD = 28;

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

function edgeCallLabel(
  calls: ReadonlyArray<{ caller: string | null }> | undefined,
): string {
  const callers = [
    ...new Set(
      (calls ?? [])
        .map((call) => call.caller?.trim())
        .filter((caller): caller is string => Boolean(caller)),
    ),
  ];
  if (callers.length === 0) {
    return (calls?.length ?? 0) > 0 ? 'module scope' : '';
  }
  if (callers.length <= 2) {
    return callers.join(', ');
  }
  return `${callers[0]}, +${callers.length - 1}`;
}

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

function FocusedFileGraph({
  step,
  category,
  focusPath,
}: {
  step: ChangeGraphStep;
  category: ChangeGraphCategory;
  focusPath: string;
}) {
  const layout = useMemo(
    () => buildFocusedChangeGraphLayout(step, category, focusPath),
    [step, category, focusPath],
  );
  const viewW = Math.max(360, layout.width + FOCUSED_CANVAS_PAD * 2);
  const viewH = Math.max(132, layout.height + FOCUSED_CANVAS_PAD * 2);

  return (
    <div className="cg-focused-wrap">
      <svg
        className="cg-focused-svg"
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
        <g transform={`translate(${FOCUSED_CANVAS_PAD} ${FOCUSED_CANVAS_PAD})`}>
          {layout.edges.map((edge) => {
            const label = edgeCallLabel(edge.calls);
            const highlighted = edge.highlightsChanges;
            return (
              <g key={`${edge.from}->${edge.to}`} className="cg-focused-edge">
                <line
                  className={`cg-link${highlighted ? ' cg-link-pr' : ''}`}
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                  markerEnd={
                    highlighted
                      ? 'url(#cg-focused-arrow-pr)'
                      : 'url(#cg-focused-arrow)'
                  }
                />
                {label && (
                  <text
                    className={`cg-link-label${highlighted ? ' cg-link-label-pr' : ''}`}
                    x={(edge.x1 + edge.x2) / 2}
                    y={(edge.y1 + edge.y2) / 2 - 7}
                    textAnchor="middle"
                  >
                    {label}
                  </text>
                )}
              </g>
            );
          })}
          {layout.nodes.map((node) => (
            <g
              key={node.path}
              className={`cg-filenode cg-filenode-${node.kind}${node.path === focusPath ? ' cg-filenode-selected' : ''}`}
              transform={`translate(${node.x} ${node.y})`}
            >
              <rect
                className="cg-filenode-rect"
                width={node.width}
                height={NODE_H}
                rx={8}
              />
              <text
                className="cg-filenode-label"
                x={node.width / 2}
                y={NODE_H / 2 + 4}
                textAnchor="middle"
              >
                {node.label}
              </text>
            </g>
          ))}
        </g>
      </svg>
      {layout.edges.length === 0 && (
        <p className="muted">No direct file connections were found for this file.</p>
      )}
    </div>
  );
}

/** The detail panel content for the currently selected node. */
function SelectionPanel({
  step,
  node,
  category,
  explaining,
  comments,
  onClose,
}: {
  step: ChangeGraphStep;
  node: ChangeGraphNode;
  category: ChangeGraphCategory;
  explaining: boolean;
  comments?: PrCommentsController;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
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
          <FocusedFileGraph step={step} category={category} focusPath={node.path} />
        </div>
        <div className="cg-panel-section">
          <span className="cg-panel-label">Code diff</span>
          {node.diff.trim() ? (
            <DiffView diff={node.diff} />
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
                      <li key={i}>{finding}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })()}
        {comments && (
          <FileCommentBox
            comments={comments}
            path={node.path}
            diff={node.diff}
          />
        )}
      </aside>
    </div>,
    document.body,
  );
}

/** A colour-coded legend for the change kinds present in this category. */
function Legend({
  kinds,
  category,
  hasBoundary,
}: {
  kinds: Set<PrChangeKind>;
  category: ChangeGraphCategory;
  hasBoundary: boolean;
}) {
  const shown = LEGEND_KINDS.filter((kind) => kinds.has(kind));
  if (shown.length === 0 && !hasBoundary) {
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
    </div>
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
  comments,
}: {
  step: ChangeGraphStep;
  category: ChangeGraphCategory;
  /** Paths whose lazy English explanation is currently being generated. */
  explaining?: ReadonlySet<string>;
  /** Requests the on-demand English explanation for a file's diff. */
  onExplainFile?: (path: string) => void;
  /** Live PR comments controller; enables the inline comment box in the popup. */
  comments?: PrCommentsController;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  );
  // True once the pointer has moved far enough to count as a pan, so the trailing
  // click after a drag is not misread as a node selection.
  const panned = useRef(false);

  const layout = useMemo(
    () => buildChangeGraphLayout(step, category),
    [step, category],
  );
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

  if (layout.nodes.length === 0) {
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
  const viewW = layout.width + CANVAS_PAD * 2;
  const viewH = layout.height + CANVAS_PAD * 2;

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

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    setView((v) => {
      const next = Math.min(2.4, Math.max(0.4, v.scale - e.deltaY * 0.0012));
      return { ...v, scale: next };
    });
  }

  function onPointerDown(e: React.PointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
    panned.current = false;
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) {
      return;
    }
    // Only treat this as a pan once the pointer clearly moves; a tiny jitter on a
    // click must still register as a node selection.
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) {
      panned.current = true;
    }
    setView((v) => ({
      ...v,
      x: d.ox + (e.clientX - d.x),
      y: d.oy + (e.clientY - d.y),
    }));
  }

  function onPointerUp() {
    drag.current = null;
  }

  return (
    <div className="cg-wrap">
      <div className="cg-canvas">
        <svg
          className="cg-svg"
          viewBox={`0 0 ${viewW} ${viewH}`}
          role="application"
          aria-label="Changed files graph"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
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
          </defs>
          <g
            transform={`translate(${view.x + CANVAS_PAD} ${view.y + CANVAS_PAD}) scale(${view.scale})`}
          >
            {layout.boxes.map((box) => (
              <g key={box.id} className="cg-box">
                <rect
                  className="cg-box-rect"
                  x={box.x}
                  y={box.y}
                  width={box.width}
                  height={box.height}
                  rx={12}
                />
                <text className="cg-box-title" x={box.x + 14} y={box.y + 20}>
                  {box.name}
                  <tspan className="cg-box-count"> · {box.count}</tspan>
                </text>
              </g>
            ))}
            {layout.edges.map((edge, i) => {
              const label = edgeCallLabel(edge.calls);
              return (
                <g key={`${edge.from}->${edge.to}`}>
                  <line
                    className={`cg-link${edge.highlightsChanges ? ' cg-link-pr' : ''}`}
                    x1={edge.x1}
                    y1={edge.y1}
                    x2={edge.x2}
                    y2={edge.y2}
                    markerEnd={
                      edge.highlightsChanges ? 'url(#cg-arrow-pr)' : 'url(#cg-arrow)'
                    }
                    style={{ animationDelay: `${i * 18}ms` }}
                  />
                  {label && (
                    <text
                      className={`cg-link-label${edge.highlightsChanges ? ' cg-link-label-pr' : ''}`}
                      x={(edge.x1 + edge.x2) / 2}
                      y={(edge.y1 + edge.y2) / 2 - 7}
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
              return (
                <g
                  key={node.path}
                  className={`cg-filenode cg-filenode-${node.kind}${isSel ? ' cg-filenode-selected' : ''}`}
                  transform={`translate(${node.x} ${node.y})`}
                  style={{ animationDelay: `${i * 20}ms` }}
                  onClick={() => activate(node)}
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
                    rx={8}
                  />
                  <text
                    className="cg-filenode-label"
                    x={node.width / 2}
                    y={NODE_H / 2 + 4}
                    textAnchor="middle"
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        <div className="cg-controls" role="group" aria-label="Zoom controls">
          <button
            type="button"
            onClick={() =>
              setView((v) => ({ ...v, scale: Math.min(2.4, v.scale + 0.2) }))
            }
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={() =>
              setView((v) => ({ ...v, scale: Math.max(0.4, v.scale - 0.2) }))
            }
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => setView({ scale: 1, x: 0, y: 0 })}
            aria-label="Reset view"
          >
            ⟲
          </button>
        </div>
        <Legend kinds={kindsPresent} category={category} hasBoundary={hasBoundary} />
      </div>
      {selectedNode && (
        <SelectionPanel
          step={step}
          node={selectedNode}
          category={category}
          explaining={explaining?.has(selectedNode.path) ?? false}
          comments={comments}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

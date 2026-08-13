import {
  buildChangeGraphLayout,
  buildFocusedChangeGraphLayout,
  type ChangeGraphLayout,
} from './change-graph-layout.js';
import type { ChangeGraphCategory, ChangeGraphStep } from './types.js';

/**
 * Worker message protocol for change-graph layout (Phase 2e).
 *
 * `buildChangeGraphLayout`/`buildFocusedChangeGraphLayout` are pure but can be
 * heavy on large PRs, blocking the main thread during pan/zoom/expand. This
 * module defines the request/response envelopes exchanged with a web worker and
 * a single pure `computeLayout` router so both the worker and a synchronous
 * fallback share identical, fully-testable logic. Sets are passed as string
 * arrays so requests survive structured cloning across the worker boundary.
 */

export interface FullLayoutRequest {
  readonly id: number;
  readonly kind: 'full';
  readonly step: ChangeGraphStep;
  readonly category: ChangeGraphCategory;
  /** Project ids to render collapsed (a Set is not clone-friendly). */
  readonly collapsed: readonly string[];
}

export interface FocusedLayoutRequest {
  readonly id: number;
  readonly kind: 'focused';
  readonly step: ChangeGraphStep;
  readonly category: ChangeGraphCategory;
  readonly focusPath: string;
}

export type LayoutRequest = FullLayoutRequest | FocusedLayoutRequest;

export interface LayoutResponse {
  readonly id: number;
  readonly layout: ChangeGraphLayout;
}

/** Pure router: computes the layout for a request. Shared by worker + fallback. */
export function computeLayout(request: LayoutRequest): ChangeGraphLayout {
  if (request.kind === 'focused') {
    return buildFocusedChangeGraphLayout(
      request.step,
      request.category,
      request.focusPath,
    );
  }
  return buildChangeGraphLayout(request.step, request.category, {
    collapsed: new Set(request.collapsed),
  });
}

/** Wraps `computeLayout` into a response tagged with the request id. */
export function toResponse(request: LayoutRequest): LayoutResponse {
  return { id: request.id, layout: computeLayout(request) };
}

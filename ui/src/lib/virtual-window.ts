/**
 * Pure math for windowed (virtualized) lists of fixed-height rows. Given the
 * current scroll offset and viewport size, it returns the slice of rows to
 * actually render plus the padding needed above and below so the scrollbar and
 * row positions stay correct. Kept dependency-free so it is fully unit-testable;
 * the React hook/component layer feeds it live scroll metrics.
 */

export interface VirtualWindowParams {
  /** Current scrollTop of the scroll container, in pixels. */
  scrollTop: number;
  /** Visible height of the scroll container, in pixels. */
  viewportHeight: number;
  /** Height of a single row, in pixels (rows are assumed uniform). */
  rowHeight: number;
  /** Total number of rows in the full data set. */
  rowCount: number;
  /** Extra rows rendered above/below the viewport to smooth fast scrolling. */
  overscan?: number;
}

export interface VirtualWindow {
  /** First row index to render (inclusive). */
  startIndex: number;
  /** Last row index to render (exclusive) — use in `slice(startIndex, endIndex)`. */
  endIndex: number;
  /** Pixel height of the spacer above the rendered rows. */
  topPad: number;
  /** Pixel height of the spacer below the rendered rows. */
  bottomPad: number;
  /** Total scrollable height of all rows, in pixels. */
  totalHeight: number;
}

/**
 * Compute which rows are visible for the given scroll state. Degenerate inputs
 * (empty list, non-positive row height) collapse to an empty, zero-padding
 * window so callers can render nothing safely.
 */
export function computeVirtualWindow(
  params: VirtualWindowParams,
): VirtualWindow {
  const overscan = Math.max(0, params.overscan ?? 0);
  const rowCount = Math.max(0, Math.floor(params.rowCount));

  if (rowCount === 0 || params.rowHeight <= 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      topPad: 0,
      bottomPad: 0,
      totalHeight: 0,
    };
  }

  const rowHeight = params.rowHeight;
  const totalHeight = rowCount * rowHeight;
  const scrollTop = clamp(params.scrollTop, 0, totalHeight);
  const viewportHeight = Math.max(0, params.viewportHeight);

  const firstVisible = Math.floor(scrollTop / rowHeight);
  const visibleCount = Math.ceil(viewportHeight / rowHeight);

  const startIndex = clamp(firstVisible - overscan, 0, rowCount);
  const endIndex = clamp(
    firstVisible + visibleCount + overscan,
    startIndex,
    rowCount,
  );

  const topPad = startIndex * rowHeight;
  const bottomPad = (rowCount - endIndex) * rowHeight;

  return { startIndex, endIndex, topPad, bottomPad, totalHeight };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

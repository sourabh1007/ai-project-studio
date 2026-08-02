/**
 * Purely visual loading indicators — motion, never text. Per the product's UX
 * language, inline "waiting" states are shown with animation (a spinner or a
 * shimmering skeleton), while human-readable status ("Working…") lives in the
 * bottom status bar.
 */

/** A small inline spinner, sized to the surrounding text by default. */
export function Spinner({
  size = 16,
  label = 'Loading',
}: {
  size?: number;
  label?: string;
}) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role="status"
      aria-label={label}
    />
  );
}

/** A centered loader for empty content areas that are still loading. */
export function Loader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loader" role="status" aria-label={label}>
      <span className="spinner spinner-lg" aria-hidden="true" />
    </div>
  );
}

/**
 * A shimmering skeleton placeholder for list content, so a populated layout
 * animates in rather than popping from a text label.
 */
export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton-row" />
      ))}
    </div>
  );
}

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

/**
 * A single shimmering block sized by props — the primitive behind richer
 * skeletons. `width`/`height` accept any CSS length; `radius` rounds corners
 * (e.g. a circle for avatars).
 */
export function Skeleton({
  width = '100%',
  height = 12,
  radius,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
}) {
  return (
    <span
      className="skeleton-block"
      aria-hidden="true"
      style={{ width, height, borderRadius: radius }}
    />
  );
}

/**
 * A card-shaped skeleton (title line + body lines) for first paint of panels
 * that render item cards, so the layout's shape is previewed instead of a bare
 * spinner or blank area.
 */
export function SkeletonCards({
  cards = 3,
  lines = 2,
}: {
  cards?: number;
  lines?: number;
}) {
  return (
    <div className="skeleton-cards" aria-hidden="true">
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="skeleton-card">
          <span className="skeleton-block skeleton-card-title" />
          {Array.from({ length: lines }, (_, j) => (
            <span
              key={j}
              className="skeleton-block skeleton-card-line"
              style={{ width: j === lines - 1 ? '60%' : '100%' }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

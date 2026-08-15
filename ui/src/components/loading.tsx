/**
 * Purely visual loading indicators — motion, never text. Per the product's UX
 * language, inline "waiting" states are shown with animation (a spinner or a
 * shimmering skeleton), while human-readable status ("Working…") lives in the
 * bottom status bar.
 */
import { useEffect, useState } from 'react';

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
 * A prominent, branded loader for full-panel loading states. Unlike the bare
 * {@link Loader} spinner, this shows the animated app logo plus a visible title
 * and a rotating "what's happening behind the scenes" line, so a long-running
 * scan/analysis tells the user what it is actually doing instead of leaving a
 * mystery spinner stuck mid-screen. `hints` cycle every couple of seconds;
 * `detail` is a static secondary line shown beneath the title.
 */
export function BrandedLoader({
  title = 'Working',
  detail,
  hints,
}: {
  title?: string;
  detail?: string;
  hints?: string[];
}) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!hints || hints.length <= 1) {
      return;
    }
    const id = window.setInterval(
      () => setIndex((value) => (value + 1) % hints.length),
      2200,
    );
    return () => window.clearInterval(id);
  }, [hints]);
  const hint = hints && hints.length > 0 ? hints[index % hints.length] : null;
  return (
    <div className="branded-loader" role="status" aria-live="polite">
      <span className="branded-loader-mark" aria-hidden="true">
        <span className="branded-loader-orbit" />
        <span className="branded-loader-orbit branded-loader-orbit-2" />
        <img src="/logo.png" alt="" width={40} height={40} />
      </span>
      <span className="branded-loader-title">{title}</span>
      {detail && <span className="branded-loader-detail">{detail}</span>}
      {hint && (
        <span key={hint} className="branded-loader-hint">
          {hint}
        </span>
      )}
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

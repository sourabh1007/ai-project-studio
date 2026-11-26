import { useEffect, useState } from 'react';
import { BrandMark } from './brand-mark.js';
import { useMotion } from '../hooks/use-motion.js';

function LoadingMark({ size }: { size: number }) {
  return <span className="loading-mark" style={{ width: size, height: size }} aria-hidden="true">
    <span className="branded-loader-orbit" />
    <span className="branded-loader-orbit branded-loader-orbit-2" />
    <BrandMark size={size * 0.56} title="Loading indicator" />
  </span>;
}

/** A small inline spinner, sized to the surrounding text by default. */
export function Spinner({
  size = 16,
  label = 'Loading',
  showLabel = true,
}: {
  size?: number;
  label?: string;
  showLabel?: boolean;
}) {
  return (
    <span className="loading-indicator">
      <span className="spinner loading-mark-inline" style={{ width: size, height: size }} role="status" aria-label={label}>
        <LoadingMark size={size} />
      </span>
      {showLabel && <span className="motion-status-label" aria-hidden="true">{label}</span>}
    </span>
  );
}

/** The shared loading mark for rows that already announce their own status. */
export function LoadingGlyph({ size = 14 }: { size?: number }) {
  return <span className="spinner loading-mark-inline" style={{ width: size, height: size }} aria-hidden="true">
    <LoadingMark size={size} />
  </span>;
}

/** A centered loader for empty content areas that are still loading. */
export function Loader({ label = 'Loading' }: { label?: string }) {
  return <BrandedLoader title={label} compact />;
}

export function LoadingStatus({ label }: { label: string }) {
  return <span className="loading-status">
    <Spinner size={14} label={label} showLabel={false} />
    <span aria-hidden="true">{label}</span>
  </span>;
}

/**
 * Shared panel feedback. Only measured completed/total work gets a percentage;
 * otherwise the bar is indeterminate. Hints are informational, not fake stages.
 */
export function BrandedLoader({
  title = 'Working',
  detail,
  hints,
  progress,
  compact = false,
}: {
  title?: string;
  detail?: string;
  hints?: string[];
  progress?: { completed: number; total: number };
  compact?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const motion = useMotion();
  const hintCount = hints?.length ?? 0;
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (motion === 'off' || hintCount <= 1) {
      return;
    }
    const id = window.setInterval(
      () => setIndex((value) => (value + 1) % hintCount),
      2200,
    );
    return () => window.clearInterval(id);
  }, [hintCount, motion]);
  const hint = hints && hints.length > 0 ? hints[index % hints.length] : null;
  const measured = progress && Number.isFinite(progress.total) && progress.total > 0 &&
    Number.isFinite(progress.completed);
  const completed = measured ? Math.max(0, Math.min(progress.completed, progress.total)) : 0;
  const percent = measured ? Math.round(completed / progress.total * 100) : undefined;
  return (
    <div className={`branded-loader${compact ? ' branded-loader-compact' : ''}`} role="status" aria-label={title} aria-live="polite">
      <LoadingMark size={compact ? 40 : 72} />
      <span className="branded-loader-title">{title}</span>
      {detail && <span className="branded-loader-detail">{detail}</span>}
      {motion === 'off' && <span className="branded-loader-detail">Animation is off: progress updates remain live</span>}
      <div className={`branded-loader-progress${measured ? ' is-measured' : ''}`}
        role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={measured ? `${completed} of ${progress.total} steps complete` : 'In progress'}>
        <span style={measured ? { transform: `scaleX(${completed / progress.total})` } : undefined} />
      </div>
      <span className="branded-loader-detail">
        {measured ? `${completed} of ${progress.total} steps complete (${percent}%)` : 'In progress'}
      </span>
      {elapsed >= 3 && <span className="branded-loader-detail" role="timer" aria-live="off">{elapsed}s elapsed</span>}
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

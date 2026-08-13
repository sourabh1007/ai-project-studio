/**
 * A lightweight placeholder shown while a lazily-loaded view chunk is fetched.
 * Uses shimmer bars instead of a spinner so the shell never shows a blank pane
 * and the user perceives progress. Purely presentational.
 */
export function ViewSkeleton({ label }: { label?: string }) {
  return (
    <div className="view-skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label ? `Loading ${label}…` : 'Loading…'}</span>
      <div className="view-skeleton-bar view-skeleton-title" />
      <div className="view-skeleton-bar" style={{ width: '70%' }} />
      <div className="view-skeleton-bar" style={{ width: '85%' }} />
      <div className="view-skeleton-bar" style={{ width: '55%' }} />
      <div className="view-skeleton-bar" style={{ width: '78%' }} />
    </div>
  );
}

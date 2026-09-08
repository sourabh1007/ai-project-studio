import { useConnectionStatus } from '../hooks/use-connection-status.js';

/**
 * A slim, non-blocking banner shown at the top of the shell whenever the app is
 * offline or the local Studio service is unreachable. It stays out of the way
 * when everything is healthy so the normal UI is unobstructed.
 */
export function ConnectionBanner({
  liveInterrupted = false,
  liveHistoryLimited = false,
}: { liveInterrupted?: boolean; liveHistoryLimited?: boolean } = {}) {
  const status = useConnectionStatus();
  if (status.healthy && !liveInterrupted && !liveHistoryLimited) return null;
  const liveWarning = status.healthy;
  const title = liveInterrupted ? 'Live updates interrupted' : 'Live history limited';
  const detail = liveInterrupted
    ? 'Some live events may be missing. Saved totals and results are preserved; reopen affected views to refresh.'
    : 'Older live events were evicted to limit memory. Totals and full results remain in saved data.';

  return (
    <div
      className={`connection-banner connection-banner--${liveWarning ? 'backend-down' : status.state}`}
      role="status"
      aria-live="polite"
    >
      <span className="connection-banner-dot" aria-hidden="true" />
      <span className="connection-banner-title">{liveWarning ? title : status.title}</span>
      <span className="connection-banner-detail">{liveWarning ? detail : status.detail}</span>
    </div>
  );
}

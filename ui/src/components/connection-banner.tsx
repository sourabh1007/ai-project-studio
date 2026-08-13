import { useConnectionStatus } from '../hooks/use-connection-status.js';

/**
 * A slim, non-blocking banner shown at the top of the shell whenever the app is
 * offline or the local Studio service is unreachable. It stays out of the way
 * when everything is healthy so the normal UI is unobstructed.
 */
export function ConnectionBanner() {
  const status = useConnectionStatus();
  if (status.healthy) return null;

  return (
    <div
      className={`connection-banner connection-banner--${status.state}`}
      role="status"
      aria-live="polite"
    >
      <span className="connection-banner-dot" aria-hidden="true" />
      <span className="connection-banner-title">{status.title}</span>
      <span className="connection-banner-detail">{status.detail}</span>
    </div>
  );
}

import { useState } from 'react';
import { useConnectionStatus } from '../hooks/use-connection-status.js';
import { desktopBridge } from '../lib/desktop-bridge.js';
import type { ConnectionStatus } from '../lib/connection-status.js';

/**
 * A slim, non-blocking banner shown at the top of the shell whenever the app is
 * offline or the local Studio service is unreachable. It stays out of the way
 * when everything is healthy so the normal UI is unobstructed.
 *
 * A permanently stopped backend also gets a way out. Every view fails at once
 * in that state, and without an explicit control the only remaining recovery is
 * for the user to work out on their own that the app must be restarted.
 */
interface ConnectionBannerProps {
  liveInterrupted?: boolean;
  liveHistoryLimited?: boolean;
  status?: ConnectionStatus;
}

export function ConnectionBanner(props: ConnectionBannerProps = {}) {
  return props.status
    ? <ConnectionBannerContent {...props} status={props.status} />
    : <ProbedConnectionBanner {...props} />;
}

function ProbedConnectionBanner(props: ConnectionBannerProps) {
  const status = useConnectionStatus();
  return <ConnectionBannerContent {...props} status={status} />;
}

function ConnectionBannerContent({
  liveInterrupted = false,
  liveHistoryLimited = false,
  status,
}: ConnectionBannerProps & { status: ConnectionStatus }) {
  const [restartFailed, setRestartFailed] = useState(false);
  if (status.healthy && !liveInterrupted && !liveHistoryLimited) return null;
  const stopped = status.state === 'backend-unavailable';
  const liveWarning = status.healthy;
  const title = liveInterrupted ? 'Live updates interrupted' : 'Live history limited';
  const detail = liveInterrupted
    ? 'Some live events may be missing. Saved totals and results are preserved; reopen affected views to refresh.'
    : 'Older live events were evicted to limit memory. Totals and full results remain in saved data.';
  const explanation = `${liveWarning ? detail : status.detail}${
    restartFailed ? ' Restarting failed; close and reopen the app.' : ''
  }`;

  return (
    <div
      className={`connection-banner connection-banner--${liveWarning ? 'backend-down' : status.state}`}
      role={stopped ? 'alert' : 'status'}
      aria-live={stopped ? 'assertive' : 'polite'}
      title={explanation}
      aria-description={explanation}
    >
      <span className="connection-banner-dot" aria-hidden="true" />
      <span className="connection-banner-title">
        {liveWarning ? title : status.state === 'backend-down' ? 'Service unavailable' : status.title}
      </span>
      <span className="connection-banner-detail">
        {restartFailed ? 'Restart failed — close and reopen the app.'
          : status.state === 'backend-down' ? '· Reconnecting…' : null}
      </span>
      {stopped && (
        <button
          type="button"
          className="connection-banner-action"
          onClick={() => {
            void (async () => {
              setRestartFailed(await desktopBridge()?.relaunch?.() !== true);
            })();
          }}
        >
          Restart app
        </button>
      )}
    </div>
  );
}

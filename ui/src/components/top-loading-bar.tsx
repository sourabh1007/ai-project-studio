import { useEffect, useRef, useState } from 'react';
import { useActivity } from '../hooks/use-activity.js';

/**
 * A slim animated progress bar pinned to the top of the content area. It is
 * driven entirely by the global activity store, so any in-flight API request
 * shows motion. The bottom status bar owns activity/error text and live
 * announcements so the same information is never shown twice.
 *
 * The bar is indeterminate (we don't know real percentages), so it uses a
 * travelling sheen while busy and fades out on completion. On error it turns
 * red.
 */
export function TopLoadingBar() {
  const activity = useActivity();
  const busy = activity.pending > 0;
  const hasError = activity.error !== null;

  // Keep the bar mounted through its fade-out so completion is visible.
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (busy || hasError) {
      if (hideTimer.current !== undefined) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = undefined;
      }
      setVisible(true);
      return;
    }
    // Finished: let the fill complete, then fade out.
    hideTimer.current = window.setTimeout(() => setVisible(false), 500);
    return () => {
      if (hideTimer.current !== undefined) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = undefined;
      }
    };
  }, [busy, hasError]);

  if (!visible) {
    return null;
  }

  const state = hasError ? 'is-error' : busy ? 'is-busy' : 'is-done';

  return (
    <div
      className={`top-loading-bar ${state}`}
      aria-hidden="true"
    >
      <div className="top-loading-bar-track">
        <div className="top-loading-bar-fill" />
      </div>
    </div>
  );
}

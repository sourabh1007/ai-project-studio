import { useEffect, useRef, useState } from 'react';
import { useActivity } from '../hooks/use-activity.js';

/**
 * A slim animated progress bar pinned to the top of the content area. It is
 * driven entirely by the global activity store, so any in-flight API request
 * shows motion and — crucially — a human-readable label telling the user what
 * the app is currently doing ("Loading PR review", "Creating session", …).
 *
 * The bar is indeterminate (we don't know real percentages), so it uses a
 * travelling sheen while busy and fades out on completion. On error it turns
 * red and shows the error text briefly.
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

  const label = hasError ? activity.error : busy ? activity.label : 'Done';
  const state = hasError ? 'is-error' : busy ? 'is-busy' : 'is-done';

  return (
    <div
      className={`top-loading-bar ${state}`}
      role="status"
      aria-live="polite"
      aria-hidden={label ? undefined : true}
    >
      <div className="top-loading-bar-track">
        <div className="top-loading-bar-fill" />
      </div>
      {label ? <span className="top-loading-bar-label">{label}</span> : null}
    </div>
  );
}

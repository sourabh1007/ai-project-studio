import { useEffect, useState } from 'react';
import { useActivity } from '../../hooks/use-activity.js';
import { activityDelay } from '../../lib/activity.js';

export function ActivityStatus() {
  const activity = useActivity();
  const [, tick] = useState(0);
  const busy = activity.pending > 0;
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [busy]);
  const delayed = activityDelay(activity, Date.now());
  const label = activity.error ?? (busy ? activity.label : 'Ready');
  const detail = delayed === null ? label ?? '' :
    `${label} Oldest pending request: ${delayed}s. Still waiting for a response; progress is unknown. Wait, or retry a failed read. Check the result before repeating a save or other action.`;
  return (
    <span className={`statusbar-activity ${activity.error ? 'is-error' : busy ? 'is-busy' : 'is-idle'}`}
      title={detail} aria-description={detail}>
      {busy && !activity.error
        ? <span className="spinner statusbar-spinner" aria-hidden="true" />
        : <span className="statusbar-activity-dot" aria-hidden="true" />}
      <span className="statusbar-activity-label" aria-live="polite">
        {label}{delayed !== null && !activity.error ? ' Delayed' : ''}
      </span>
      {delayed !== null && <span aria-hidden="true"> · {delayed}s</span>}
    </span>
  );
}

import { formatDuration } from '../../lib/format.js';
import type { ReviewTiming } from './review-board-run-store.js';

export function ReviewDuration({ timing, now, label = 'Review time' }: {
  timing: ReviewTiming | null | undefined;
  now: number;
  label?: string;
}) {
  if (!timing) return null;
  return <span className="rb-review-duration" title={`${label}: measured analysis wall time; queue wait excluded`}>
    {label}: {formatDuration((timing.finishedAt ?? now) - timing.startedAt)}
    {timing.finishedAt === null && ' elapsed'}
  </span>;
}

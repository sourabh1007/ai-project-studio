import {
  summarizeStages,
  type ProgressStage,
} from '../../lib/progress-stages.js';

/**
 * A compact, consistent progress read-out for a staged AI operation (Phase 5a).
 * Shows an overall bar, a "Stage N of M" headline, and a chip per stage so the
 * user can see at a glance how far a long op has progressed and where it is now.
 */
export function StageProgress({ stages }: { stages: readonly ProgressStage[] }) {
  const summary = summarizeStages(stages);
  if (summary.total === 0) {
    return null;
  }
  return (
    <div
      className={`stage-progress stage-progress-${summary.state}`}
      role="group"
      aria-label="Analysis progress"
    >
      <div className="stage-progress-head">
        <span className="stage-progress-headline">{summary.headline}</span>
        <span className="stage-progress-count">{summary.percent}%</span>
      </div>
      <div
        className="stage-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={summary.percent}
      >
        <div
          className="stage-progress-fill"
          style={{ width: `${summary.percent}%` }}
        />
      </div>
      <ol className="stage-progress-stages">
        {stages.map((stage) => (
          <li
            key={stage.id}
            className={`stage-progress-chip stage-chip-${stage.status}`}
          >
            {stage.label}
          </li>
        ))}
      </ol>
    </div>
  );
}

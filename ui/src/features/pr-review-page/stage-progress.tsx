import {
  summarizeStages,
  type ProgressStage,
  type StageStatus,
} from '../../lib/progress-stages.js';

const STAGE_STATUS_LABEL: Record<StageStatus, string> = {
  pending: 'Pending',
  active: 'In progress',
  done: 'Done',
  failed: 'Failed',
};

/**
 * A compact, thin progress read-out for a staged AI operation (Phase 5a).
 * Renders a single slim bar split into one color-coded segment per stage, so
 * the whole pipeline (and where it currently is) reads at a glance in minimal
 * vertical space. Adding a future stage is just another entry in `stages` — the
 * bar grows automatically and each status carries its own color.
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
      <ol
        className="stage-progress-segments"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={summary.percent}
        aria-valuetext={summary.headline}
      >
        {stages.map((stage) => (
          <li
            key={stage.id}
            className={`stage-seg stage-seg-${stage.status}`}
            title={`${stage.label}: ${STAGE_STATUS_LABEL[stage.status]}`}
          >
            <span className="stage-seg-bar" aria-hidden="true" />
            <span className="stage-seg-label">{stage.label}</span>
          </li>
        ))}
      </ol>
      <div className="stage-progress-meta">
        <span className="stage-progress-headline">{summary.headline}</span>
        <span className="stage-progress-count">{summary.percent}%</span>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useApi } from '../../app/api-context.js';
import type { LiveState } from '../../lib/stream.js';
import { useAutomations } from '../../hooks/use-automations.js';
import type { Automation, Subagent } from '../../lib/types.js';
import {
  groupAutomations,
  sortSubagents,
  statusLabel,
  modeLabel,
  subagentStatusLabel,
  describeCheck,
  nextRunLabel,
  runCountLabel,
  originLabel,
  canPause,
  canResume,
  canCancel,
  needsAuth,
} from '../../lib/automation-view.js';
import {
  Card,
  EmptyState,
  ErrorText,
  IconBadge,
  StatusBadge,
} from '../../components/ui.js';
import { SkeletonCards } from '../../components/loading.js';
import {
  AutomationIcon,
  RefreshIcon,
  TrashIcon,
  ClockIcon,
  ActivityIcon,
  HistoryIcon,
  AiChatIcon,
} from '../../components/icons.js';

type LifecycleAction = 'pause' | 'resume' | 'cancel' | 'run' | 'delete';

export function AutomationsView({ live }: { live: LiveState }) {
  const api = useApi();
  const { automations, subagents, loading, error, reload } =
    useAutomations(live);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const nowMs = Date.now();

  async function act(id: string, action: LifecycleAction) {
    setBusyKey(`${action}:${id}`);
    setActionError(null);
    try {
      if (action === 'pause') {
        await api.pauseAutomation(id);
      } else if (action === 'resume') {
        await api.resumeAutomation(id);
      } else if (action === 'cancel') {
        await api.cancelAutomation(id);
      } else if (action === 'run') {
        await api.runAutomation(id);
      } else {
        await api.deleteAutomation(id);
      }
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  const groups = groupAutomations(automations);
  const sortedSubagents = sortSubagents(subagents);

  return (
    <Card>
      <div className="page-header">
        <div className="page-header-main">
          <IconBadge
            icon={<AutomationIcon size={24} />}
            tone="ai"
            size="lg"
            glow
          />
          <div>
            <h2 className="page-title">Monitors</h2>
            <p className="page-subtitle">
              Background monitors that watch a check on an interval and run an
              action when a condition matches. Short monitors fire once; long
              monitors keep watching. Register them from any session, or manage
              them here.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="ghost-button"
          onClick={() => reload()}
          title="Refresh"
        >
          <RefreshIcon size={14} />
          Refresh
        </button>
      </div>

      <ErrorText error={actionError ?? error} />

      {loading && <SkeletonCards cards={3} />}

      {!loading && automations.length === 0 && sortedSubagents.length === 0 && (
        <EmptyState
          icon={<AutomationIcon size={20} />}
          title="No monitors yet"
          description="Monitors run background checks and report back. Ask the in-session assistant to set one up, e.g. “monitor my CI pipeline and report when it finishes.”"
        />
      )}

      {groups.active.length > 0 && (
        <section className="automation-section">
          <h3 className="automation-section-title">
            <ActivityIcon size={14} /> Active monitors
          </h3>
          <div className="automation-list">
            {groups.active.map((automation) => (
              <AutomationCard
                key={automation.id}
                automation={automation}
                nowMs={nowMs}
                busyKey={busyKey}
                onAction={act}
              />
            ))}
          </div>
        </section>
      )}

      {groups.finished.length > 0 && (
        <section className="automation-section">
          <h3 className="automation-section-title">
            <HistoryIcon size={14} /> Finished monitors
          </h3>
          <div className="automation-list">
            {groups.finished.map((automation) => (
              <AutomationCard
                key={automation.id}
                automation={automation}
                nowMs={nowMs}
                busyKey={busyKey}
                onAction={act}
              />
            ))}
          </div>
        </section>
      )}

      {sortedSubagents.length > 0 && (
        <section className="automation-section">
          <h3 className="automation-section-title">
            <AiChatIcon size={14} /> Subagents
          </h3>
          <div className="automation-list">
            {sortedSubagents.map((subagent) => (
              <SubagentCard key={subagent.id} subagent={subagent} />
            ))}
          </div>
        </section>
      )}
    </Card>
  );
}

function AutomationCard({
  automation,
  nowMs,
  busyKey,
  onAction,
}: {
  automation: Automation;
  nowMs: number;
  busyKey: string | null;
  onAction: (id: string, action: LifecycleAction) => void;
}) {
  const countdown = nextRunLabel(automation, nowMs);
  const steps = automation.plannedSteps;
  return (
    <div className="automation-card">
      <div className="automation-card-head">
        <span className="automation-mode" data-mode={automation.mode}>
          {modeLabel(automation.mode)}
        </span>
        <span className="automation-card-name" title={automation.name}>
          {automation.name}
        </span>
        <StatusBadge status={statusLabel(automation.status)} />
      </div>

      <p className="automation-check" title={describeCheck(automation.check)}>
        {describeCheck(automation.check)}
      </p>

      <div className="automation-meta">
        <span title="Origin">{originLabel(automation.origin)}</span>
        <span>{runCountLabel(automation)}</span>
        {countdown && (
          <span className="automation-countdown">
            <ClockIcon size={12} /> {countdown}
          </span>
        )}
      </div>

      {automation.progress && !needsAuth(automation.status) && (
        <p className="automation-progress">{automation.progress}</p>
      )}

      {needsAuth(automation.status) ? (
        <div className="automation-auth" role="alert">
          <strong>Sign-in required</strong>
          <span>
            {automation.failure ??
              "The monitor reuses this machine's existing logins. If you are " +
                'already signed in (in the IDE, or via `az login` / ' +
                '`gh auth login`) just Resume; otherwise sign in once in a ' +
                'terminal, then Resume.'}
          </span>
        </div>
      ) : (
        automation.failure && (
          <p className="automation-failure">{automation.failure}</p>
        )
      )}

      {steps.length > 0 && (
        <ol className="automation-steps">
          {steps.map((step) => (
            <li key={step.id} data-status={step.status}>
              <span className="automation-step-label">{step.label}</span>
              {step.detail && (
                <span className="automation-step-detail">{step.detail}</span>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="automation-actions">
        {canPause(automation.status) && (
          <button
            type="button"
            className="ghost-button"
            disabled={busyKey === `pause:${automation.id}`}
            onClick={() => onAction(automation.id, 'pause')}
          >
            Pause
          </button>
        )}
        {canResume(automation.status) && (
          <button
            type="button"
            className={
              needsAuth(automation.status) ? 'primary-button' : 'ghost-button'
            }
            disabled={busyKey === `resume:${automation.id}`}
            onClick={() => onAction(automation.id, 'resume')}
          >
            {needsAuth(automation.status) ? 'Signed in — resume' : 'Resume'}
          </button>
        )}
        {canCancel(automation.status) && (
          <>
            <button
              type="button"
              className="ghost-button"
              disabled={busyKey === `run:${automation.id}`}
              onClick={() => onAction(automation.id, 'run')}
            >
              Run now
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={busyKey === `cancel:${automation.id}`}
              onClick={() => onAction(automation.id, 'cancel')}
            >
              Cancel
            </button>
          </>
        )}
        <button
          type="button"
          className="tree-action"
          title="Delete automation"
          aria-label={`Delete ${automation.name}`}
          disabled={busyKey === `delete:${automation.id}`}
          onClick={() => onAction(automation.id, 'delete')}
        >
          <TrashIcon size={14} />
        </button>
      </div>
    </div>
  );
}

function SubagentCard({ subagent }: { subagent: Subagent }) {
  return (
    <div className="automation-card">
      <div className="automation-card-head">
        <span className="automation-card-name" title={subagent.task}>
          {subagent.task}
        </span>
        <StatusBadge status={subagentStatusLabel(subagent.status)} />
      </div>
      {subagent.progress && (
        <p className="automation-progress">{subagent.progress}</p>
      )}
      {subagent.result && (
        <p className="automation-check" title={subagent.result}>
          {subagent.result}
        </p>
      )}
    </div>
  );
}

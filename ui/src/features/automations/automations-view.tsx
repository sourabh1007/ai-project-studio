import { useState } from 'react';
import { useApi } from '../../app/api-context.js';
import type { LiveState } from '../../lib/stream.js';
import { useAutomations } from '../../hooks/use-automations.js';
import type { Automation, AutomationRun, Subagent } from '../../lib/types.js';
import {
  groupAutomations,
  sortSubagents,
  statusLabel,
  modeLabel,
  monitorMotion,
  subagentStatusLabel,
  describeCheck,
  intervalLabel,
  nextRunLabel,
  runCountLabel,
  originLabel,
  canPause,
  canResume,
  canCancel,
  needsAuth,
  progressPercent,
  etaLabel,
  activeStepLabel,
  intervalOptions,
  snapIntervalMs,
  runStatusLabel,
  runSummary,
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
  PauseIcon,
  PlayIcon,
  StopIcon,
  ChevronIcon,
  LogsIcon,
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

  async function changeInterval(id: string, intervalMs: number) {
    setBusyKey(`interval:${id}`);
    setActionError(null);
    try {
      await api.updateAutomationInterval(id, intervalMs);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  const groups = groupAutomations(automations);
  const sortedSubagents = sortSubagents(subagents);

  const sections: {
    key: string;
    title: string;
    icon: JSX.Element;
    items: Automation[];
  }[] = [
    {
      key: 'running',
      title: 'Running',
      icon: <ActivityIcon size={14} />,
      items: groups.running,
    },
    {
      key: 'attention',
      title: 'Needs sign-in',
      icon: <ClockIcon size={14} />,
      items: groups.attention,
    },
    {
      key: 'paused',
      title: 'Paused',
      icon: <PauseIcon size={14} />,
      items: groups.paused,
    },
    {
      key: 'finished',
      title: 'Finished',
      icon: <HistoryIcon size={14} />,
      items: groups.finished,
    },
  ];

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

      {sections.map((section) =>
        section.items.length > 0 ? (
          <section key={section.key} className="automation-section">
            <h3 className="automation-section-title">
              {section.icon} {section.title}
              <span className="automation-section-count">
                {section.items.length}
              </span>
            </h3>
            <div className="automation-list">
              {section.items.map((automation) => (
                <AutomationCard
                  key={automation.id}
                  automation={automation}
                  nowMs={nowMs}
                  busyKey={busyKey}
                  onAction={act}
                  onInterval={changeInterval}
                />
              ))}
            </div>
          </section>
        ) : null,
      )}

      {sortedSubagents.length > 0 && (
        <section className="automation-section">
          <h3 className="automation-section-title">
            <AiChatIcon size={14} /> Subagents
            <span className="automation-section-count">
              {sortedSubagents.length}
            </span>
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

/** An animated status indicator: pulses while running, steady/dim otherwise. */
function MonitorStatusDot({ automation }: { automation: Automation }) {
  const motion = monitorMotion(automation.status);
  return (
    <span
      className="monitor-status-dot"
      data-motion={motion}
      role="img"
      aria-label={`${statusLabel(automation.status)} monitor`}
      title={statusLabel(automation.status)}
    >
      <span className="monitor-status-core" aria-hidden="true" />
    </span>
  );
}

function AutomationCard({
  automation,
  nowMs,
  busyKey,
  onAction,
  onInterval,
}: {
  automation: Automation;
  nowMs: number;
  busyKey: string | null;
  onAction: (id: string, action: LifecycleAction) => void;
  onInterval: (id: string, intervalMs: number) => void;
}) {
  const api = useApi();
  const [logsOpen, setLogsOpen] = useState(false);
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  const countdown = nextRunLabel(automation, nowMs);
  const steps = automation.plannedSteps;
  const percent = progressPercent(automation);
  const eta = etaLabel(automation);
  const currentCall = activeStepLabel(automation);
  const editable = canCancel(automation.status);

  async function toggleLogs() {
    const next = !logsOpen;
    setLogsOpen(next);
    if (next && runs === null) {
      setLogsLoading(true);
      setLogsError(null);
      try {
        const detail = await api.getAutomation(automation.id);
        setRuns(detail.runs);
      } catch (err) {
        setLogsError(err instanceof Error ? err.message : String(err));
      } finally {
        setLogsLoading(false);
      }
    }
  }

  return (
    <div
      className="automation-card"
      data-motion={monitorMotion(automation.status)}
    >
      <div className="automation-card-head">
        <MonitorStatusDot automation={automation} />
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

      {percent !== null && (
        <div className="automation-progressbar" title={`${percent}% of runs`}>
          <div
            className="automation-progressbar-fill"
            data-motion={monitorMotion(automation.status)}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      <div className="automation-meta">
        <span title="Origin">{originLabel(automation.origin)}</span>
        <span>{intervalLabel(automation.intervalMs)}</span>
        <span>{runCountLabel(automation)}</span>
        {eta && <span title="Estimated time to finish">{eta}</span>}
        {automation.lastCheckedAt && (
          <span>
            Last checked{' '}
            {new Date(automation.lastCheckedAt).toLocaleTimeString()}
          </span>
        )}
        {countdown && (
          <span className="automation-countdown">
            <ClockIcon size={12} /> {countdown}
          </span>
        )}
      </div>

      {currentCall && (
        <p className="automation-current-call">
          <ActivityIcon size={12} /> Now: {currentCall}
        </p>
      )}

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
        {editable && (
          <label className="automation-freq" title="Change poll frequency">
            <ClockIcon size={12} />
            <select
              className="automation-freq-select"
              aria-label={`Poll frequency for ${automation.name}`}
              value={snapIntervalMs(automation.intervalMs)}
              disabled={busyKey === `interval:${automation.id}`}
              onChange={(event) =>
                onInterval(automation.id, Number(event.target.value))
              }
            >
              {intervalOptions.map((option) => (
                <option key={option.ms} value={option.ms}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {canPause(automation.status) && (
          <button
            type="button"
            className="ghost-button"
            disabled={busyKey === `pause:${automation.id}`}
            onClick={() => onAction(automation.id, 'pause')}
          >
            <PauseIcon size={14} /> Pause
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
            <PlayIcon size={14} />{' '}
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
              <PlayIcon size={14} /> Run now
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={busyKey === `cancel:${automation.id}`}
              onClick={() => onAction(automation.id, 'cancel')}
            >
              <StopIcon size={14} /> Stop
            </button>
          </>
        )}
        <button
          type="button"
          className="ghost-button"
          aria-expanded={logsOpen}
          onClick={() => void toggleLogs()}
        >
          <LogsIcon size={14} /> Logs <ChevronIcon size={12} open={logsOpen} />
        </button>
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

      {logsOpen && (
        <div className="automation-logs">
          <ErrorText error={logsError} />
          {logsLoading && (
            <p className="automation-logs-empty">Loading logs…</p>
          )}
          {!logsLoading && runs !== null && runs.length === 0 && (
            <p className="automation-logs-empty">No runs recorded yet.</p>
          )}
          {!logsLoading && runs !== null && runs.length > 0 && (
            <ol className="automation-run-list">
              {runs.map((run) => (
                <li
                  key={run.id}
                  className="automation-run"
                  data-status={run.status}
                >
                  <span className="automation-run-status">
                    {runStatusLabel(run.status)}
                  </span>
                  <span className="automation-run-time">
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                  <span
                    className="automation-run-detail"
                    title={runSummary(run)}
                  >
                    {runSummary(run)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
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

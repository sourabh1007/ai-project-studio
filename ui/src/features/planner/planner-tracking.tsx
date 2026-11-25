import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { Button, ErrorText, Modal } from '../../components/ui.js';
import { AiIcon, AutomationIcon, ClockIcon, PauseIcon, PlayIcon } from '../../components/icons.js';
import type { PlannerTrackingJob, PlannerTrackingResult, PlannerTrackingStatus } from '../../lib/types.js';
import './planner-tracking.css';

export function PlannerTrackingControl({ onUpdated }: { onUpdated: () => void }) {
  const api = useApi();
  const [status, setStatus] = useState<PlannerTrackingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);
  const version = useRef(0);
  const control = useRef<HTMLDetailsElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const positionPopover = useCallback(() => {
    if (!control.current?.open || !popover.current) return;
    const anchor = control.current.getBoundingClientRect();
    const pane = control.current.closest('.planner')?.getBoundingClientRect();
    const left = Math.max(8, (pane?.left ?? 0) + 8);
    const right = Math.min(window.innerWidth - 8, (pane?.right ?? window.innerWidth) - 8);
    const width = Math.min(360, Math.max(0, right - left));
    const x = Math.max(left, Math.min(anchor.left, right - width));
    popover.current.style.width = `${width}px`;
    const below = Math.max(0, window.innerHeight - anchor.bottom - 12);
    const above = Math.max(0, anchor.top - Math.max(8, pane?.top ?? 8) - 4);
    const openAbove = below < Math.min(popover.current.scrollHeight + 2, above);
    Object.assign(popover.current.style, {
      left: `${x - anchor.left}px`,
      top: openAbove ? 'auto' : 'calc(100% + 4px)',
      bottom: openAbove ? 'calc(100% + 4px)' : 'auto',
      maxHeight: `${openAbove ? above : below}px`,
    });
  }, []);
  const label = !error && status ? status.enabled ? status.running ? 'Tracking work' : 'Auto tracking' : 'Tracking paused' : 'Work tracking';
  const issue = error ?? status?.error;
  const state = !error && status?.enabled && status.running ? 'running' : issue ? 'error' : !status ? 'loading' : !status.enabled ? 'paused' : 'enabled';
  const activity = error ? 'Needs attention' : !status ? 'Checking status'
    : !status.enabled ? 'Paused' : status.running ? 'Processing work'
    : issue ? 'Needs attention' : status.queued ? 'Waiting for next pass' : 'Watching for work';
  const live = error ? null : status;
  const description = issue ?? (!status ? 'Checking auto tracking status.'
    : !status.enabled ? 'Auto tracking is paused.'
    : status.running ? 'Auto tracking is processing recorded work.'
    : 'Auto tracking is enabled.');
  useLayoutEffect(positionPopover, [positionPopover, status, error]);
  useEffect(() => {
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(positionPopover);
    for (const element of [control.current, popover.current, control.current?.closest('.planner')]) {
      if (element) observer?.observe(element);
    }
    window.addEventListener('resize', positionPopover);
    window.addEventListener('scroll', positionPopover, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', positionPopover);
      window.removeEventListener('scroll', positionPopover, true);
    };
  }, [positionPopover]);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let running = false;
    let updatedAt: string | null = null;
    const refresh = async () => {
      if (running || document.visibilityState === 'hidden') return;
      running = true;
      const requestVersion = version.current;
      try {
        const next = await api.plannerTrackingStatus();
        if (!active || requestVersion !== version.current) return;
        setStatus(next);
        setError(null);
        if (next.lastUpdatedAt && next.lastUpdatedAt !== updatedAt) {
          updatedAt = next.lastUpdatedAt;
          onUpdated();
        }
      } catch {
        if (active && requestVersion === version.current) setError('Tracking status is unavailable.');
      } finally { running = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [api, onUpdated]);
  return (
    <details ref={control} className="planner-tracking-control" onToggle={positionPopover}>
      <summary role="button" aria-label={label} data-state={state}
        title={`${description} Click for settings and details.`}>
        <span className="planner-tracking-indicator" aria-hidden="true">
          <AutomationIcon size={18} />
          <span className="planner-tracking-dot" />
        </span>
      </summary>
      <div ref={popover} className="planner-tracking-popover" data-state={state}>
      <header className="planner-tracking-heading">
        <span className="planner-tracking-emblem"><AutomationIcon size={20} /></span>
        <div><strong>Work tracking</strong><span>Incremental Planner updates</span></div>
        <span className="planner-tracking-badge">{state === 'running' ? 'Running' : state === 'error' ? 'Attention' : state === 'paused' ? 'Paused' : state === 'loading' ? 'Connecting' : 'Enabled'}</span>
      </header>
      <div className="planner-tracking-status" role="status">
        <strong>{activity}</strong>
        {status && <span>{status.lastUpdatedAt ? <>Last successful update: <time dateTime={status.lastUpdatedAt}>
          {new Date(status.lastUpdatedAt).toLocaleString()}
        </time></> : 'No successful update this launch yet.'}</span>}
      </div>
      <dl className="planner-tracking-metrics">
        <div><dt>Running</dt><dd>{live ? Number(live.running) : '--'}<span> / 1</span></dd></div>
        <div><dt>Queued</dt><dd>{live?.queued ?? '--'}</dd></div>
        <div><dt>Check interval</dt><dd>{live?.pollIntervalMs ? <>{live.pollIntervalMs / 1000}<span>s</span></> : '--'}</dd></div>
      </dl>
      {(error ?? status?.error) && <p className="error-text">{error ?? status?.error}</p>}
      <section className="planner-tracking-queue" aria-label="Tracking jobs">
        <div className="planner-tracking-section-title"><strong>Workspace queue</strong><span>One shared tracker</span></div>
        {live ? <>
          {live.currentJob && <TrackingJobRow job={live.currentJob} active paused={!live.enabled} />}
          {live.running && !live.currentJob && <p className="planner-tracking-empty">Discovering recorded work...</p>}
          {live.jobs && live.jobs.length > 0 && <ul className="planner-tracking-job-list">
            {live.jobs.map((job) => <li key={job.featureId}><TrackingJobRow job={job} paused={!live.enabled} /></li>)}
          </ul>}
          {!live.queued && !live.running && <p className="planner-tracking-empty">{live.enabled
            ? 'Nothing waiting. New recorded activity is picked up automatically.'
            : 'Tracking is paused. Resume to check for recorded work.'}</p>}
          {live.queued > 0 && !live.jobs && <p className="planner-tracking-empty">{live.queued} workspaces waiting. Job details are unavailable.</p>}
          {!live.enabled && live.queued > 0 && <p className="planner-tracking-note">Queued work is retained while paused.</p>}
        </> : <p className="planner-tracking-empty">Queue details are {error ? 'unavailable' : 'loading'}.</p>}
      </section>
      {status?.lastRun && <TrackingLastRun result={status.lastRun} stale={Boolean(error)} />}
      <p className="planner-tracking-note">One workspace is checked per pass. Discovery may reorder the queue. Unchanged evidence skips AI.</p>
      <details className="planner-tracking-help">
        <summary>How tracking works</summary>
        <p>Prompts and recorded agent activity become Planner tasks incrementally, using your configured background AI provider and model.</p>
        <p>Manual edits are preserved. Deleted tracked tasks stay deleted. Evidence is available from the AI icon beside each tracked task.</p>
        <p>Completion is reported by the assistant or agent, not independently verified. Prepared skills are distinguished from recorded invocations. Unavailable skill activity is not inferred.</p>
      </details>
      <footer className="planner-tracking-footer">
      <span><AiIcon size={13} /> Background AI uses credits</span>
      {status && <Button variant="ghost" disabled={saving} onClick={async () => {
        version.current++;
        setSaving(true);
        try {
          const next = await api.setPlannerTracking(!status.enabled);
          if (mounted.current) { setStatus(next); setError(null); }
        } catch { if (mounted.current) setError('Tracking preference could not be saved.'); }
        finally { if (mounted.current) setSaving(false); }
      }}>{status.enabled ? <PauseIcon size={12} /> : <PlayIcon size={12} />}{status.enabled ? 'Pause tracking' : 'Resume tracking'}</Button>}
      </footer>
      </div>
    </details>
  );
}

function TrackingTime({ value }: { value: string }) {
  return <time dateTime={value} title={new Date(value).toLocaleString()}>{new Date(value).toLocaleTimeString()}</time>;
}

function TrackingJobRow({ job, active = false, paused }: { job: PlannerTrackingJob; active?: boolean; paused: boolean }) {
  const phase = paused ? active ? 'Stopping' : 'Paused'
    : job.phase === 'retry-wait' ? 'Retry wait' : job.phase === 'analyzing' ? 'Analyzing evidence'
    : job.phase === 'reading' ? 'Reading activity' : 'Queued';
  return <div className={`planner-tracking-job${active ? ' is-active' : ''}`}>
    <span className="planner-tracking-job-icon">{active ? <AutomationIcon size={16} /> : <ClockIcon size={15} />}</span>
    <div className="planner-tracking-job-content">
      <div className="planner-tracking-job-title"><strong title={job.featureId}>{job.workspaceName}</strong><span>{phase}</span></div>
      <span className="planner-tracking-job-repo">{job.repositoryName ?? 'No linked repository'}</span>
      <p>{active && job.startedAt ? <>Started <TrackingTime value={job.startedAt} /></> : <>Queued <TrackingTime value={job.queuedAt} /></>}
        {job.evidenceCount !== null && <> · {job.evidenceCount} evidence records</>}
        {job.sessionCount !== null && <> · {job.sessionCount} sessions in evidence</>}
      </p>
      {job.retryAt && <p>Retry eligible after <TrackingTime value={job.retryAt} /></p>}
    </div>
  </div>;
}

function TrackingLastRun({ result, stale }: { result: PlannerTrackingResult; stale: boolean }) {
  const outcomes = {
    updated: result.taskCount ? `${result.taskCount} tasks refreshed` : 'No task changes',
    unchanged: 'No new evidence', 'no-evidence': 'No recorded evidence',
    unavailable: 'Workspace unavailable', 'retry-wait': 'Waiting to retry',
    failed: 'Pass failed', cancelled: 'Pass cancelled',
  };
  return <section className="planner-tracking-last-run" aria-label="Last tracking pass">
    <div className="planner-tracking-section-title"><strong>{stale ? 'Last known pass' : 'Last pass'}</strong><TrackingTime value={result.finishedAt} /></div>
    <p><span title={result.job.featureId}>{result.job.workspaceName}</span><strong>{outcomes[result.outcome]}</strong></p>
    {result.job.retryAt && <p className="planner-tracking-note">Retry eligible after <TrackingTime value={result.job.retryAt} />; rediscovery or new activity schedules another check.</p>}
  </section>;
}

export function PlannerTaskEvidence({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="ghost" ariaLabel="Show tracked work evidence" title="Automatically tracked: show evidence" onClick={() => setOpen(true)}>
      <AiIcon size={14} />
    </Button>
    {open && <EvidenceDialog taskId={taskId} onClose={() => setOpen(false)} />}
  </>;
}

function EvidenceDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const api = useApi();
  const evidence = useAsync(() => api.plannerTaskEvidence(taskId), [api, taskId]);
  return <Modal title="Work evidence" onClose={onClose}>
    <ErrorText error={evidence.error} />
    {evidence.loading && <p role="status">Loading evidence...</p>}
    {!evidence.loading && !evidence.error && !evidence.data && <p>No recorded tracking evidence.</p>}
    {evidence.data && <>
      <p>{evidence.data.completion === 'reported-complete' ? 'Reported complete, not independently verified.' : 'Requested or ongoing work.'} Your task status may have been manually changed.</p>
      <p>Skill preparation or injection is not proof of invocation. Only recorded activity is shown.</p>
      {evidence.data.evidence.map((item) => <details key={item.id}>
        <summary>{item.kind}: {item.label}</summary>
        <p>{item.at || 'Time unavailable'}{item.sessionId ? ` | Session ${item.sessionId}` : ''}{item.truncated ? ' | Excerpt only' : ''}</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.text}</pre>
      </details>)}
    </>}
  </Modal>;
}

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useApi } from '../../app/api-context.js';
import { ApiError } from '../../lib/api.js';
import { Button, ErrorText } from '../../components/ui.js';
import {
  ActivityIcon,
  ArrowDownIcon,
  CheckIcon,
  ChevronIcon,
  FileIcon,
  LaunchIcon,
  MoveIcon,
  PencilIcon,
  PrReviewIcon,
  TaskPlanSkillIcon,
} from '../../components/icons.js';
import { renderMarkdownComment } from '../../lib/markdown.js';
import { annotateDiffLines } from '../../lib/diff-lines.js';
import type {
  Feature,
  NewTaskAgent,
  NewTaskFileChange,
  NewTaskFileDiff,
  NewTaskImplementEvent,
  NewTaskRun,
} from '../../lib/types.js';

interface NewTaskPageProps {
  feature: Feature;
  attachmentId: string;
}

/** The ordered wizard steps the user walks through. */
type Step = 'describe' | 'plan' | 'review' | 'implement' | 'summary';

const STEP_ORDER: Step[] = [
  'describe',
  'plan',
  'review',
  'implement',
  'summary',
];

const STEP_META: Record<Step, { label: string; hint: string }> = {
  describe: { label: 'Describe', hint: 'Problem & context' },
  plan: { label: 'Plan', hint: 'Live planning logs' },
  review: { label: 'Review', hint: 'Read the plan' },
  implement: { label: 'Implement', hint: 'Live build logs' },
  summary: { label: 'Summary', hint: 'PR & changes' },
};

/** Human-readable phase labels for the streamed activity. */
const PHASE_LABEL: Record<string, string> = {
  planning: 'Planning',
  implementing: 'Implementing',
  'creating-pr': 'Opening pull request',
  done: 'Done',
};

/** A single symbol per change type, for the file summary. */
const CHANGE_GLYPH: Record<NewTaskFileChange['changeType'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

/** Human-readable label per agent specialization. */
const AGENT_ROLE_LABEL: Record<NewTaskAgent['role'], string> = {
  planner: 'Planner',
  manager: 'Lead agent',
  developer: 'Developer',
  tester: 'Tester',
};

/**
 * The effective duration to display for an agent: a live-ticking elapsed time
 * while it is running (from its `startedAt`), or its final `durationMs` once it
 * ends. `nowMs` is the ticking clock the page supplies.
 */
function agentDuration(agent: NewTaskAgent, nowMs: number): number | null {
  if (agent.status === 'running' && agent.startedAt != null) {
    return Math.max(0, nowMs - agent.startedAt);
  }
  return agent.durationMs;
}

/** Format a duration in ms as a compact "500ms" / "1.2s" / "1m 05s". */
function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

/** Warm turns report no credits, so render AIC as "n/a" when unknown. */
function formatCredits(credits: number | null): string {
  return credits == null ? 'n/a' : `${credits.toFixed(2)} AIC`;
}

/** Sum token counts across a set of agents, treating unknown as zero. */
function sumTokens(agents: NewTaskAgent[]): number {
  return agents.reduce(
    (total, agent) =>
      total + (agent.inputTokens ?? 0) + (agent.outputTokens ?? 0),
    0,
  );
}

/** Sum AI credits across agents, yielding null when every value is unknown. */
function sumCredits(agents: NewTaskAgent[]): number | null {
  const known = agents
    .map((agent) => agent.credits)
    .filter((credits): credits is number => credits != null);
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
}

/** One agent card in the team hierarchy; click to open its live log. */
function AgentCard({
  agent,
  workers,
  nowMs,
  onOpen,
  onOpenFile,
}: {
  agent: NewTaskAgent;
  workers: NewTaskAgent[];
  nowMs: number;
  onOpen: (id: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const isLive = agent.status === 'running';
  return (
    <div className={`new-task-agent-card role-${agent.role} is-${agent.status}`}>
      <button
        type="button"
        className="new-task-agent-head"
        onClick={() => onOpen(agent.id)}
        title="Show this agent's live log"
      >
        <span
          className={`new-task-agent-dot is-${agent.status}`}
          aria-hidden="true"
        />
        <span className="new-task-agent-title">
          <span className="new-task-agent-role">
            {AGENT_ROLE_LABEL[agent.role]}
          </span>
          {agent.title}
        </span>
        <span className="new-task-agent-metrics">
          <span
            className={isLive ? 'new-task-metric-live' : undefined}
            title="Time taken"
          >
            {formatDuration(agentDuration(agent, nowMs))}
          </span>
          <span title="AI credits used">{formatCredits(agent.credits)}</span>
        </span>
      </button>
      {agent.files.length > 0 && (
        <div className="new-task-agent-files">
          {agent.files.map((file) => (
            <button
              key={file}
              type="button"
              className="new-task-file-chip"
              onClick={() => onOpenFile(file)}
              title="Show this file's diff"
            >
              {file}
            </button>
          ))}
        </div>
      )}
      {workers.length > 0 && (
        <div className="new-task-agent-children">
          {workers.map((worker) => (
            <AgentCard
              key={worker.id}
              agent={worker}
              workers={[]}
              nowMs={nowMs}
              onOpen={onOpen}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The hierarchical panel of agents working a plan, with per-agent metrics. */
function AgentTeamPanel({
  agents,
  nowMs,
  onOpen,
  onOpenFile,
}: {
  agents: NewTaskAgent[];
  nowMs: number;
  onOpen: (id: string) => void;
  onOpenFile: (path: string) => void;
}) {
  if (agents.length === 0) return null;
  const roots = agents.filter((agent) => agent.parentId === null);
  const workersOf = (id: string) =>
    agents.filter((agent) => agent.parentId === id);
  const totalCredits = sumCredits(agents);
  const anyRunning = agents.some((agent) => agent.status === 'running');
  return (
    <section className="new-task-team">
      <h3>
        <ActivityIcon size={15} /> Agents &amp; sub-agents
        <span className="new-task-log-count">{agents.length}</span>
        <span
          className={`new-task-team-total${anyRunning ? ' new-task-metric-live' : ''}`}
        >
          {sumTokens(agents).toLocaleString()} tokens ·{' '}
          {formatCredits(totalCredits)}
        </span>
      </h3>
      <div className="new-task-team-grid">
        {roots.map((root) => (
          <AgentCard
            key={root.id}
            agent={root}
            workers={workersOf(root.id)}
            nowMs={nowMs}
            onOpen={onOpen}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </section>
  );
}

/** A modal showing a single agent's live log and its metrics. */
function AgentLogModal({
  agent,
  lines,
  nowMs,
  onClose,
}: {
  agent: NewTaskAgent;
  lines: string[];
  nowMs: number;
  onClose: () => void;
}) {
  return (
    <div
      className="new-task-modal-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="new-task-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${agent.title} activity`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="new-task-modal-head">
          <div>
            <span className="new-task-agent-role">
              {AGENT_ROLE_LABEL[agent.role]}
            </span>
            <strong>{agent.title}</strong>
          </div>
          <button
            type="button"
            className="new-task-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="new-task-modal-metrics">
          <span>Status: {agent.status}</span>
          <span>Time: {formatDuration(agentDuration(agent, nowMs))}</span>
          <span>AIC: {formatCredits(agent.credits)}</span>
          <span>
            Tokens: {(agent.inputTokens ?? 0).toLocaleString()} in /{' '}
            {(agent.outputTokens ?? 0).toLocaleString()} out
          </span>
        </div>
        <div className="new-task-log-body new-task-modal-log">
          {lines.length === 0 ? (
            <p className="muted new-task-log-empty">
              No activity captured for this agent yet.
            </p>
          ) : (
            lines.map((line, i) => (
              <div key={i} className="new-task-log-line">
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** A modal showing one changed file's unified diff, with a full-file toggle. */
function FileDiffModal({
  path,
  diff,
  loading,
  error,
  showFull,
  onToggleFull,
  onClose,
}: {
  path: string;
  diff: NewTaskFileDiff | null;
  loading: boolean;
  error: string | null;
  showFull: boolean;
  onToggleFull: () => void;
  onClose: () => void;
}) {
  const lines = diff ? annotateDiffLines(diff.diff) : [];
  const fullLines = diff ? diff.content.replace(/\n$/, '').split('\n') : [];
  return (
    <div
      className="new-task-modal-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="new-task-modal new-task-diff-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${path} diff`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="new-task-modal-head">
          <div className="new-task-diff-title">
            <FileIcon size={14} />
            <code>{path}</code>
          </div>
          <div className="new-task-diff-actions">
            <button
              type="button"
              className={`new-task-diff-toggle${showFull ? ' is-active' : ''}`}
              onClick={onToggleFull}
              disabled={loading || !diff}
            >
              {showFull ? 'Show diff' : 'Show full file'}
            </button>
            <button
              type="button"
              className="new-task-modal-close"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>
        <div className="new-task-diff-body">
          {loading ? (
            <p className="muted new-task-log-empty">Loading diff…</p>
          ) : error ? (
            <ErrorText error={error} />
          ) : !diff ? null : showFull ? (
            <pre className="new-task-diff-full">
              {fullLines.length === 0 ? (
                <span className="muted">This file has no content on the branch.</span>
              ) : (
                fullLines.map((line, i) => (
                  <div key={i} className="new-task-diff-full-line">
                    <span className="new-task-diff-gutter">{i + 1}</span>
                    <span className="new-task-diff-text">{line || ' '}</span>
                  </div>
                ))
              )}
            </pre>
          ) : lines.length === 0 ? (
            <p className="muted new-task-log-empty">
              No differences to show for this file.
            </p>
          ) : (
            <pre className="new-task-diff-unified">
              {lines.map((line, i) => (
                <div
                  key={i}
                  className={`new-task-diff-line is-${line.kind}`}
                >
                  <span className="new-task-diff-gutter">
                    {line.rightLine ?? ''}
                  </span>
                  <span className="new-task-diff-text">{line.raw || ' '}</span>
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/** The numbered progress rail across the top of the wizard. */
function Stepper({
  current,
  reachable,
  onSelect,
}: {
  current: Step;
  reachable: Set<Step>;
  onSelect: (step: Step) => void;
}) {
  const currentIndex = STEP_ORDER.indexOf(current);
  return (
    <ol className="new-task-stepper" role="list">
      {STEP_ORDER.map((step, index) => {
        const isCurrent = step === current;
        const isDone = index < currentIndex && reachable.has(step);
        const canOpen = reachable.has(step) && !isCurrent;
        const stateClass = isCurrent
          ? ' is-current'
          : isDone
            ? ' is-done'
            : reachable.has(step)
              ? ' is-reachable'
              : ' is-todo';
        return (
          <li key={step} className={`new-task-step${stateClass}`}>
            <button
              type="button"
              className="new-task-step-btn"
              aria-current={isCurrent ? 'step' : undefined}
              disabled={!canOpen}
              onClick={() => canOpen && onSelect(step)}
            >
              <span className="new-task-step-index" aria-hidden="true">
                {isDone ? <CheckIcon size={13} /> : index + 1}
              </span>
              <span className="new-task-step-text">
                <span className="new-task-step-label">
                  {STEP_META[step].label}
                </span>
                <span className="new-task-step-hint">{STEP_META[step].hint}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** A scrolling monospace log panel for streamed activity lines. */
function ActivityLog({
  title,
  lines,
  busy,
  tall,
}: {
  title: string;
  lines: string[];
  busy: boolean;
  tall?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (body) {
      body.scrollTop = body.scrollHeight;
    }
  }, [lines]);
  return (
    <section className={`new-task-log${tall ? ' new-task-log--tall' : ''}`}>
      <h3>
        {busy && <span className="new-task-spinner" aria-hidden="true" />}
        <ActivityIcon size={15} />
        {title}
        <span className="new-task-log-count">{lines.length}</span>
      </h3>
      <div className="new-task-log-body" ref={bodyRef}>
        {lines.length === 0 ? (
          <p className="muted new-task-log-empty">Waiting for the agent…</p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="new-task-log-line">
              {line}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/** One entry in the implementation activity log, tagged with its agent. */
interface ImplLogEntry {
  line: string;
  agentId?: string;
}

/**
 * The implementation activity log. Unlike the plain {@link ActivityLog}, each
 * line is tagged with the sub-agent that emitted it (resolved live from the
 * `agents` map) so the user can see which specialist is doing what.
 */
function ImplementActivityLog({
  entries,
  busy,
  agents,
}: {
  entries: ImplLogEntry[];
  busy: boolean;
  agents: Record<string, NewTaskAgent>;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (body) {
      body.scrollTop = body.scrollHeight;
    }
  }, [entries]);
  return (
    <section className="new-task-log new-task-log--tall">
      <h3>
        {busy && <span className="new-task-spinner" aria-hidden="true" />}
        <ActivityIcon size={15} />
        Implementation activity
        <span className="new-task-log-count">{entries.length}</span>
      </h3>
      <div className="new-task-log-body" ref={bodyRef}>
        {entries.length === 0 ? (
          <p className="muted new-task-log-empty">Waiting for the agents…</p>
        ) : (
          entries.map((entry, i) => {
            const agent = entry.agentId ? agents[entry.agentId] : undefined;
            return (
              <div key={i} className="new-task-log-line">
                {agent && (
                  <span className={`new-task-log-tag role-${agent.role}`}>
                    {AGENT_ROLE_LABEL[agent.role]}
                    {agent.title ? ` · ${agent.title}` : ''}
                  </span>
                )}
                {entry.line}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/** A back/next navigation footer shared across steps. */
function StepNav({
  back,
  children,
}: {
  back?: { label: string; onClick: () => void };
  children?: ReactNode;
}) {
  return (
    <div className="new-task-stepnav">
      <div className="new-task-stepnav-back">
        {back && (
          <Button variant="ghost" onClick={back.onClick}>
            <span className="new-task-chevron-back" aria-hidden="true">
              <ChevronIcon size={16} />
            </span>
            {back.label}
          </Button>
        )}
      </div>
      <div className="new-task-stepnav-fwd">{children}</div>
    </div>
  );
}

/**
 * The New Task agent page. It walks the user through a repository change end to
 * end: capture the problem + context, stream the meta-session's live planning
 * logs, present a readable plan for review, and — once accepted — cut a branch
 * from the base, implement the change, open a PR, and report the branch, PR and
 * changed-file summary. The task then becomes Review-Board-eligible.
 */
export function NewTaskPage({ feature, attachmentId }: NewTaskPageProps) {
  const api = useApi();
  const [run, setRun] = useState<NewTaskRun | null>(null);
  const [problem, setProblem] = useState('');
  const [context, setContext] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [implementing, setImplementing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [planLog, setPlanLog] = useState<string[]>([]);
  const [implementLog, setImplementLog] = useState<ImplLogEntry[]>([]);
  const [agents, setAgents] = useState<Record<string, NewTaskAgent>>({});
  const [agentLogs, setAgentLogs] = useState<Record<string, string[]>>({});
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<NewTaskFileDiff | null>(null);
  const [fileDiffLoading, setFileDiffLoading] = useState(false);
  const [fileDiffError, setFileDiffError] = useState<string | null>(null);
  const [showFullFile, setShowFullFile] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [phase, setPhase] = useState<string | null>(null);
  const [changedFiles, setChangedFiles] = useState<NewTaskFileChange[] | null>(
    null,
  );
  const [step, setStep] = useState<Step>('describe');
  const [showSuggestion, setShowSuggestion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionNote, setSessionNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reconnectedRef = useRef(false);
  const prevStatusRef = useRef<string | undefined>(undefined);

  const hydrate = useCallback((next: NewTaskRun | null) => {
    setRun(next);
    if (next) {
      setProblem(next.problem);
      setContext(next.context);
      if (next.agents.length > 0) {
        setAgents((prev) => {
          const merged = { ...prev };
          for (const agent of next.agents) merged[agent.id] = agent;
          return merged;
        });
      }
    }
  }, []);

  // Fold a streamed `agent` snapshot / per-agent activity line into local state
  // so the team panel and its per-agent log popups stay live. Shared by the
  // plan, implement and reconnect streams.
  const applyAgentEvent = useCallback((event: NewTaskImplementEvent) => {
    if (event.type === 'agent') {
      setAgents((prev) => ({ ...prev, [event.agent.id]: event.agent }));
    } else if (event.type === 'activity' && event.agentId) {
      const agentId = event.agentId;
      const label = PHASE_LABEL[event.phase] ?? event.phase;
      setAgentLogs((prev) => ({
        ...prev,
        [agentId]: [...(prev[agentId] ?? []), `${label}: ${event.line}`],
      }));
    }
  }, []);

  // Clear all live run state and return the wizard to its first step. Used both
  // when the backend reports a run was `cancelled` and after the user triggers a
  // cancel-and-reset, so the page never lingers on a stuck spinner.
  const resetToDraft = useCallback(() => {
    setPlanning(false);
    setImplementing(false);
    setPhase(null);
    setPlanLog([]);
    setImplementLog([]);
    setAgents({});
    setAgentLogs({});
    setOpenAgentId(null);
    setChangedFiles(null);
    setShowSuggestion(false);
    setSuggestion('');
    setStep('describe');
    reconnectedRef.current = false;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getNewTask(feature.id, attachmentId)
      .then((res) => {
        if (!cancelled) hydrate(res.run);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [api, feature.id, attachmentId, hydrate]);

  // Reconnect to a run that is still in flight on the backend (planning or
  // implementing) so returning to this window resumes the live logs instead of
  // showing a frozen form. The run keeps going on the server regardless of this
  // socket; if none is live the stream ends at once with no events and the
  // status-driven "interrupted — resume" affordance takes over.
  useEffect(() => {
    if (loading || reconnectedRef.current) return;
    const status = run?.status;
    if (status !== 'planning' && status !== 'implementing') return;
    reconnectedRef.current = true;
    const isPlan = status === 'planning';
    const controller = new AbortController();
    if (isPlan) {
      setPlanning(true);
      setPlanLog([]);
    } else {
      setImplementing(true);
      setImplementLog([]);
      setChangedFiles(null);
    }
    setAgents({});
    setAgentLogs({});
    api
      .streamNewTask(
        feature.id,
        attachmentId,
        (event: NewTaskImplementEvent) => {
          applyAgentEvent(event);
          if (event.type === 'agent') {
            return;
          } else if (event.type === 'activity') {
            const label = PHASE_LABEL[event.phase] ?? event.phase;
            if (isPlan) {
              setPlanLog((prev) => [...prev, `${label}: ${event.line}`]);
            } else {
              setPhase(event.phase);
              setImplementLog((prev) => [
                ...prev,
                { line: `${label}: ${event.line}`, agentId: event.agentId },
              ]);
            }
          } else if (event.type === 'done') {
            if (!isPlan) setChangedFiles(event.files ?? []);
            hydrate(event.run);
          } else if (event.type === 'cancelled') {
            resetToDraft();
          } else {
            setError(event.error);
          }
        },
        controller.signal,
      )
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (isPlan) {
          setPlanning(false);
        } else {
          setImplementing(false);
          setPhase(null);
        }
      });
    return () => controller.abort();
  }, [api, feature.id, attachmentId, hydrate, loading, run?.status, resetToDraft, applyAgentEvent]);

  // Drive the wizard from run-status transitions: a landed plan opens Review, a
  // started implementation opens the build logs, and an opened PR opens the
  // Summary. Manual back/forward navigation via the stepper still works because
  // this only reacts to *changes* in the backend status.
  useEffect(() => {
    if (loading) return;
    const prev = prevStatusRef.current;
    const status = run?.status;
    if (status === prev) return;
    prevStatusRef.current = status;
    if (status === 'planning') setStep('plan');
    else if (status === 'planned') setStep('review');
    else if (status === 'implementing') setStep('implement');
    else if (status === 'pr-created') setStep('summary');
    // A failed run with a branch stopped mid-implementation; open the Implement
    // step so its resume affordance is visible instead of the raw draft form.
    else if (status === 'failed' && run?.branch) setStep('implement');
  }, [loading, run?.status, run?.branch]);

  // Tick a 1s clock while any agent is actively running so the per-agent and
  // team elapsed timers update live. It stops as soon as no agent is running,
  // leaving the final durations in place.
  useEffect(() => {
    const anyRunning = Object.values(agents).some(
      (agent) => agent.status === 'running',
    );
    if (!anyRunning) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [agents]);

  const locked =
    run?.status === 'pr-created' ||
    run?.status === 'implementing' ||
    implementing;

  const runPlan = useCallback(
    async (withSuggestion: boolean) => {
      setError(null);
      setPlanning(true);
      setPlanLog([]);
      setAgents({});
      setAgentLogs({});
      setStep('plan');
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await api.saveNewTaskInputs(feature.id, attachmentId, {
          problem,
          context,
        });
        await api.planNewTask(
          feature.id,
          attachmentId,
          (event: NewTaskImplementEvent) => {
            applyAgentEvent(event);
            if (event.type === 'agent') {
              return;
            } else if (event.type === 'activity') {
              setPlanLog((prev) => [...prev, event.line]);
            } else if (event.type === 'done') {
              hydrate(event.run);
              if (event.run.status === 'planned') {
                setShowSuggestion(false);
                setSuggestion('');
              } else if (event.run.error) {
                setError(event.run.error);
              }
            } else if (event.type === 'cancelled') {
              resetToDraft();
            } else {
              setError(event.error);
            }
          },
          controller.signal,
          {
            baseBranch: baseBranch.trim() || undefined,
            suggestion: withSuggestion ? suggestion.trim() || undefined : undefined,
          },
        );
      } catch (err: unknown) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setPlanning(false);
      }
    },
    [api, feature.id, attachmentId, problem, context, baseBranch, suggestion, hydrate, resetToDraft, applyAgentEvent],
  );

  const runImplement = useCallback(async () => {
    setError(null);
    setImplementLog([]);
    setAgents({});
    setAgentLogs({});
    setChangedFiles(null);
    setPhase('implementing');
    setImplementing(true);
    setStep('implement');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.implementNewTask(
        feature.id,
        attachmentId,
        (event: NewTaskImplementEvent) => {
          applyAgentEvent(event);
          if (event.type === 'agent') {
            return;
          } else if (event.type === 'activity') {
            const label = PHASE_LABEL[event.phase] ?? event.phase;
            setPhase(event.phase);
            setImplementLog((prev) => [
              ...prev,
              { line: `${label}: ${event.line}`, agentId: event.agentId },
            ]);
          } else if (event.type === 'done') {
            setPhase(null);
            setChangedFiles(event.files ?? []);
            hydrate(event.run);
          } else if (event.type === 'cancelled') {
            resetToDraft();
          } else {
            setError(event.error);
          }
        },
        controller.signal,
      );
    } catch (err: unknown) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setImplementing(false);
      setPhase(null);
    }
  }, [api, feature.id, attachmentId, hydrate, resetToDraft, applyAgentEvent]);

  // Cancel-and-reset the in-flight run: stop the local stream at once, ask the
  // backend to abort the metasession (terminating any attached agent process)
  // and reset the run to a clean draft, then clear the UI.
  const runCancel = useCallback(async () => {
    setCancelling(true);
    setError(null);
    try {
      abortRef.current?.abort();
      const res = await api.cancelNewTask(feature.id, attachmentId);
      hydrate(res.run);
      resetToDraft();
    } catch (err: unknown) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setCancelling(false);
    }
  }, [api, feature.id, attachmentId, hydrate, resetToDraft]);

  const startSession = useCallback(async () => {
    setSessionNote(null);
    try {
      const session = await api.createTerminalSession(feature.id, {
        kind: 'dev',
      });
      setSessionNote(`Started session ${session.id}.`);
    } catch (err: unknown) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setError(message);
    }
  }, [api, feature.id]);

  // Fetch and show one changed file's diff. Opens the modal in a loading state,
  // then fills it (or an error) once the branch diff resolves.
  const openFile = useCallback(
    async (path: string) => {
      setOpenFilePath(path);
      setFileDiff(null);
      setFileDiffError(null);
      setShowFullFile(false);
      setFileDiffLoading(true);
      try {
        const diff = await api.getNewTaskFileDiff(feature.id, attachmentId, path);
        setFileDiff(diff);
      } catch (err: unknown) {
        setFileDiffError(err instanceof Error ? err.message : String(err));
      } finally {
        setFileDiffLoading(false);
      }
    },
    [api, feature.id, attachmentId],
  );

  const closeFile = useCallback(() => {
    setOpenFilePath(null);
    setFileDiff(null);
    setFileDiffError(null);
  }, []);

  const planHtml = useMemo(
    () => (run?.plan ? renderMarkdownComment(run.plan) : ''),
    [run?.plan],
  );

  const agentList = useMemo(() => Object.values(agents), [agents]);
  const plannerAgents = useMemo(
    () => agentList.filter((agent) => agent.role === 'planner'),
    [agentList],
  );
  const teamAgents = useMemo(
    () => agentList.filter((agent) => agent.role !== 'planner'),
    [agentList],
  );
  // The number of files the change touched. Prefer the live `done` summary; on a
  // reload (where that stream state is gone) fall back to the union of files the
  // persisted sub-agents owned, so the summary still reports a count.
  const changedFileCount = useMemo(() => {
    if (changedFiles) return changedFiles.length;
    const union = new Set<string>();
    for (const agent of teamAgents) {
      for (const file of agent.files) union.add(file);
    }
    return union.size > 0 ? union.size : null;
  }, [changedFiles, teamAgents]);
  const openAgent = openAgentId ? agents[openAgentId] : undefined;

  if (loading) {
    return <div className="agent-page">Loading…</div>;
  }

  const hasPlan = !!run?.plan;
  const status = run?.status;
  const prOpen = status === 'pr-created';
  const planReady = status === 'planned';
  // A run the user can resume from the Implement step: one interrupted mid-run
  // (still marked implementing) or one that failed after a plan + branch were
  // created (e.g. the PR step errored). A planning failure has no branch yet, so
  // it stays out of this and is handled back on the plan step.
  const resumable =
    (status === 'implementing' || (status === 'failed' && !!run?.branch)) &&
    hasPlan;
  const interrupted = resumable && !implementing;
  // A re-plan is running while an older plan is still on record. The visible
  // plan is the PREVIOUS one until the new run finishes, so the UI must not
  // imply a fresh plan is already available.
  const isReplanning = (planning || status === 'planning') && hasPlan;
  const canPlan = problem.trim().length > 0;

  // Which steps the user may open. `describe` is always available; the rest
  // unlock as the run progresses (or when logs exist to review).
  const reachable = new Set<Step>(['describe']);
  if (planning || planLog.length > 0 || hasPlan || interrupted || prOpen)
    reachable.add('plan');
  if (hasPlan || interrupted || prOpen) reachable.add('review');
  if (implementing || implementLog.length > 0 || interrupted || prOpen)
    reachable.add('implement');
  if (prOpen) reachable.add('summary');

  const statusMessage = planning
    ? 'The agent is analysing the problem and drafting a plan…'
    : implementing
      ? `${PHASE_LABEL[phase ?? 'implementing'] ?? 'Implementing'} the change…`
      : null;

  const StatusBanner = statusMessage ? (
    <div className="new-task-status" role="status" aria-live="polite">
      <span className="new-task-spinner" aria-hidden="true" />
      <span>{statusMessage}</span>
    </div>
  ) : null;

  return (
    <div className="agent-page new-task-page">
      <header className="agent-page-header">
        <LaunchIcon size={20} />
        <div>
          <h2>New Task</h2>
          <p className="muted">
            Plan and ship a change in <strong>{feature.name}</strong> — the agent
            plans it for your review, implements it, and opens a pull request.
          </p>
        </div>
      </header>

      <Stepper current={step} reachable={reachable} onSelect={setStep} />

      <ErrorText error={error} />

      <div className="new-task-step-panel">
        {step === 'describe' && (
          <section className="new-task-inputs">
            <label>
              <span>Problem statement</span>
              <textarea
                rows={3}
                value={problem}
                disabled={locked || planning}
                placeholder="What needs to change, and why?"
                onChange={(e) => setProblem(e.target.value)}
              />
            </label>
            <label>
              <span>Context (optional)</span>
              <textarea
                rows={4}
                value={context}
                disabled={locked || planning}
                placeholder="Relevant files, constraints, acceptance criteria…"
                onChange={(e) => setContext(e.target.value)}
              />
            </label>
            <label className="new-task-base">
              <span>Base branch (optional)</span>
              <input
                type="text"
                value={baseBranch}
                disabled={locked || planning}
                placeholder="Defaults to the repository's default branch"
                onChange={(e) => setBaseBranch(e.target.value)}
              />
            </label>
            <StepNav>
              {!locked && (
                <Button
                  onClick={() => void runPlan(false)}
                  loading={planning}
                  disabled={!canPlan}
                >
                  {hasPlan ? 'Re-plan from scratch' : 'Plan change'}
                </Button>
              )}
              {reachable.has('plan') && !planning && (
                <Button variant="secondary" onClick={() => setStep('plan')}>
                  View planning logs
                </Button>
              )}
            </StepNav>
          </section>
        )}

        {step === 'plan' && (
          <div className="new-task-step-body">
            {StatusBanner}
            <AgentTeamPanel
              agents={plannerAgents}
              nowMs={nowMs}
              onOpen={setOpenAgentId}
              onOpenFile={openFile}
            />
            <ActivityLog
              title="Planning activity"
              lines={planLog}
              busy={planning}
              tall
            />
            <StepNav
              back={{ label: 'Back', onClick: () => setStep('describe') }}
            >
              {(planning || status === 'planning') && (
                <Button
                  variant="danger"
                  onClick={() => void runCancel()}
                  loading={cancelling}
                >
                  Cancel &amp; reset
                </Button>
              )}
              {hasPlan ? (
                <>
                  {isReplanning && (
                    <span className="muted new-task-wait-note">
                      Generating a new plan — you can still read the previous
                      one below.
                    </span>
                  )}
                  <Button onClick={() => setStep('review')}>
                    <ArrowDownIcon size={16} />{' '}
                    {isReplanning ? 'Read the previous plan' : 'Read the plan'}
                  </Button>
                </>
              ) : (
                <span className="muted new-task-wait-note">
                  The plan opens here automatically when it's ready.
                </span>
              )}
            </StepNav>
          </div>
        )}

        {step === 'review' && (
          <div className="new-task-step-body">
            {hasPlan ? (
              <section className="new-task-plan">
                <div className="new-task-plan-head">
                  <h3>
                    <TaskPlanSkillIcon size={16} />{' '}
                    {isReplanning ? 'Previous plan' : 'Proposed plan'}
                  </h3>
                  {run?.branch && (
                    <span className="new-task-branch-chip" title="Change branch">
                      <MoveIcon size={12} /> {run.branch}
                    </span>
                  )}
                </div>
                {isReplanning && (
                  <p className="muted new-task-accept-note">
                    A new plan is being generated. This is the previous plan,
                    shown for reference until the new one is ready.
                  </p>
                )}
                <div
                  className="cg-chat-md new-task-plan-md"
                  dangerouslySetInnerHTML={{ __html: planHtml }}
                />
                {prOpen && (
                  <p className="muted">
                    This plan has been implemented and a pull request is open.
                  </p>
                )}
                {planReady && (
                  <p className="muted new-task-accept-note">
                    Accepting cuts a branch from{' '}
                    <code>{baseBranch.trim() || 'the default branch'}</code>,
                    implements the plan in an isolated worktree, and opens a pull
                    request.
                  </p>
                )}
                {showSuggestion && planReady && (
                  <div className="new-task-suggestion">
                    <textarea
                      rows={3}
                      value={suggestion}
                      placeholder="What should the agent change about this plan?"
                      onChange={(e) => setSuggestion(e.target.value)}
                    />
                    <Button
                      variant="secondary"
                      onClick={() => void runPlan(true)}
                      loading={planning}
                      disabled={suggestion.trim().length === 0}
                    >
                      Re-plan with this feedback
                    </Button>
                  </div>
                )}
              </section>
            ) : (
              <p className="muted">No plan yet — run planning first.</p>
            )}
            <StepNav
              back={{ label: 'Back', onClick: () => setStep('describe') }}
            >
              {planReady && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => setShowSuggestion((s) => !s)}
                  >
                    <PencilIcon size={16} /> Re-plan with a suggestion
                  </Button>
                  <Button onClick={() => void runImplement()}>
                    <CheckIcon size={16} /> Accept &amp; implement
                  </Button>
                </>
              )}
              {prOpen && (
                <Button onClick={() => setStep('summary')}>
                  <ArrowDownIcon size={16} /> View summary
                </Button>
              )}
            </StepNav>
          </div>
        )}

        {step === 'implement' && (
          <div className="new-task-step-body">
            {interrupted ? (
              <section className="new-task-plan-ready new-task-interrupted">
                <div className="new-task-plan-ready-head">
                  <MoveIcon size={18} />
                  <div>
                    <strong>
                      {status === 'failed'
                        ? 'The previous attempt did not finish'
                        : 'Implementation was interrupted'}
                    </strong>
                    <p className="muted">
                      {status === 'failed'
                        ? 'The last implementation run stopped before opening a pull request'
                        : "A previous implementation run didn't finish (the app likely closed or reloaded mid-run)"}
                      . The plan and its branch{' '}
                      {run?.branch && <code>{run.branch}</code>} are intact.
                      Resume to pick up where it left off — any work already
                      committed on the branch is reused.
                    </p>
                    {status === 'failed' && run?.error && (
                      <p className="new-task-interrupted-reason">
                        Last error: {run.error}
                      </p>
                    )}
                  </div>
                </div>
                <Button
                  onClick={() => void runImplement()}
                  loading={implementing}
                >
                  <CheckIcon size={16} /> Resume implementation
                </Button>
              </section>
            ) : (
              <>
                {StatusBanner}
                <AgentTeamPanel
                  agents={teamAgents}
                  nowMs={nowMs}
                  onOpen={setOpenAgentId}
                  onOpenFile={openFile}
                />
                <ImplementActivityLog
                  entries={implementLog}
                  busy={implementing}
                  agents={agents}
                />
              </>
            )}
            <StepNav back={{ label: 'Back to plan', onClick: () => setStep('review') }}>
              {(implementing || status === 'implementing' || interrupted) && (
                <Button
                  variant="danger"
                  onClick={() => void runCancel()}
                  loading={cancelling}
                >
                  Cancel &amp; reset
                </Button>
              )}
              {prOpen ? (
                <Button onClick={() => setStep('summary')}>
                  <ArrowDownIcon size={16} /> View summary
                </Button>
              ) : (
                !implementing &&
                !interrupted && (
                  <span className="muted new-task-wait-note">
                    The summary opens here when the pull request is created.
                  </span>
                )
              )}
            </StepNav>
          </div>
        )}

        {step === 'summary' && (
          <div className="new-task-step-body">
            {prOpen ? (
              <section className="new-task-result">
                <div className="new-task-result-hero">
                  <PrReviewIcon size={22} />
                  <div>
                    <h3>Pull request opened</h3>
                    <p className="muted">
                      This task is now a PR task — attach the Review Board to
                      review the change.
                    </p>
                  </div>
                </div>

                <dl className="new-task-result-grid">
                  <div>
                    <dt>Pull request</dt>
                    <dd>
                      {run?.prUrl ? (
                        <a href={run.prUrl} target="_blank" rel="noreferrer">
                          {run.prUrl}
                        </a>
                      ) : (
                        `#${run?.prNumber}`
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Branch</dt>
                    <dd>
                      <code>{run?.branch}</code>
                    </dd>
                  </div>
                </dl>

                <div className="new-task-stats">
                  <div className="new-task-stat">
                    <span className="new-task-stat-num">
                      {changedFileCount ?? '—'}
                    </span>
                    <span className="new-task-stat-label">Files changed</span>
                  </div>
                  <div className="new-task-stat">
                    <span className="new-task-stat-num">
                      {agentList.length || '—'}
                    </span>
                    <span className="new-task-stat-label">Agents</span>
                  </div>
                  <div className="new-task-stat">
                    <span className="new-task-stat-num">
                      {formatDuration(
                        plannerAgents.reduce(
                          (max, agent) => Math.max(max, agent.durationMs ?? 0),
                          0,
                        ) || null,
                      )}
                    </span>
                    <span className="new-task-stat-label">Planning time</span>
                  </div>
                  <div className="new-task-stat">
                    <span className="new-task-stat-num">
                      {formatDuration(
                        teamAgents.reduce(
                          (max, agent) => Math.max(max, agent.durationMs ?? 0),
                          0,
                        ) || null,
                      )}
                    </span>
                    <span className="new-task-stat-label">Implementation time</span>
                  </div>
                  <div className="new-task-stat">
                    <span className="new-task-stat-num">
                      {formatCredits(sumCredits(agentList))}
                    </span>
                    <span className="new-task-stat-label">AI credits</span>
                  </div>
                </div>

                {agentList.length > 0 && (
                  <AgentTeamPanel
                    agents={agentList}
                    nowMs={nowMs}
                    onOpen={setOpenAgentId}
                    onOpenFile={openFile}
                  />
                )}

                {changedFiles && changedFiles.length > 0 && (
                  <div className="new-task-files">
                    <h4>
                      <FileIcon size={14} /> {changedFiles.length} file
                      {changedFiles.length === 1 ? '' : 's'} changed
                    </h4>
                    <ul>
                      {changedFiles.map((file) => (
                        <li key={file.path} className={`is-${file.changeType}`}>
                          <button
                            type="button"
                            className="new-task-file-row"
                            onClick={() => openFile(file.path)}
                            title="Show this file's diff"
                          >
                            <span
                              className="new-task-file-glyph"
                              title={file.changeType}
                            >
                              {CHANGE_GLYPH[file.changeType]}
                            </span>
                            <code>{file.path}</code>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {hasPlan && (
                  <details className="new-task-plan-recap">
                    <summary>Implemented plan</summary>
                    <div
                      className="cg-chat-md new-task-plan-md"
                      dangerouslySetInnerHTML={{ __html: planHtml }}
                    />
                  </details>
                )}

                <div className="new-task-result-actions">
                  <Button variant="secondary" onClick={startSession}>
                    New session
                  </Button>
                </div>
                {sessionNote && <p className="muted">{sessionNote}</p>}
              </section>
            ) : (
              <p className="muted">No pull request has been opened yet.</p>
            )}
            <StepNav
              back={{ label: 'Back to logs', onClick: () => setStep('implement') }}
            />
          </div>
        )}
      </div>
      {openAgent && (
        <AgentLogModal
          agent={openAgent}
          lines={agentLogs[openAgent.id] ?? []}
          nowMs={nowMs}
          onClose={() => setOpenAgentId(null)}
        />
      )}
      {openFilePath && (
        <FileDiffModal
          path={openFilePath}
          diff={fileDiff}
          loading={fileDiffLoading}
          error={fileDiffError}
          showFull={showFullFile}
          onToggleFull={() => setShowFullFile((prev) => !prev)}
          onClose={closeFile}
        />
      )}
    </div>
  );
}

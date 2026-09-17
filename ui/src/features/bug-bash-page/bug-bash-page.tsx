import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText } from '../../components/ui.js';
import {
  ActivityIcon,
  ArrowDownIcon,
  BugBashIcon,
  CheckIcon,
  ChevronIcon,
  TaskPlanSkillIcon,
} from '../../components/icons.js';
import { renderMarkdownComment } from '../../lib/markdown.js';
import { RefineChatPanel } from '../../components/refine-chat-panel.js';
import type {
  BugBashAgent,
  BugBashRun,
  BugBashScenario,
  BugBashStreamEvent,
  Feature,
} from '../../lib/types.js';

interface BugBashPageProps {
  feature: Feature;
  attachmentId: string;
}

/** The ordered wizard steps the user walks through. */
type Step = 'describe' | 'generate' | 'review' | 'run' | 'report';

const STEP_ORDER: Step[] = ['describe', 'generate', 'review', 'run', 'report'];

const STEP_META: Record<Step, { label: string; hint: string }> = {
  describe: { label: 'Describe', hint: 'Feature & setup' },
  generate: { label: 'Generate', hint: 'Live analysis logs' },
  review: { label: 'Review', hint: 'Accept scenarios' },
  run: { label: 'Run', hint: 'Live tester logs' },
  report: { label: 'Report', hint: 'Findings' },
};

/** Human-readable phase labels for the streamed activity. */
const PHASE_LABEL: Record<string, string> = {
  generating: 'Generating',
  running: 'Running',
  reporting: 'Reporting',
  done: 'Done',
};

/** Human-readable label per agent specialization. */
const AGENT_ROLE_LABEL: Record<BugBashAgent['role'], string> = {
  analyst: 'Scenario analyst',
  lead: 'Lead agent',
  tester: 'Tester',
};

/** Human-readable label + glyph per scenario verdict. */
const VERDICT_META: Record<
  BugBashScenario['status'],
  { label: string; glyph: string }
> = {
  pending: { label: 'Pending', glyph: '•' },
  pass: { label: 'Pass', glyph: '✓' },
  fail: { label: 'Fail', glyph: '✕' },
  blocked: { label: 'Blocked', glyph: '!' },
};

/**
 * The effective duration to display for an agent: a live-ticking elapsed time
 * while it is running (from its `startedAt`), or its final `durationMs` once it
 * ends. `nowMs` is the ticking clock the page supplies.
 */
function agentDuration(agent: BugBashAgent, nowMs: number): number | null {
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
function sumTokens(agents: BugBashAgent[]): number {
  return agents.reduce(
    (total, agent) =>
      total + (agent.inputTokens ?? 0) + (agent.outputTokens ?? 0),
    0,
  );
}

/** Sum AI credits across agents, yielding null when every value is unknown. */
function sumCredits(agents: BugBashAgent[]): number | null {
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
  scenariosById,
  onOpen,
}: {
  agent: BugBashAgent;
  workers: BugBashAgent[];
  nowMs: number;
  scenariosById: Record<string, BugBashScenario>;
  onOpen: (id: string) => void;
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
      {agent.scenarioIds.length > 0 && (
        <div className="new-task-agent-files">
          {agent.scenarioIds.map((id) => (
            <span key={id} className="bug-bash-scenario-chip" title="Scenario">
              {scenariosById[id]?.title ?? id}
            </span>
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
              scenariosById={scenariosById}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The hierarchical panel of agents working a run, with per-agent metrics. */
function AgentTeamPanel({
  agents,
  nowMs,
  scenariosById,
  onOpen,
}: {
  agents: BugBashAgent[];
  nowMs: number;
  scenariosById: Record<string, BugBashScenario>;
  onOpen: (id: string) => void;
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
            scenariosById={scenariosById}
            onOpen={onOpen}
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
  agent: BugBashAgent;
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

/** One entry in the run activity log, tagged with its agent. */
interface RunLogEntry {
  line: string;
  agentId?: string;
}

/**
 * The run activity log. Each line is tagged with the sub-agent that emitted it
 * (resolved live from the `agents` map) so the user can see which tester is
 * doing what.
 */
function RunActivityLog({
  entries,
  busy,
  agents,
  title,
  emptyLabel,
}: {
  entries: RunLogEntry[];
  busy: boolean;
  agents: Record<string, BugBashAgent>;
  title: string;
  emptyLabel: string;
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
        {title}
        <span className="new-task-log-count">{entries.length}</span>
      </h3>
      <div className="new-task-log-body" ref={bodyRef}>
        {entries.length === 0 ? (
          <p className="muted new-task-log-empty">{emptyLabel}</p>
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

/** A single scenario card, used in both review (pre-run) and report (verdict). */
function ScenarioCard({ scenario }: { scenario: BugBashScenario }) {
  const verdict = VERDICT_META[scenario.status];
  return (
    <li className={`bug-bash-scenario is-${scenario.status}`}>
      <div className="bug-bash-scenario-head">
        <span className="bug-bash-verdict" title={verdict.label}>
          <span className="bug-bash-verdict-glyph">{verdict.glyph}</span>
          {verdict.label}
        </span>
        <strong>{scenario.title}</strong>
      </div>
      <dl className="bug-bash-scenario-body">
        {scenario.input && (
          <div>
            <dt>Input</dt>
            <dd>{scenario.input}</dd>
          </div>
        )}
        {scenario.steps.length > 0 && (
          <div>
            <dt>Steps</dt>
            <dd>
              <ol className="bug-bash-steps">
                {scenario.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </dd>
          </div>
        )}
        {scenario.expectedOutput && (
          <div>
            <dt>Expected</dt>
            <dd>{scenario.expectedOutput}</dd>
          </div>
        )}
        {scenario.confirmation && (
          <div>
            <dt>Confirm</dt>
            <dd>{scenario.confirmation}</dd>
          </div>
        )}
        {scenario.observations && (
          <div>
            <dt>Observations</dt>
            <dd>{scenario.observations}</dd>
          </div>
        )}
      </dl>
    </li>
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
 * The Bug Bash agent page. It walks the user through hunting edge-case bugs in
 * a feature: capture the feature information + setup, stream the analyst
 * metasession's live logs while it generates reviewable test scenarios, present
 * them for acceptance, then run them across a team of parallel tester
 * sub-agents and compile a findings report. Bug Bash only reads the repo — it
 * never edits code or opens a pull request.
 */
export function BugBashPage({ feature, attachmentId }: BugBashPageProps) {
  const api = useApi();
  const [run, setRun] = useState<BugBashRun | null>(null);
  const [featureInfo, setFeatureInfo] = useState('');
  const [setupInfo, setSetupInfo] = useState('');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [generateLog, setGenerateLog] = useState<RunLogEntry[]>([]);
  const [runLog, setRunLog] = useState<RunLogEntry[]>([]);
  const [agents, setAgents] = useState<Record<string, BugBashAgent>>({});
  const [agentLogs, setAgentLogs] = useState<Record<string, string[]>>({});
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [phase, setPhase] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('describe');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reconnectedRef = useRef(false);
  const prevStatusRef = useRef<string | undefined>(undefined);

  const hydrate = useCallback((next: BugBashRun | null) => {
    setRun(next);
    if (next) {
      setFeatureInfo(next.featureInfo);
      setSetupInfo(next.setupInfo);
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
  // so the team panel and its per-agent log popups stay live.
  const applyAgentEvent = useCallback((event: BugBashStreamEvent) => {
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

  // Return the wizard to a clean state after a cancel-and-reset. Scenarios are
  // preserved on the backend (reset keeps them) so we re-hydrate from the run.
  const resetLive = useCallback(() => {
    setGenerating(false);
    setRunning(false);
    setPhase(null);
    setRunLog([]);
    setAgentLogs({});
    setOpenAgentId(null);
    reconnectedRef.current = false;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getBugBash(feature.id, attachmentId)
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

  // Reconnect to a pass that is still in flight on the backend (generating or
  // running) so returning to this window resumes the live logs instead of
  // showing a frozen form.
  useEffect(() => {
    if (loading || reconnectedRef.current) return;
    const status = run?.status;
    if (status !== 'generating' && status !== 'running') return;
    reconnectedRef.current = true;
    const isGenerate = status === 'generating';
    const controller = new AbortController();
    if (isGenerate) {
      setGenerating(true);
      setGenerateLog([]);
    } else {
      setRunning(true);
      setRunLog([]);
    }
    setAgentLogs({});
    api
      .streamBugBash(
        feature.id,
        attachmentId,
        (event: BugBashStreamEvent) => {
          applyAgentEvent(event);
          if (event.type === 'agent') {
            return;
          } else if (event.type === 'activity') {
            const label = PHASE_LABEL[event.phase] ?? event.phase;
            setPhase(event.phase);
            const entry = { line: `${label}: ${event.line}`, agentId: event.agentId };
            if (isGenerate) setGenerateLog((prev) => [...prev, entry]);
            else setRunLog((prev) => [...prev, entry]);
          } else if (event.type === 'done') {
            hydrate(event.run);
          } else if (event.type === 'cancelled') {
            resetLive();
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
        if (isGenerate) setGenerating(false);
        else {
          setRunning(false);
          setPhase(null);
        }
      });
    return () => controller.abort();
  }, [api, feature.id, attachmentId, hydrate, loading, run?.status, resetLive, applyAgentEvent]);

  // Drive the wizard from run-status transitions.
  useEffect(() => {
    if (loading) return;
    const prev = prevStatusRef.current;
    const status = run?.status;
    if (status === prev) return;
    prevStatusRef.current = status;
    if (status === 'generating') setStep('generate');
    else if (status === 'generated') setStep('review');
    else if (status === 'running') setStep('run');
    else if (status === 'reported') setStep('report');
    else if (status === 'failed' && (run?.scenarios.length ?? 0) > 0)
      setStep('run');
  }, [loading, run?.status, run?.scenarios.length]);

  // Tick a 1s clock while any agent is actively running so the per-agent and
  // team elapsed timers update live.
  useEffect(() => {
    const anyRunning = Object.values(agents).some(
      (agent) => agent.status === 'running',
    );
    if (!anyRunning) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [agents]);

  const runGenerate = useCallback(async () => {
    setError(null);
    setGenerating(true);
    setGenerateLog([]);
    setAgents({});
    setAgentLogs({});
    setStep('generate');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.saveBugBashInputs(feature.id, attachmentId, {
        featureInfo,
        setupInfo,
      });
      await api.generateBugBash(
        feature.id,
        attachmentId,
        (event: BugBashStreamEvent) => {
          applyAgentEvent(event);
          if (event.type === 'agent') {
            return;
          } else if (event.type === 'activity') {
            setPhase(event.phase);
            setGenerateLog((prev) => [
              ...prev,
              { line: event.line, agentId: event.agentId },
            ]);
          } else if (event.type === 'done') {
            hydrate(event.run);
            if (event.run.error) setError(event.run.error);
          } else if (event.type === 'cancelled') {
            resetLive();
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
      setGenerating(false);
    }
  }, [api, feature.id, attachmentId, featureInfo, setupInfo, hydrate, resetLive, applyAgentEvent]);

  const runBash = useCallback(async () => {
    setError(null);
    setRunLog([]);
    setAgentLogs({});
    setPhase('running');
    setRunning(true);
    setStep('run');
    // Keep the analyst snapshot but drop stale tester agents from a prior run.
    setAgents((prev) => {
      const kept: Record<string, BugBashAgent> = {};
      for (const agent of Object.values(prev)) {
        if (agent.role === 'analyst') kept[agent.id] = agent;
      }
      return kept;
    });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.runBugBash(
        feature.id,
        attachmentId,
        (event: BugBashStreamEvent) => {
          applyAgentEvent(event);
          if (event.type === 'agent') {
            return;
          } else if (event.type === 'activity') {
            const label = PHASE_LABEL[event.phase] ?? event.phase;
            setPhase(event.phase);
            setRunLog((prev) => [
              ...prev,
              { line: `${label}: ${event.line}`, agentId: event.agentId },
            ]);
          } else if (event.type === 'done') {
            setPhase(null);
            hydrate(event.run);
          } else if (event.type === 'cancelled') {
            resetLive();
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
      setRunning(false);
      setPhase(null);
    }
  }, [api, feature.id, attachmentId, hydrate, resetLive, applyAgentEvent]);

  // Cancel-and-reset the in-flight pass: stop the local stream at once, ask the
  // backend to abort the metasession (terminating any attached agent process)
  // and reset the run, then re-hydrate. Scenarios are preserved so the user can
  // re-run without regenerating.
  const runCancel = useCallback(async () => {
    setCancelling(true);
    setError(null);
    try {
      abortRef.current?.abort();
      const res = await api.cancelBugBash(feature.id, attachmentId);
      resetLive();
      hydrate(res.run);
      setStep(res.run && res.run.scenarios.length > 0 ? 'review' : 'describe');
    } catch (err: unknown) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setCancelling(false);
    }
  }, [api, feature.id, attachmentId, hydrate, resetLive]);

  const reportHtml = useMemo(
    () => (run?.report ? renderMarkdownComment(run.report) : ''),
    [run?.report],
  );

  const agentList = useMemo(() => Object.values(agents), [agents]);
  const analystAgents = useMemo(
    () => agentList.filter((agent) => agent.role === 'analyst'),
    [agentList],
  );
  const teamAgents = useMemo(
    () => agentList.filter((agent) => agent.role !== 'analyst'),
    [agentList],
  );
  const scenarios = run?.scenarios ?? [];
  const scenariosById = useMemo(() => {
    const map: Record<string, BugBashScenario> = {};
    for (const scenario of scenarios) map[scenario.id] = scenario;
    return map;
  }, [scenarios]);
  const openAgent = openAgentId ? agents[openAgentId] : undefined;

  if (loading) {
    return <div className="agent-page">Loading…</div>;
  }

  const status = run?.status;
  const hasScenarios = scenarios.length > 0;
  const reported = status === 'reported';
  const scenariosReady = status === 'generated';
  // A run interrupted mid-bash (still marked running) or one that failed after
  // scenarios existed can be resumed from the Run step.
  const resumable =
    (status === 'running' || (status === 'failed' && hasScenarios)) &&
    hasScenarios;
  const interrupted = resumable && !running;
  const canGenerate = featureInfo.trim().length > 0;
  const locked = running || status === 'running';

  // Which steps the user may open.
  const reachable = new Set<Step>(['describe']);
  if (generating || generateLog.length > 0 || hasScenarios || reported)
    reachable.add('generate');
  if (hasScenarios || reported) reachable.add('review');
  if (running || runLog.length > 0 || interrupted || reported)
    reachable.add('run');
  if (reported) reachable.add('report');

  const statusMessage = generating
    ? 'The analyst is reading the feature and repository to draft scenarios…'
    : running
      ? `${PHASE_LABEL[phase ?? 'running'] ?? 'Running'} the scenarios across the tester team…`
      : null;

  const StatusBanner = statusMessage ? (
    <div className="new-task-status" role="status" aria-live="polite">
      <span className="new-task-spinner" aria-hidden="true" />
      <span>{statusMessage}</span>
    </div>
  ) : null;

  const passCount = scenarios.filter((s) => s.status === 'pass').length;
  const failCount = scenarios.filter((s) => s.status === 'fail').length;
  const blockedCount = scenarios.filter((s) => s.status === 'blocked').length;

  return (
    <div className="agent-page new-task-page bug-bash-page">
      <header className="agent-page-header">
        <BugBashIcon size={20} />
        <div>
          <h2>Bug Bash</h2>
          <p className="muted">
            Hunt edge-case bugs in <strong>{feature.name}</strong> — the agent
            generates test scenarios for your review, then runs them across a
            team of testers and reports what breaks.
          </p>
        </div>
      </header>

      <Stepper current={step} reachable={reachable} onSelect={setStep} />

      <ErrorText error={error} />

      <div className="new-task-step-panel">
        {step === 'describe' && (
          <section className="new-task-inputs">
            <label>
              <span>Feature information</span>
              <textarea
                rows={4}
                value={featureInfo}
                disabled={locked || generating}
                placeholder="Describe the feature to bug-bash: what it does, its inputs and outputs, and the behaviour that matters."
                onChange={(e) => setFeatureInfo(e.target.value)}
              />
            </label>
            <label>
              <span>Setup information (optional)</span>
              <textarea
                rows={4}
                value={setupInfo}
                disabled={locked || generating}
                placeholder="Links to docs or sample data, environment/config details, and any instructions the testers need to exercise the feature."
                onChange={(e) => setSetupInfo(e.target.value)}
              />
            </label>
            <StepNav>
              {!locked && (
                <Button
                  onClick={() => void runGenerate()}
                  loading={generating}
                  disabled={!canGenerate}
                >
                  {hasScenarios ? 'Regenerate scenarios' : 'Generate scenarios'}
                </Button>
              )}
              {reachable.has('generate') && !generating && (
                <Button variant="secondary" onClick={() => setStep('generate')}>
                  View analysis logs
                </Button>
              )}
            </StepNav>
          </section>
        )}

        {step === 'generate' && (
          <div className="new-task-step-body">
            {StatusBanner}
            <AgentTeamPanel
              agents={analystAgents}
              nowMs={nowMs}
              scenariosById={scenariosById}
              onOpen={setOpenAgentId}
            />
            <RunActivityLog
              title="Analysis activity"
              entries={generateLog}
              busy={generating}
              agents={agents}
              emptyLabel="Waiting for the analyst…"
            />
            <StepNav back={{ label: 'Back', onClick: () => setStep('describe') }}>
              {(generating || status === 'generating') && (
                <Button
                  variant="danger"
                  onClick={() => void runCancel()}
                  loading={cancelling}
                >
                  Cancel &amp; reset
                </Button>
              )}
              {hasScenarios ? (
                <Button onClick={() => setStep('review')}>
                  <ArrowDownIcon size={16} /> Review scenarios
                </Button>
              ) : (
                <span className="muted new-task-wait-note">
                  The scenarios open here automatically when they're ready.
                </span>
              )}
            </StepNav>
          </div>
        )}

        {step === 'review' && (
          <div className="new-task-step-body">
            {hasScenarios ? (
              <section className="new-task-plan">
                <div className="new-task-plan-head">
                  <h3>
                    <TaskPlanSkillIcon size={16} /> Proposed scenarios
                    <span className="new-task-log-count">
                      {scenarios.length}
                    </span>
                  </h3>
                </div>
                {scenariosReady && (
                  <p className="muted new-task-accept-note">
                    Accepting dispatches these scenarios to a team of tester
                    sub-agents that exercise the feature in parallel and report
                    what breaks. Bug Bash only reads the repository.
                  </p>
                )}
                <ul className="bug-bash-scenarios">
                  {scenarios.map((scenario) => (
                    <ScenarioCard key={scenario.id} scenario={scenario} />
                  ))}
                </ul>
                {scenariosReady && (
                  <RefineChatPanel<BugBashRun>
                    title="Refine with the analyst"
                    context="Challenge or edit these scenarios in plain language before you run them."
                    hint="e.g. “Drop the duplicate login checks and add one for an expired session token.” The analyst reads the repo and rewrites the scenarios when you ask."
                    placeholder="Ask the analyst to change the scenarios…"
                    onSend={(history, message) =>
                      api.refineBugBash(
                        feature.id,
                        attachmentId,
                        history,
                        message,
                      )
                    }
                    onRevised={hydrate}
                  />
                )}
              </section>
            ) : (
              <p className="muted">No scenarios yet — generate them first.</p>
            )}
            <StepNav back={{ label: 'Back', onClick: () => setStep('generate') }}>
              {(scenariosReady || status === 'failed') && hasScenarios && (
                <Button onClick={() => void runBash()}>
                  <CheckIcon size={16} /> Accept &amp; run bug bash
                </Button>
              )}
              {reported && (
                <Button onClick={() => setStep('report')}>
                  <ArrowDownIcon size={16} /> View report
                </Button>
              )}
            </StepNav>
          </div>
        )}

        {step === 'run' && (
          <div className="new-task-step-body">
            {interrupted ? (
              <section className="new-task-plan-ready new-task-interrupted">
                <div className="new-task-plan-ready-head">
                  <BugBashIcon size={18} />
                  <div>
                    <strong>
                      {status === 'failed'
                        ? 'The previous bug bash did not finish'
                        : 'The bug bash was interrupted'}
                    </strong>
                    <p className="muted">
                      {status === 'failed'
                        ? 'The last run stopped before compiling a report'
                        : "A previous run didn't finish (the app likely closed or reloaded mid-run)"}
                      . The accepted scenarios are intact — re-run to test them
                      again.
                    </p>
                    {status === 'failed' && run?.error && (
                      <p className="new-task-interrupted-reason">
                        Last error: {run.error}
                      </p>
                    )}
                  </div>
                </div>
                <Button onClick={() => void runBash()} loading={running}>
                  <CheckIcon size={16} /> Re-run bug bash
                </Button>
              </section>
            ) : (
              <>
                {StatusBanner}
                <AgentTeamPanel
                  agents={teamAgents}
                  nowMs={nowMs}
                  scenariosById={scenariosById}
                  onOpen={setOpenAgentId}
                />
                <RunActivityLog
                  title="Bug bash activity"
                  entries={runLog}
                  busy={running}
                  agents={agents}
                  emptyLabel="Waiting for the testers…"
                />
              </>
            )}
            <StepNav back={{ label: 'Back to scenarios', onClick: () => setStep('review') }}>
              {(running || status === 'running' || interrupted) && (
                <Button
                  variant="danger"
                  onClick={() => void runCancel()}
                  loading={cancelling}
                >
                  Cancel &amp; reset
                </Button>
              )}
              {reported ? (
                <Button onClick={() => setStep('report')}>
                  <ArrowDownIcon size={16} /> View report
                </Button>
              ) : (
                !running &&
                !interrupted && (
                  <span className="muted new-task-wait-note">
                    The report opens here when the bug bash finishes.
                  </span>
                )
              )}
            </StepNav>
          </div>
        )}

        {step === 'report' && (
          <div className="new-task-step-body">
            {reported ? (
              <section className="new-task-result">
                <div className="new-task-result-hero">
                  <BugBashIcon size={22} />
                  <div>
                    <h3>Bug bash complete</h3>
                    <p className="muted">
                      {scenarios.length} scenario
                      {scenarios.length === 1 ? '' : 's'} tested across{' '}
                      {teamAgents.filter((a) => a.role === 'tester').length}{' '}
                      tester
                      {teamAgents.filter((a) => a.role === 'tester').length === 1
                        ? ''
                        : 's'}
                      .
                    </p>
                  </div>
                </div>

                <div className="new-task-stats">
                  <div className="new-task-stat">
                    <span className="new-task-stat-num">{passCount}</span>
                    <span className="new-task-stat-label">Passed</span>
                  </div>
                  <div className="new-task-stat">
                    <span className="new-task-stat-num">{failCount}</span>
                    <span className="new-task-stat-label">Failed</span>
                  </div>
                  <div className="new-task-stat">
                    <span className="new-task-stat-num">{blockedCount}</span>
                    <span className="new-task-stat-label">Blocked</span>
                  </div>
                  <div className="new-task-stat">
                    <span className="new-task-stat-num">
                      {agentList.length || '—'}
                    </span>
                    <span className="new-task-stat-label">Agents</span>
                  </div>
                  <div className="new-task-stat">
                    <span className="new-task-stat-num">
                      {formatCredits(sumCredits(agentList))}
                    </span>
                    <span className="new-task-stat-label">AI credits</span>
                  </div>
                </div>

                {run?.report && (
                  <div
                    className="cg-chat-md new-task-plan-md bug-bash-report"
                    dangerouslySetInnerHTML={{ __html: reportHtml }}
                  />
                )}

                {agentList.length > 0 && (
                  <AgentTeamPanel
                    agents={agentList}
                    nowMs={nowMs}
                    scenariosById={scenariosById}
                    onOpen={setOpenAgentId}
                  />
                )}

                <details className="new-task-plan-recap">
                  <summary>Scenario verdicts</summary>
                  <ul className="bug-bash-scenarios">
                    {scenarios.map((scenario) => (
                      <ScenarioCard key={scenario.id} scenario={scenario} />
                    ))}
                  </ul>
                </details>
              </section>
            ) : (
              <p className="muted">No report yet — run the bug bash first.</p>
            )}
            <StepNav
              back={{ label: 'Back to logs', onClick: () => setStep('run') }}
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
    </div>
  );
}

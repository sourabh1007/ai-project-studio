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
  ExportIcon,
  FilesIcon,
  TaskPlanSkillIcon,
  WarningIcon,
} from '../../components/icons.js';
import { renderMarkdownComment } from '../../lib/markdown.js';
import { RefineChatPanel } from '../../components/refine-chat-panel.js';
import type {
  BugBashAgent,
  BugBashBlockedReason,
  BugBashPrerequisite,
  BugBashRun,
  BugBashScenario,
  BugBashScenarioStatus,
  BugBashStreamEvent,
  Feature,
} from '../../lib/types.js';

interface BugBashPageProps {
  feature: Feature;
  attachmentId: string;
}

/** The ordered wizard steps the user walks through. */
type Step = 'describe' | 'prepare' | 'generate' | 'review' | 'run' | 'report';

type ScenarioLiveStatus = 'running' | BugBashScenarioStatus;

const STEP_ORDER: Step[] = [
  'describe',
  'prepare',
  'generate',
  'review',
  'run',
  'report',
];

const STEP_META: Record<Step, { label: string; hint: string }> = {
  describe: { label: 'Describe', hint: 'Feature & setup' },
  prepare: { label: 'Prepare', hint: 'Required info' },
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
  auditor: 'Evidence auditor',
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

/** Human-readable label per blocked-reason category. */
const BLOCKED_REASON_LABEL: Record<BugBashBlockedReason, string> = {
  permission: 'Needs access',
  environment: 'Environment not ready',
  tooling: 'Tooling missing',
  other: 'Could not run',
};

/**
 * Serialize the full run into a self-contained markdown report a user can
 * download: an evidence-audit summary up front, then every scenario's complete
 * record — verdict, whether it really ran, the evidence gaps the auditor found,
 * steps, expected vs actual, diagnostics/logs, and the runnable repro script —
 * followed by the lead's compiled report. This is the offline artefact that
 * makes each result reproducible outside the app.
 */
function buildDetailedReportMarkdown(
  feature: string,
  scenarios: BugBashScenario[],
  report: string | null,
): string {
  const passed = scenarios.filter((s) => s.status === 'pass').length;
  const failed = scenarios.filter((s) => s.status === 'fail').length;
  const blocked = scenarios.filter((s) => s.status === 'blocked').length;
  const ran = scenarios.filter((s) => s.ran).length;
  const flagged = scenarios.filter((s) => s.evidenceGaps.length > 0);
  const lines: Array<string | null> = [
    `# Bug Bash detailed report — ${feature}`,
    '',
    `_Generated ${new Date().toISOString()}_`,
    '',
    '## Summary',
    `- Scenarios: ${scenarios.length}`,
    `- Actually ran (with evidence): ${ran}`,
    `- Passed: ${passed} · Failed: ${failed} · Blocked: ${blocked}`,
    `- Verdicts missing evidence: ${flagged.length}`,
    '',
    '## Evidence audit',
  ];
  if (flagged.length === 0) {
    lines.push('Every pass/fail verdict is backed by output, logs, and a repro script.');
  } else {
    for (const s of flagged) {
      lines.push(`- **${s.title}** (${s.status}): missing ${s.evidenceGaps.join(', ')}`);
    }
  }
  lines.push('', '## Scenario details');
  for (const s of scenarios) {
    const steps =
      s.steps.length > 0
        ? s.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')
        : '(no steps provided)';
    lines.push(
      '',
      `### ${s.title}`,
      `- Status: ${s.status}${s.ran ? '' : ' (not verified — treated as not run)'}`,
      s.status === 'blocked' && s.blockedReason
        ? `- Blocked reason: ${BLOCKED_REASON_LABEL[s.blockedReason]}`
        : null,
      s.evidenceGaps.length > 0
        ? `- Evidence gaps: missing ${s.evidenceGaps.join(', ')}`
        : '- Evidence: complete',
      `- Input: ${s.input || '(none)'}`,
      '- Steps to replicate:',
      steps,
      `- Expected output: ${s.expectedOutput || '(unspecified)'}`,
      `- Actual output: ${s.actualOutput || '(none reported)'}`,
      `- Observations: ${s.observations || '(none reported)'}`,
      `- Diagnostics / logs: ${s.diagnostics || '(none captured)'}`,
      '- Repro script (run locally to verify):',
      s.reproScript ? `\`\`\`\n${s.reproScript}\n\`\`\`` : '(none generated)',
    );
  }
  const body = lines.filter((line): line is string => line !== null);
  if (report) {
    body.push('', '---', '', '## Compiled report', '', report);
  }
  return body.join('\n');
}

/** Trigger a client-side download of `content` as a named text file. */
function downloadTextFile(name: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

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

/**
 * The live state to paint on a scenario chip in the tester team panel.
 */
function scenarioChipState(
  scenario: BugBashScenario | undefined,
  live: ScenarioLiveStatus | undefined,
): 'done' | 'running' | 'pending' {
  if (live === 'running') return 'running';
  if (live && live !== 'pending') return 'done';
  if (scenario && (scenario.ran || scenario.status !== 'pending')) return 'done';
  return 'pending';
}

/** One agent card in the team hierarchy; click to open its live log. */
function AgentCard({
  agent,
  workers,
  nowMs,
  scenariosById,
  scenarioLive,
  onOpen,
}: {
  agent: BugBashAgent;
  workers: BugBashAgent[];
  nowMs: number;
  scenariosById: Record<string, BugBashScenario>;
  scenarioLive: Record<string, ScenarioLiveStatus>;
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
          {agent.scenarioIds.map((id) => {
            const scenario = scenariosById[id];
            const state = scenarioChipState(scenario, scenarioLive[id]);
            const label = scenario?.title ?? id;
            return (
              <span
                key={id}
                className={`bug-bash-scenario-chip is-${state}`}
                title={
                  state === 'running'
                    ? `Running: ${label}`
                    : state === 'done'
                      ? `Completed: ${label}`
                      : label
                }
              >
                {label}
              </span>
            );
          })}
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
              scenarioLive={scenarioLive}
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
  scenarioLive,
  onOpen,
}: {
  agents: BugBashAgent[];
  nowMs: number;
  scenariosById: Record<string, BugBashScenario>;
  scenarioLive: Record<string, ScenarioLiveStatus>;
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
            scenarioLive={scenarioLive}
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

/**
 * Finds the balanced JSON literal starting at `start` (an opening `{` or `[`),
 * respecting quoted strings and escapes, and returns its exact substring — or
 * null when the brackets never balance.
 */
function scanBalancedJson(text: string, start: number): string | null {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

type FieldSegment = { type: 'text'; value: string } | { type: 'json'; value: string };

/**
 * Splits a field into alternating prose and pretty-printed JSON segments so an
 * inline transaction blob renders as a readable, indented code block instead of
 * one unwrapped line.
 */
function splitFieldSegments(text: string): FieldSegment[] {
  const segments: FieldSegment[] = [];
  let cursor = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      const candidate = scanBalancedJson(text, i);
      if (candidate) {
        try {
          const pretty = JSON.stringify(JSON.parse(candidate), null, 2);
          if (i > cursor) {
            segments.push({ type: 'text', value: text.slice(cursor, i) });
          }
          segments.push({ type: 'json', value: pretty });
          i += candidate.length;
          cursor = i;
          continue;
        } catch {
          // Not valid JSON — fall through and treat as ordinary prose.
        }
      }
    }
    i += 1;
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }
  return segments;
}

/** Breaks a prose blob into individual sentences for bullet rendering. */
function splitSentences(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Recognises the technical tokens worth calling out inline — file/namespace
 * paths (with `\` or `/`), dotted or CamelCase code identifiers, and HTTP
 * status codes — so they render as coloured code chips instead of flat prose.
 */
const INLINE_TOKEN_RE =
  /([A-Za-z0-9_.]+(?:[\\/][A-Za-z0-9_.]+)+)|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+|[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*)|(\b[1-5][0-9]{2}\b)/g;

function highlightInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE_TOKEN_RE)) {
    const index = match.index ?? 0;
    const [full, path, code] = match;
    if (index > last) {
      nodes.push(text.slice(last, index));
    }
    if (path) {
      nodes.push(
        <code key={key} className="bug-bash-hl bug-bash-hl-path">
          {full}
        </code>,
      );
    } else if (code) {
      nodes.push(
        <code key={key} className="bug-bash-hl bug-bash-hl-code">
          {full}
        </code>,
      );
    } else {
      nodes.push(
        <code key={key} className={`bug-bash-hl bug-bash-hl-status s${full[0]}xx`}>
          {full}
        </code>,
      );
    }
    key += 1;
    last = index + full.length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

/**
 * Renders a scenario field as bullet points, pretty-printing any embedded JSON
 * into an indented code block along the way.
 */
function ScenarioFieldValue({ text }: { text: string }): ReactNode {
  const segments = splitFieldSegments(text);
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'json' ? (
          <pre key={index} className="bug-bash-json">
            {segment.value}
          </pre>
        ) : (
          <ul key={index} className="bug-bash-bullets">
            {splitSentences(segment.value).map((sentence, sentenceIndex) => (
              <li key={sentenceIndex}>{highlightInline(sentence)}</li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

/**
 * A copy-to-clipboard button that briefly confirms the copy. Used for the
 * per-scenario repro script so a developer can grab the runnable code in one
 * click.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => setCopied(false),
        );
      }}
    >
      <FilesIcon size={14} />
      {copied ? 'Copied' : label}
    </Button>
  );
}

/**
 * A per-scenario popup with two views. The **detail** view is the reproducible
 * record — input, steps, expected vs actual, observations. The **run** view,
 * opened from the top-right button, shows how the IDE actually ran it: the
 * responsible tester's metrics, the raw diagnostics/telemetry it captured
 * (actual code, ids, errors), and the tester's full activity log.
 */
function ScenarioDetailModal({
  scenario,
  tester,
  lines,
  nowMs,
  onClose,
}: {
  scenario: BugBashScenario;
  tester: BugBashAgent | undefined;
  lines: string[];
  nowMs: number;
  onClose: () => void;
}) {
  const [view, setView] = useState<'detail' | 'run'>('detail');
  const verdict = VERDICT_META[scenario.status];
  const reasonLabel = scenario.blockedReason
    ? BLOCKED_REASON_LABEL[scenario.blockedReason]
    : null;
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
        aria-label={`${scenario.title} ${view === 'run' ? 'run detail' : 'detail'}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="new-task-modal-head">
          <div>
            <span className="new-task-agent-role">
              {view === 'run' ? 'Logs' : 'Scenario'}
            </span>
            <strong title={scenario.title}>{scenario.title}</strong>
          </div>
          <div className="bug-bash-modal-actions">
            {view === 'detail' ? (
              <Button variant="secondary" onClick={() => setView('run')}>
                <ActivityIcon size={15} />
                Logs
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setView('detail')}>
                <span className="new-task-chevron-back" aria-hidden="true">
                  <ChevronIcon size={16} />
                </span>
                Back to scenario
              </Button>
            )}
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
        <div className={`new-task-modal-metrics is-${scenario.status}`}>
          <span className="bug-bash-metric bug-bash-metric-verdict">
            <span className="bug-bash-verdict-glyph" aria-hidden="true">
              {verdict.glyph}
            </span>
            {verdict.label}
            {reasonLabel ? ` · ${reasonLabel}` : ''}
          </span>
          <span
            className={`bug-bash-metric bug-bash-metric-ran ${
              scenario.ran
                ? 'did-run'
                : scenario.status === 'blocked'
                  ? 'not-run'
                  : 'unverified'
            }`}
          >
            <span className="bug-bash-metric-label">Ran</span>
            <span className="bug-bash-metric-value">
              {scenario.ran
                ? 'Yes'
                : scenario.status === 'blocked'
                  ? 'No'
                  : 'Not verified'}
            </span>
          </span>
          <span className="bug-bash-metric">
            <span className="bug-bash-metric-label">Tester</span>
            <span className="bug-bash-metric-value">
              {tester ? tester.title : 'Unassigned'}
            </span>
          </span>
          {tester && (
            <>
              <span className="bug-bash-metric">
                <span className="bug-bash-metric-label">Time</span>
                <span className="bug-bash-metric-value">
                  {formatDuration(agentDuration(tester, nowMs))}
                </span>
              </span>
              <span className="bug-bash-metric">
                <span className="bug-bash-metric-label">AIC</span>
                <span className="bug-bash-metric-value">
                  {formatCredits(tester.credits)}
                </span>
              </span>
              <span className="bug-bash-metric">
                <span className="bug-bash-metric-label">Tokens</span>
                <span className="bug-bash-metric-value">
                  {(tester.inputTokens ?? 0).toLocaleString()} in /{' '}
                  {(tester.outputTokens ?? 0).toLocaleString()} out
                </span>
              </span>
            </>
          )}
        </div>
        {scenario.evidenceGaps.length > 0 && (
          <div className="bug-bash-evidence-warning" role="alert">
            <WarningIcon size={15} />
            <span>
              Evidence incomplete — this {scenario.status} verdict is missing{' '}
              <strong>{scenario.evidenceGaps.join(', ')}</strong>. Treat it as
              unproven until a developer can reproduce it.
            </span>
          </div>
        )}
        {view === 'detail' ? (
          <div className="new-task-modal-log bug-bash-diagnostics">
            <dl className="bug-bash-scenario-body">
              {scenario.input && (
                <div>
                  <dt>Input</dt>
                  <dd>
                    <ScenarioFieldValue text={scenario.input} />
                  </dd>
                </div>
              )}
              <div>
                <dt>Steps to replicate</dt>
                <dd>
                  {scenario.steps.length > 0 ? (
                    <ol className="bug-bash-steps">
                      {scenario.steps.map((s, i) => (
                        <li key={i}>{highlightInline(s)}</li>
                      ))}
                    </ol>
                  ) : (
                    '(no steps provided)'
                  )}
                </dd>
              </div>
              <div>
                <dt>Expected</dt>
                <dd>
                  {scenario.expectedOutput ? (
                    <ScenarioFieldValue text={scenario.expectedOutput} />
                  ) : (
                    '(unspecified)'
                  )}
                </dd>
              </div>
              <div>
                <dt>Actual</dt>
                <dd>
                  {scenario.actualOutput ? (
                    <ScenarioFieldValue text={scenario.actualOutput} />
                  ) : (
                    '(none reported)'
                  )}
                </dd>
              </div>
              <div>
                <dt>Observations</dt>
                <dd>
                  {scenario.observations ? (
                    <ScenarioFieldValue text={scenario.observations} />
                  ) : (
                    '(none reported)'
                  )}
                </dd>
              </div>
              <div>
                <dt>
                  <span className="bug-bash-repro-head">
                    Repro script — run it locally to verify
                    {scenario.reproScript && (
                      <CopyButton text={scenario.reproScript} label="Copy" />
                    )}
                  </span>
                </dt>
                <dd>
                  {scenario.reproScript ? (
                    <pre className="bug-bash-repro">{scenario.reproScript}</pre>
                  ) : (
                    <span className="muted">
                      No repro script was generated for this scenario — there is
                      no runnable proof a developer can replay.
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          </div>
        ) : (
          <div className="new-task-modal-log bug-bash-diagnostics">
            <div className="bug-bash-diagnostics-raw">
              <dt>Diagnostics / telemetry — actual code, ids &amp; errors</dt>
              {scenario.diagnostics ? (
                <ScenarioFieldValue text={scenario.diagnostics} />
              ) : (
                <p className="muted new-task-log-empty">
                  No diagnostics were captured for this scenario.
                </p>
              )}
            </div>
            <div className="bug-bash-diagnostics-raw">
              <dt>Tester activity log</dt>
              {lines.length > 0 ? (
                <div className="bug-bash-run-log">
                  {lines.map((line, i) => (
                    <div key={i} className="new-task-log-line">
                      {highlightInline(line)}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted new-task-log-empty">
                  No activity was captured for the tester that ran this
                  scenario.
                </p>
              )}
            </div>
          </div>
        )}
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

/** A single scenario card, used in the review step before a run. */
function ScenarioCard({
  scenario,
  index,
  total,
}: {
  scenario: BugBashScenario;
  index: number;
  total: number;
}) {
  const verdict = VERDICT_META[scenario.status];
  return (
    <li className={`bug-bash-scenario is-${scenario.status}`}>
      <div className="bug-bash-scenario-head">
        <span
          className="bug-bash-scenario-counter"
          title={`Scenario ${index} of ${total}`}
          aria-label={`Scenario ${index} of ${total}`}
        >
          {index}
        </span>
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
        {scenario.actualOutput && (
          <div>
            <dt>Actual</dt>
            <dd>{scenario.actualOutput}</dd>
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
  const [otherInfo, setOtherInfo] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [preparing, setPreparing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [generateLog, setGenerateLog] = useState<RunLogEntry[]>([]);
  const [runLog, setRunLog] = useState<RunLogEntry[]>([]);
  const [agents, setAgents] = useState<Record<string, BugBashAgent>>({});
  const [agentLogs, setAgentLogs] = useState<Record<string, string[]>>({});
  const [scenarioLive, setScenarioLive] = useState<Record<string, ScenarioLiveStatus>>({});
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [openScenarioId, setOpenScenarioId] = useState<string | null>(null);
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
      setOtherInfo(next.otherInfo);
      setAnswers((prev) => {
        const merged = { ...prev };
        for (const prereq of next.prerequisites) merged[prereq.id] = prereq.answer;
        return merged;
      });
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
    } else if (event.type === 'scenario') {
      setScenarioLive((prev) => ({
        ...prev,
        [event.progress.id]: event.progress.status,
      }));
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
    setScenarioLive({});
    setOpenAgentId(null);
    setOpenScenarioId(null);
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
          if (event.type === 'agent' || event.type === 'scenario') {
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

  // Whether any agent is currently running. Derived as a boolean so the tick
  // effect below only re-subscribes when the running state actually flips —
  // not on every streamed agent snapshot.
  const anyAgentRunning = useMemo(
    () => Object.values(agents).some((agent) => agent.status === 'running'),
    [agents],
  );

  // Tick a 1s clock while any agent is actively running so the per-agent and
  // team elapsed timers update live. Depending on the boolean (not the whole
  // `agents` map) keeps the interval alive across streamed events instead of
  // tearing it down and recreating it before it can fire.
  useEffect(() => {
    if (!anyAgentRunning) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [anyAgentRunning]);

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
      await api.generateBugBash(
        feature.id,
        attachmentId,
        (event: BugBashStreamEvent) => {
          applyAgentEvent(event);
          if (event.type === 'agent' || event.type === 'scenario') {
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
  }, [api, feature.id, attachmentId, hydrate, resetLive, applyAgentEvent]);

  // Ask the analyst to inspect the feature and surface the prerequisite
  // questions the user should answer before scenarios are generated.
  const runPrerequisites = useCallback(async () => {
    setError(null);
    setPreparing(true);
    try {
      const updated = await api.generateBugBashPrerequisites(
        feature.id,
        attachmentId,
      );
      hydrate(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreparing(false);
    }
  }, [api, feature.id, attachmentId, hydrate]);

  // Persist the describe-step inputs, open the Prepare step, and immediately
  // start identifying the information the bug bash still needs — the user does
  // not have to press a second button.
  const goPrepare = useCallback(async () => {
    setError(null);
    try {
      const updated = await api.saveBugBashInputs(feature.id, attachmentId, {
        featureInfo,
        setupInfo,
        otherInfo,
      });
      hydrate(updated);
      setStep('prepare');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    await runPrerequisites();
  }, [
    api,
    feature.id,
    attachmentId,
    featureInfo,
    setupInfo,
    otherInfo,
    hydrate,
    runPrerequisites,
  ]);

  // Save the answers to the generated prerequisite questions, then generate the
  // scenarios (the answers feed into the analyst's context server-side).
  const generateFromPrepare = useCallback(
    async (prereqs: BugBashPrerequisite[]) => {
      if (prereqs.length > 0) {
        try {
          const updated = await api.saveBugBashPrerequisiteAnswers(
            feature.id,
            attachmentId,
            prereqs.map((p) => ({ id: p.id, answer: answers[p.id] ?? '' })),
          );
          hydrate(updated);
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      await runGenerate();
    },
    [api, feature.id, attachmentId, answers, hydrate, runGenerate],
  );

  const runBash = useCallback(async () => {
    setError(null);
    setRunLog([]);
    setAgentLogs({});
    setScenarioLive({});
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
          if (event.type === 'agent' || event.type === 'scenario') {
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
  const openScenario = openScenarioId ? scenariosById[openScenarioId] : undefined;

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
  const prerequisites = run?.prerequisites ?? [];

  // Which steps the user may open.
  const reachable = new Set<Step>(['describe']);
  if (canGenerate || prerequisites.length > 0 || hasScenarios || reported)
    reachable.add('prepare');
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
  const blockedScenarios = scenarios.filter((s) => s.status === 'blocked');
  const needsAccessCount = blockedScenarios.filter(
    (s) => s.blockedReason === 'permission',
  ).length;
  const blockedCount = blockedScenarios.length - needsAccessCount;

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
            <label>
              <span>Other information (optional)</span>
              <textarea
                rows={4}
                value={otherInfo}
                disabled={locked || generating}
                placeholder="Anything else worth knowing: known limitations, accounts or test data to use, edge cases you care about, or areas to avoid."
                onChange={(e) => setOtherInfo(e.target.value)}
              />
            </label>
            <StepNav>
              {!locked && (
                <Button
                  onClick={() => void goPrepare()}
                  disabled={!canGenerate}
                >
                  Continue
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

        {step === 'prepare' && (
          <section className="new-task-inputs bug-bash-prepare">
            <div className="bug-bash-prepare-intro">
              <p className="muted">
                Before drafting scenarios, the analyst inspects the feature to
                work out what it still needs to know. Answer the questions below
                so the testers have everything they need — answers are optional
                but make the scenarios sharper.
              </p>
            </div>

            {preparing ? (
              <div className="bug-bash-prepare-loading" role="status" aria-live="polite">
                <div className="bug-bash-prepare-loading-head">
                  <span className="bug-bash-prepare-orb" aria-hidden="true" />
                  <span>Analysing the feature to work out what it needs…</span>
                </div>
                <div className="bug-bash-prereq-skeletons" aria-hidden="true">
                  {[0, 1, 2].map((i) => (
                    <div className="bug-bash-prereq-skeleton" key={i}>
                      <span className="skeleton-line skeleton-line-q" />
                      <span className="skeleton-line skeleton-line-d" />
                      <div className="skeleton-chips">
                        <span className="skeleton-chip" />
                        <span className="skeleton-chip" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : prerequisites.length === 0 ? (
              <div className="bug-bash-prepare-empty">
                <p>
                  No prerequisite questions yet. Identify what information the
                  bug bash needs to run reliably.
                </p>
                <Button
                  onClick={() => void runPrerequisites()}
                  disabled={!canGenerate}
                >
                  Identify required information
                </Button>
              </div>
            ) : (
              <div className="bug-bash-prereq-list">
                {prerequisites.map((prereq) => (
                  <label
                    key={prereq.id}
                    className="bug-bash-prereq bug-bash-prereq-enter"
                  >
                    <span className="bug-bash-prereq-question">
                      {prereq.question}
                    </span>
                    {prereq.detail && (
                      <span className="bug-bash-prereq-detail muted">
                        {prereq.detail}
                      </span>
                    )}
                    {prereq.options.length > 0 && (
                      <div
                        className="bug-bash-prereq-options"
                        role="group"
                        aria-label="Suggested answers"
                      >
                        {prereq.options.map((option) => (
                          <button
                            key={option}
                            type="button"
                            className={
                              (answers[prereq.id] ?? '') === option
                                ? 'bug-bash-prereq-option is-selected'
                                : 'bug-bash-prereq-option'
                            }
                            disabled={locked || generating}
                            aria-pressed={(answers[prereq.id] ?? '') === option}
                            onClick={() =>
                              setAnswers((prev) => ({
                                ...prev,
                                [prereq.id]:
                                  (prev[prereq.id] ?? '') === option
                                    ? ''
                                    : option,
                              }))
                            }
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    )}
                    <textarea
                      rows={2}
                      value={answers[prereq.id] ?? ''}
                      disabled={locked || generating}
                      placeholder={
                        prereq.options.length > 0
                          ? 'Pick an option above or type your answer (optional)'
                          : 'Your answer (optional)'
                      }
                      onChange={(e) =>
                        setAnswers((prev) => ({
                          ...prev,
                          [prereq.id]: e.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            )}

            <StepNav back={{ label: 'Back', onClick: () => setStep('describe') }}>
              {prerequisites.length > 0 && !generating && (
                <Button
                  variant="secondary"
                  onClick={() => void runPrerequisites()}
                  loading={preparing}
                >
                  Re-identify
                </Button>
              )}
              {!locked && (
                <Button
                  onClick={() => void generateFromPrepare(prerequisites)}
                  loading={generating}
                  disabled={!canGenerate}
                >
                  {hasScenarios ? 'Regenerate scenarios' : 'Generate scenarios'}
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
              scenarioLive={scenarioLive}
              onOpen={setOpenAgentId}
            />
            <RunActivityLog
              title="Analysis activity"
              entries={generateLog}
              busy={generating}
              agents={agents}
              emptyLabel="Waiting for the analyst…"
            />
            <StepNav back={{ label: 'Back', onClick: () => setStep('prepare') }}>
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
                  {scenarios.map((scenario, i) => (
                    <ScenarioCard
                      key={scenario.id}
                      scenario={scenario}
                      index={i + 1}
                      total={scenarios.length}
                    />
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
                  scenarioLive={scenarioLive}
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
              <section className="new-task-result bug-bash-report">
                {/* Section 1 — every scenario covered, click to drill in. */}
                <div className="bug-bash-report-section">
                  <div className="bug-bash-section-head">
                    <div className="bug-bash-section-head-text">
                      <h3>Scenarios covered</h3>
                      <span className="muted">
                        {scenarios.length} scenario
                        {scenarios.length === 1 ? '' : 's'} · click any to see
                        the full detail and how the IDE ran it
                      </span>
                    </div>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        downloadTextFile(
                          `bug-bash-${feature.name}-report.md`.replace(
                            /[^a-z0-9._-]+/gi,
                            '-',
                          ),
                          buildDetailedReportMarkdown(
                            feature.name,
                            scenarios,
                            run?.report ?? null,
                          ),
                        )
                      }
                    >
                      <ExportIcon size={15} />
                      Download detailed report
                    </Button>
                  </div>
                  <ul className="bug-bash-scenario-list">
                    {scenarios.map((scenario, i) => {
                      const verdict = VERDICT_META[scenario.status];
                      const reasonLabel = scenario.blockedReason
                        ? BLOCKED_REASON_LABEL[scenario.blockedReason]
                        : null;
                      return (
                        <li key={scenario.id}>
                          <button
                            type="button"
                            className={`bug-bash-scenario-row is-${scenario.status}`}
                            onClick={() => setOpenScenarioId(scenario.id)}
                          >
                            <span
                              className="bug-bash-scenario-counter"
                              title={`Scenario ${i + 1} of ${scenarios.length}`}
                              aria-label={`Scenario ${i + 1} of ${scenarios.length}`}
                            >
                              {i + 1}
                            </span>
                            <span
                              className="bug-bash-verdict"
                              title={verdict.label}
                            >
                              <span className="bug-bash-verdict-glyph">
                                {verdict.glyph}
                              </span>
                              {verdict.label}
                            </span>
                            <span
                              className="bug-bash-scenario-row-title"
                              title={scenario.title}
                            >
                              {scenario.title}
                            </span>
                            <span
                              className={`bug-bash-ran-flag ${
                                scenario.ran
                                  ? 'did-run'
                                  : scenario.status === 'blocked'
                                    ? 'not-run'
                                    : 'unverified'
                              }`}
                              title={
                                scenario.ran
                                  ? 'Executed with evidence (actual output or diagnostics captured)'
                                  : scenario.status === 'blocked'
                                    ? 'Not executed'
                                    : `Marked ${scenario.status} but captured no actual output or diagnostics — treated as not really run`
                              }
                            >
                              {scenario.ran
                                ? 'Ran'
                                : scenario.status === 'blocked'
                                  ? 'Not run'
                                  : 'Not verified'}
                            </span>
                            {scenario.evidenceGaps.length > 0 && (
                              <span
                                className="bug-bash-evidence-flag"
                                title={`Missing ${scenario.evidenceGaps.join(
                                  ', ',
                                )} — verdict is not fully evidenced`}
                              >
                                <WarningIcon size={12} />
                                No proof
                              </span>
                            )}
                            {scenario.status === 'blocked' && reasonLabel && (
                              <span
                                className={`bug-bash-block-reason reason-${scenario.blockedReason}`}
                              >
                                {reasonLabel}
                              </span>
                            )}
                            <span
                              className="bug-bash-scenario-row-chevron"
                              aria-hidden="true"
                            >
                              <ChevronIcon size={16} />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {/* Section 2 — summary and supporting information. */}
                <div className="bug-bash-report-section">
                  <div className="bug-bash-section-head">
                    <h3>Summary &amp; details</h3>
                    <span className="muted">
                      {scenarios.length} scenario
                      {scenarios.length === 1 ? '' : 's'} tested across{' '}
                      {teamAgents.filter((a) => a.role === 'tester').length}{' '}
                      tester
                      {teamAgents.filter((a) => a.role === 'tester').length === 1
                        ? ''
                        : 's'}
                      .
                    </span>
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
                        {needsAccessCount}
                      </span>
                      <span className="new-task-stat-label">Needs access</span>
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
                      className="cg-chat-md new-task-plan-md bug-bash-report-md"
                      dangerouslySetInnerHTML={{ __html: reportHtml }}
                    />
                  )}

                  {agentList.length > 0 && (
                    <AgentTeamPanel
                      agents={agentList}
                      nowMs={nowMs}
                      scenariosById={scenariosById}
                      scenarioLive={scenarioLive}
                      onOpen={setOpenAgentId}
                    />
                  )}
                </div>
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
      {openScenario && (
        <ScenarioDetailModal
          scenario={openScenario}
          tester={
            openScenario.testerId ? agents[openScenario.testerId] : undefined
          }
          lines={
            openScenario.testerId
              ? (agentLogs[openScenario.testerId] ?? [])
              : []
          }
          nowMs={nowMs}
          onClose={() => setOpenScenarioId(null)}
        />
      )}
    </div>
  );
}

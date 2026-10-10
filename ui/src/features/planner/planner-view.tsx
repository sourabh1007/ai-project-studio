import { useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { useUiPreferences } from '../../hooks/use-ui-preferences.js';
import { EmptyState, ErrorText } from '../../components/ui.js';
import {
  AiIcon,
  AiMagicIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  DownloadHtmlIcon,
  DownloadMarkdownIcon,
  ExportIcon,
  PencilIcon,
  PlannerIcon,
  PlusIcon,
  PrReviewIcon,
  SessionIcon,
  TrashIcon,
} from '../../components/icons.js';
import { renderMarkdownComment } from '../../lib/markdown.js';
import { addDays, formatDayLabel, isIsoDate, todayIso } from '../../lib/planner-dates.js';
import { detectIntent, type PlannerIntent } from '../../lib/planner-detect.js';
import { autocorrect, autoformatTitle, suggestTitles } from '../../lib/planner-text.js';
import {
  exportPlannerTasks,
  type PlannerExportFormat,
} from '../../lib/planner-export.js';
import {
  launchNewTask,
  launchReview,
  launchSession,
  linkFromIntent,
  reopenTask,
  type PlannerLaunchApi,
  type WorkspaceLaunchIntent,
} from '../../lib/planner-launch.js';
import type {
  PlannerSummaryResult,
  PlannerSummaryScope,
  PlannerTask,
} from '../../lib/types.js';

/** AI-summary scopes, in selector order. */
const SUMMARY_SCOPES: Array<{ scope: PlannerSummaryScope; label: string }> = [
  { scope: 'day', label: 'Day' },
  { scope: 'month', label: 'Month' },
  { scope: 'year', label: 'Year' },
];

/** Static presentation (icon, label, accent) for each launch action. */
const INTENTS: Record<
  PlannerIntent,
  { label: string; verb: string; Icon: typeof SessionIcon }
> = {
  review: { label: 'Review Board', verb: 'Review the pull request', Icon: PrReviewIcon },
  agent: { label: 'New Task', verb: 'Plan with the New Task agent', Icon: AiMagicIcon },
  session: { label: 'Session', verb: 'Start a working session', Icon: SessionIcon },
};

/** The three downloadable export formats, in menu order. */
const EXPORT_FORMATS: Array<{ format: PlannerExportFormat; label: string }> = [
  { format: 'md', label: 'Markdown' },
  { format: 'json', label: 'JSON' },
  { format: 'csv', label: 'CSV' },
];

/** Triggers a browser download of a generated text document. */
function downloadTextFile(content: string, mime: string, filename: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Selects the non-backlogged tasks whose date falls in the summary scope. */
function tasksForScope(
  tasks: readonly PlannerTask[],
  scope: PlannerSummaryScope,
  date: string,
): PlannerTask[] {
  const prefix =
    scope === 'year' ? date.slice(0, 4) : scope === 'month' ? date.slice(0, 7) : date;
  return tasks
    .filter((task) => !task.backloggedAt && task.date.startsWith(prefix))
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/** Builds the downloadable Markdown doc: the AI summary plus the dated tasks. */
function buildSummaryMarkdown(
  result: PlannerSummaryResult,
  tasks: readonly PlannerTask[],
): string {
  const lines = [`# Planner summary — ${result.range}`, '', result.content.trim(), ''];
  if (tasks.length > 0) {
    lines.push(`## Tasks (${tasks.length})`, '');
    for (const task of tasks) {
      const mark = task.status === 'done' ? '[x]' : '[ ]';
      lines.push(`- ${mark} \`${task.date}\` — ${task.title}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Wraps rendered Markdown in a standalone HTML document for download. */
function buildSummaryHtml(markdown: string, range: string): string {
  const body = renderMarkdownComment(markdown);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    `<title>Planner summary — ${range}</title>`,
    '<style>body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1f2328}code{background:#eff1f3;padding:1px 5px;border-radius:5px}h1,h2{line-height:1.25}</style>',
    '</head>',
    `<body>${body}</body>`,
    '</html>',
  ].join('\n');
}

/** Dispatches to the launch helper for a given intent. */
function launcherFor(
  intent: PlannerIntent,
): (
  api: PlannerLaunchApi,
  task: PlannerTask,
  repoId: string | null,
) => Promise<WorkspaceLaunchIntent> {
  if (intent === 'review') {
    return launchReview;
  }
  if (intent === 'agent') {
    return launchNewTask;
  }
  return launchSession;
}

/**
 * Orders the launch actions for a task: the detected primary first, then the
 * rest. The Review action is only offered when a pull request can be resolved.
 */
export function actionsForTask(task: PlannerTask): PlannerIntent[] {
  const detected = detectIntent(task.prUrl || task.title);
  const canReview = detected.pullNumber !== null || task.kind === 'pr';
  const ordered: PlannerIntent[] = [detected.primary];
  for (const intent of ['review', 'agent', 'session'] as PlannerIntent[]) {
    if (intent === detected.primary) {
      continue;
    }
    if (intent === 'review' && !canReview) {
      continue;
    }
    ordered.push(intent);
  }
  return ordered;
}

export function PlannerView({
  onLaunch,
}: {
  onLaunch: (intent: WorkspaceLaunchIntent) => void;
}) {
  const api = useApi();
  const { prefs } = useUiPreferences();
  const tasks = useAsync(() => api.listPlannerTasks(), []);
  const repos = useAsync(() => api.listRepos(), []);

  const [mode, setMode] = useState<'planner' | 'backlog'>('planner');
  const [day, setDay] = useState(() => todayIso());
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [titleFocused, setTitleFocused] = useState(false);
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [repoId, setRepoId] = useState('');
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [movingAll, setMovingAll] = useState(false);

  const [summaryScope, setSummaryScope] =
    useState<PlannerSummaryScope>('day');
  const [summaryPrompt, setSummaryPrompt] = useState('');
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summary, setSummary] = useState<PlannerSummaryResult | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const repoList = repos.data ?? [];
  const effectiveRepoId = repoId || repoList[0]?.id || null;
  const allTasks = tasks.data ?? [];

  const dayTasks = useMemo(
    () => allTasks.filter((task) => task.date === day && !task.backloggedAt),
    [allTasks, day],
  );
  const backlogTasks = useMemo(
    () =>
      allTasks
        .filter((task) => task.backloggedAt)
        .sort((a, b) => (b.backloggedAt ?? '').localeCompare(a.backloggedAt ?? '')),
    [allTasks],
  );
  const titleHistory = useMemo(() => allTasks.map((task) => task.title), [allTasks]);
  const suggestions = useMemo(
    () => (prefs.plannerAutosuggest ? suggestTitles(title, titleHistory) : []),
    [prefs.plannerAutosuggest, title, titleHistory],
  );
  const detected = useMemo(() => detectIntent(title.trim()), [title]);

  const unfinishedCount = dayTasks.filter((t) => t.status !== 'done').length;

  function changeTitle(value: string) {
    // Autocorrect the just-completed word once a word boundary is typed.
    if (prefs.plannerAutocorrect && /\s$/.test(value)) {
      setTitle(autocorrect(value));
      return;
    }
    setTitle(value);
  }

  async function addTask() {
    const raw = title.trim();
    if (!raw) {
      setFormError('Type a task to get started.');
      return;
    }
    const finalTitle = prefs.plannerAutoformat ? autoformatTitle(raw) : raw;
    setAdding(true);
    setFormError(null);
    try {
      const intent = detectIntent(finalTitle);
      await api.createPlannerTask({
        title: finalTitle,
        date: day,
        notes: notes.trim(),
        kind: intent.primary === 'review' ? 'pr' : 'task',
        prUrl: intent.primary === 'review' ? finalTitle : '',
        repoId: effectiveRepoId,
      });
      setTitle('');
      setNotes('');
      setShowNotes(false);
      tasks.reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not add the task.');
    } finally {
      setAdding(false);
    }
  }

  async function patchTask(
    id: string,
    patch: Parameters<typeof api.updatePlannerTask>[1],
  ) {
    await api.updatePlannerTask(id, patch);
    tasks.reload();
  }

  async function removeTask(id: string) {
    await api.removePlannerTask(id);
    tasks.reload();
  }

  /** Moves every unfinished task on the viewed day to the next day. */
  async function moveUnfinishedToNextDay() {
    const next = addDays(day, 1);
    const pending = dayTasks.filter((task) => task.status !== 'done');
    if (pending.length === 0) {
      return;
    }
    setMovingAll(true);
    setLaunchError(null);
    try {
      await Promise.all(
        pending.map((task) => api.updatePlannerTask(task.id, { date: next })),
      );
      tasks.reload();
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Could not move the tasks.');
    } finally {
      setMovingAll(false);
    }
  }

  /** Sends a task to the backlog, stamped with today's date. */
  async function deferToBacklog(task: PlannerTask) {
    await patchTask(task.id, { backloggedAt: todayIso() });
  }

  /** Restores a backlogged task to a chosen day and clears its backlog stamp. */
  async function restoreFromBacklog(task: PlannerTask, date: string) {
    await patchTask(task.id, { backloggedAt: null, date });
  }

  function exportDay(format: PlannerExportFormat) {
    const doc = exportPlannerTasks(dayTasks, format, formatDayLabel(day));
    downloadTextFile(doc.content, doc.mime, doc.filename);
  }

  /** Requests an AI summary of the current scope (day/month/year). */
  async function generateSummary() {
    setSummaryBusy(true);
    setSummaryError(null);
    try {
      const result = await api.generatePlannerSummary({
        scope: summaryScope,
        date: day,
        prompt: summaryPrompt.trim(),
      });
      setSummary(result);
    } catch (err) {
      setSummaryError(
        err instanceof Error ? err.message : 'Could not generate the summary.',
      );
    } finally {
      setSummaryBusy(false);
    }
  }

  /** The dated tasks that back the most recent summary (for display/export). */
  const summaryTasks = useMemo(
    () =>
      summary ? tasksForScope(allTasks, summary.scope, summary.date) : [],
    [allTasks, summary],
  );

  /** Downloads the current summary (with its dated task list) as Markdown. */
  function downloadSummaryMarkdown(result: PlannerSummaryResult) {
    downloadTextFile(
      buildSummaryMarkdown(result, tasksForScope(allTasks, result.scope, result.date)),
      'text/markdown',
      `planner-summary-${result.range}.md`,
    );
  }

  /** Downloads the current summary (with its dated task list) as HTML. */
  function downloadSummaryHtml(result: PlannerSummaryResult) {
    const markdown = buildSummaryMarkdown(
      result,
      tasksForScope(allTasks, result.scope, result.date),
    );
    downloadTextFile(
      buildSummaryHtml(markdown, result.range),
      'text/html',
      `planner-summary-${result.range}.html`,
    );
  }

  /** Runs a fresh launch for `task`, records the link, and opens it. */
  async function launchTask(task: PlannerTask, intent: PlannerIntent) {
    setBusyTaskId(task.id);
    setLaunchError(null);
    try {
      const repo = task.repoId || effectiveRepoId;
      const result = await launcherFor(intent)(api, task, repo);
      const link = linkFromIntent(result);
      await api.updatePlannerTask(task.id, { ...link, repoId: repo });
      onLaunch(result);
      tasks.reload();
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Could not launch the task.');
    } finally {
      setBusyTaskId(null);
    }
  }

  /** Re-opens a launched task, recreating its target if it was deleted. */
  async function openTask(task: PlannerTask) {
    if (!task.launchKind) {
      return;
    }
    setBusyTaskId(task.id);
    setLaunchError(null);
    try {
      const intent = await reopenTask(api, task);
      onLaunch(intent);
    } catch {
      // The underlying session/feature is gone — recreate it from the task.
      await launchTask(task, task.launchKind);
      return;
    } finally {
      setBusyTaskId(null);
    }
  }

  async function renameLaunch(task: PlannerTask) {
    const name = renameValue.trim();
    if (!name) {
      setRenamingId(null);
      return;
    }
    try {
      if (task.launchKind === 'session' && task.sessionId) {
        await api.renameSession(task.sessionId, name);
      } else if (task.featureId) {
        await api.renameFeature(task.featureId, name);
      }
    } catch {
      // The target may have been deleted; keep the task's own label in sync.
    }
    await api.updatePlannerTask(task.id, { launchLabel: name });
    setRenamingId(null);
    tasks.reload();
  }

  async function unlink(task: PlannerTask) {
    await api.updatePlannerTask(task.id, {
      launchKind: null,
      featureId: null,
      sessionId: null,
      launchLabel: null,
    });
    tasks.reload();
  }

  const DetectedIcon = INTENTS[detected.primary].Icon;

  if (mode === 'backlog') {
    return (
      <BacklogView
        tasks={backlogTasks}
        onBack={() => setMode('planner')}
        onRestore={(task, date) => void restoreFromBacklog(task, date)}
        onDelete={(id) => void removeTask(id)}
        error={tasks.error}
      />
    );
  }

  return (
    <div className="planner">
      <header className="planner-header">
        <h1>
          <PlannerIcon size={20} /> Planner
        </h1>
        <p className="muted">
          Jot down what you&rsquo;re working on. The Planner figures out whether
          it&rsquo;s a pull request to review, a task to plan, or a session to
          start — then opens it in the workspace and keeps a link you can return
          to any time.
        </p>
      </header>

      <section className="planner-toolbar">
        <div className="planner-daybar">
          <button
            type="button"
            className="icon-button"
            onClick={() => setDay((d) => addDays(d, -1))}
            aria-label="Previous day"
            title="Previous day"
          >
            <ChevronLeftIcon size={18} />
          </button>
          <div className="planner-daybar-center">
            <CalendarIcon size={15} />
            <span className="planner-daybar-label">{formatDayLabel(day)}</span>
            <input
              type="date"
              className="planner-daybar-date"
              value={day}
              onChange={(e) => {
                if (isIsoDate(e.target.value)) {
                  setDay(e.target.value);
                }
              }}
              aria-label="Jump to date"
            />
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => setDay((d) => addDays(d, 1))}
            aria-label="Next day"
            title="Next day"
          >
            <ChevronRightIcon size={18} />
          </button>
          {day !== todayIso() && (
            <button
              type="button"
              className="planner-today-btn"
              onClick={() => setDay(todayIso())}
            >
              Today
            </button>
          )}
        </div>
        <div className="planner-toolbar-actions">
          <label className="planner-repo">
            Repository
            <select
              value={effectiveRepoId ?? ''}
              onChange={(e) => setRepoId(e.target.value)}
              aria-label="Repository for launches"
            >
              <option value="">None</option>
              {repoList.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="planner-tool-btn"
            onClick={() => void moveUnfinishedToNextDay()}
            disabled={movingAll || unfinishedCount === 0}
            title="Move every unfinished task to tomorrow"
          >
            <ChevronRightIcon size={14} /> Move unfinished
          </button>
          <div className="planner-export">
            <ExportIcon size={14} />
            {EXPORT_FORMATS.map(({ format, label }) => (
              <button
                key={format}
                type="button"
                className="planner-export-btn"
                onClick={() => exportDay(format)}
                disabled={dayTasks.length === 0}
                title={`Export this day as ${label}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="planner-tool-btn"
            onClick={() => setMode('backlog')}
            title="Open the backlog"
          >
            Backlog
            {backlogTasks.length > 0 && (
              <span className="planner-backlog-count">{backlogTasks.length}</span>
            )}
          </button>
          <button
            type="button"
            className="planner-ai-trigger"
            onClick={() => setSummaryOpen(true)}
            aria-label="AI summary"
            title="Summarize these tasks with AI"
          >
            <AiIcon size={15} />
            <span>AI summary</span>
          </button>
        </div>
      </section>

      <section className="planner-hero">
        <div className="planner-hero-row">
          <PlannerIcon size={18} className="planner-hero-icon" />
          <div className="planner-hero-field">
            <input
              type="text"
              className="planner-hero-input"
              placeholder="What are you working on?"
              value={title}
              onChange={(e) => changeTitle(e.target.value)}
              onFocus={() => setTitleFocused(true)}
              onBlur={() => window.setTimeout(() => setTitleFocused(false), 120)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void addTask();
                }
              }}
              aria-label="New task"
            />
            {titleFocused && suggestions.length > 0 && (
              <ul className="planner-suggest" role="listbox">
                {suggestions.map((suggestion) => (
                  <li key={suggestion}>
                    <button
                      type="button"
                      className="planner-suggest-item"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setTitle(suggestion);
                        setTitleFocused(false);
                      }}
                    >
                      {suggestion}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            className="primary planner-hero-add"
            onClick={() => void addTask()}
            disabled={adding}
          >
            <PlusIcon size={16} /> Add
          </button>
        </div>
        <div className="planner-hero-foot">
          {title.trim() ? (
            <span className={`planner-chip kind-${detected.primary}`}>
              <DetectedIcon size={13} /> {INTENTS[detected.primary].verb}
            </span>
          ) : (
            <span className="planner-chip is-ghost">
              Type a task — I&rsquo;ll suggest the best way to start it
            </span>
          )}
          <button
            type="button"
            className="planner-notes-toggle"
            onClick={() => setShowNotes((v) => !v)}
          >
            {showNotes ? 'Hide details' : '+ Add details'}
          </button>
        </div>
        {showNotes && (
          <textarea
            className="planner-notes-input"
            placeholder="Extra context, links, acceptance criteria…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            aria-label="Task details"
          />
        )}
        <ErrorText error={formError} />
      </section>

      <ErrorText error={tasks.error} />
      <ErrorText error={launchError} />

      <div className="planner-day-content" key={day}>
        {dayTasks.length === 0 ? (
        <EmptyState
          title="Nothing planned for this day"
          description="Add a task above. Use the arrows to plan ahead or backfill a past day."
          icon={<PlannerIcon size={28} />}
        />
      ) : (
        <ul className="planner-list">
          {dayTasks.map((task) => (
            <PlannerRow
              key={task.id}
              task={task}
              busy={busyTaskId === task.id}
              renaming={renamingId === task.id}
              renameValue={renameValue}
              onRenameValue={setRenameValue}
              onToggleDone={() =>
                void patchTask(task.id, {
                  status: task.status === 'done' ? 'open' : 'done',
                })
              }
              onDefer={() => void deferToBacklog(task)}
              onLaunch={(intent) => void launchTask(task, intent)}
              onOpen={() => void openTask(task)}
              onStartRename={() => {
                setRenamingId(task.id);
                setRenameValue(task.launchLabel ?? task.title);
              }}
              onCommitRename={() => void renameLaunch(task)}
              onCancelRename={() => setRenamingId(null)}
              onUnlink={() => void unlink(task)}
              onDelete={() => void removeTask(task.id)}
            />
          ))}
        </ul>
      )}
      </div>

      {summaryOpen && (
        <div
          className="planner-summary-overlay"
          role="presentation"
          onClick={() => setSummaryOpen(false)}
        >
          <div
            className="planner-summary-modal"
            role="dialog"
            aria-modal="true"
            aria-label="AI task summary"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="planner-summary-head">
              <span className="planner-summary-badge">
                <AiIcon size={16} />
              </span>
              <span className="planner-summary-title">AI task summary</span>
              <div className="planner-summary-scope" role="tablist">
                {SUMMARY_SCOPES.map(({ scope, label }) => (
                  <button
                    key={scope}
                    type="button"
                    role="tab"
                    aria-selected={summaryScope === scope}
                    className={
                      summaryScope === scope
                        ? 'planner-summary-scope-btn is-active'
                        : 'planner-summary-scope-btn'
                    }
                    onClick={() => setSummaryScope(scope)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="icon-button planner-mini"
                onClick={() => setSummaryOpen(false)}
                aria-label="Close AI summary"
                title="Close"
              >
                <CloseIcon size={15} />
              </button>
            </div>
            <label
              className="planner-summary-prompt-label"
              htmlFor="planner-summary-prompt"
            >
              Ask the AI how to summarize these tasks
            </label>
            <textarea
              id="planner-summary-prompt"
              className="planner-summary-prompt"
              value={summaryPrompt}
              onChange={(e) => setSummaryPrompt(e.target.value)}
              placeholder="e.g. focus on blockers, group by repo, highlight what shipped…"
              rows={3}
              aria-label="Summary guidance"
            />
            <div className="planner-summary-actions">
              <button
                type="button"
                className="planner-ai-trigger is-generate"
                onClick={() => void generateSummary()}
                disabled={summaryBusy}
              >
                <AiMagicIcon size={15} />
                {summaryBusy ? 'Generating…' : 'Generate summary'}
              </button>
              {summary && (
                <div className="planner-summary-downloads">
                  <button
                    type="button"
                    className="planner-export-btn"
                    onClick={() => downloadSummaryMarkdown(summary)}
                    title="Download the summary as Markdown"
                  >
                    <DownloadMarkdownIcon size={14} /> .md
                  </button>
                  <button
                    type="button"
                    className="planner-export-btn"
                    onClick={() => downloadSummaryHtml(summary)}
                    title="Download the summary as HTML"
                  >
                    <DownloadHtmlIcon size={14} /> .html
                  </button>
                </div>
              )}
            </div>
            <ErrorText error={summaryError} />
            {summary && (
              <div className="planner-summary-result">
                <div className="planner-summary-meta">
                  {summary.range} · {summary.taskCount} task
                  {summary.taskCount === 1 ? '' : 's'}
                </div>
                <div
                  className="planner-summary-rendered"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdownComment(summary.content),
                  }}
                />
                {summaryTasks.length > 0 && (
                  <div className="planner-summary-tasks">
                    <div className="planner-summary-tasks-head">Task list</div>
                    <ul>
                      {summaryTasks.map((t) => (
                        <li
                          key={t.id}
                          className={t.status === 'done' ? 'is-done' : ''}
                        >
                          <span className="planner-summary-task-date">{t.date}</span>
                          <span className="planner-summary-task-title">{t.title}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BacklogView({
  tasks,
  onBack,
  onRestore,
  onDelete,
  error,
}: {
  tasks: PlannerTask[];
  onBack: () => void;
  onRestore: (task: PlannerTask, date: string) => void;
  onDelete: (id: string) => void;
  error: string | null;
}) {
  return (
    <div className="planner">
      <header className="planner-header">
        <h1>
          <button
            type="button"
            className="icon-button"
            onClick={onBack}
            aria-label="Back to planner"
            title="Back to planner"
          >
            <ChevronLeftIcon size={18} />
          </button>
          Backlog
        </h1>
        <p className="muted">
          Tasks you deferred, stamped with the day they were parked. Restore one
          to today or pick any other day to bring it back into the plan.
        </p>
      </header>

      <ErrorText error={error} />

      {tasks.length === 0 ? (
        <EmptyState
          title="The backlog is empty"
          description="Defer a task from the planner to park it here for later."
          icon={<PlannerIcon size={28} />}
        />
      ) : (
        <ul className="planner-list">
          {tasks.map((task) => (
            <BacklogRow
              key={task.id}
              task={task}
              onRestore={(date) => onRestore(task, date)}
              onDelete={() => onDelete(task.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function BacklogRow({
  task,
  onRestore,
  onDelete,
}: {
  task: PlannerTask;
  onRestore: (date: string) => void;
  onDelete: () => void;
}) {
  const [date, setDate] = useState(() => todayIso());

  return (
    <li className="planner-item">
      <div className="planner-item-body">
        <span className="planner-item-title">{task.title}</span>
        <span className="planner-item-notes">Backlogged {task.backloggedAt}</span>
      </div>
      <div className="planner-item-side">
        <input
          type="date"
          className="planner-item-date"
          value={date}
          onChange={(e) => {
            if (isIsoDate(e.target.value)) {
              setDate(e.target.value);
            }
          }}
          aria-label={`Restore date for "${task.title}"`}
          title="Pick the day to restore to"
        />
        <button
          type="button"
          className="planner-tool-btn"
          onClick={() => onRestore(date)}
          title="Restore to the chosen day"
        >
          Restore
        </button>
        <button
          type="button"
          className="icon-button planner-mini"
          onClick={onDelete}
          aria-label={`Delete "${task.title}"`}
          title="Delete"
        >
          <TrashIcon size={14} />
        </button>
      </div>
    </li>
  );
}

function PlannerRow({
  task,
  busy,
  renaming,
  renameValue,
  onRenameValue,
  onToggleDone,
  onDefer,
  onLaunch,
  onOpen,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onUnlink,
  onDelete,
}: {
  task: PlannerTask;
  busy: boolean;
  renaming: boolean;
  renameValue: string;
  onRenameValue: (value: string) => void;
  onToggleDone: () => void;
  onDefer: () => void;
  onLaunch: (intent: PlannerIntent) => void;
  onOpen: () => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onUnlink: () => void;
  onDelete: () => void;
}) {
  const launched = task.launchKind;
  const LaunchedIcon = launched ? INTENTS[launched].Icon : SessionIcon;

  return (
    <li className={`planner-item ${task.status === 'done' ? 'is-done' : ''}`.trim()}>
      <input
        type="checkbox"
        className="planner-check"
        checked={task.status === 'done'}
        onChange={onToggleDone}
        aria-label={`Mark "${task.title}" done`}
      />
      <div className="planner-item-body">
        <span className="planner-item-title">{task.title}</span>
        {task.notes && <span className="planner-item-notes">{task.notes}</span>}
      </div>

      <div className="planner-item-side">
        {launched ? (
          <div className={`planner-launched kind-${launched}`}>
            {renaming ? (
              <input
                type="text"
                className="planner-rename"
                value={renameValue}
                autoFocus
                onChange={(e) => onRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onCommitRename();
                  } else if (e.key === 'Escape') {
                    onCancelRename();
                  }
                }}
                onBlur={onCommitRename}
                aria-label="Rename"
              />
            ) : (
              <button
                type="button"
                className="planner-open"
                onClick={onOpen}
                disabled={busy}
                title={`Open ${INTENTS[launched].label}`}
              >
                <LaunchedIcon size={14} />
                <span className="planner-open-label">
                  {task.launchLabel || INTENTS[launched].label}
                </span>
              </button>
            )}
            {!renaming && (
              <>
                <button
                  type="button"
                  className="icon-button planner-mini"
                  onClick={onStartRename}
                  aria-label="Rename"
                  title="Rename"
                >
                  <PencilIcon size={13} />
                </button>
                <button
                  type="button"
                  className="icon-button planner-mini"
                  onClick={onUnlink}
                  aria-label="Unlink"
                  title="Unlink"
                >
                  <CloseIcon size={13} />
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="planner-actions">
            {actionsForTask(task).map((intent, index) => {
              const { label, Icon } = INTENTS[intent];
              return (
                <button
                  key={intent}
                  type="button"
                  className={`planner-action kind-${intent} ${
                    index === 0 ? 'is-primary' : ''
                  }`.trim()}
                  onClick={() => onLaunch(intent)}
                  disabled={busy}
                  title={INTENTS[intent].verb}
                >
                  <Icon size={14} /> {label}
                </button>
              );
            })}
          </div>
        )}

        <button
          type="button"
          className="icon-button planner-mini"
          onClick={onDefer}
          aria-label={`Defer "${task.title}" to backlog`}
          title="Defer to backlog"
        >
          <CalendarIcon size={14} />
        </button>
        <button
          type="button"
          className="icon-button planner-mini"
          onClick={onDelete}
          aria-label={`Delete "${task.title}"`}
          title="Delete"
        >
          <TrashIcon size={14} />
        </button>
      </div>
    </li>
  );
}

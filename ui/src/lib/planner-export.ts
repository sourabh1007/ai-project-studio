/**
 * Pure serializers that turn Planner tasks into a downloadable document in one
 * of three formats. Each returns the file `content`, its `mime` type, and a
 * suggested `filename` so the caller only has to trigger the browser download.
 */
import type { PlannerTask } from './types.js';
import { isIsoDate } from './planner-dates.js';

export type PlannerExportFormat = 'md' | 'json' | 'csv';
export type TrackedWorkExportPeriod = 'day' | 'week' | 'year';

export function trackedWorkForExport(
  tasks: readonly PlannerTask[],
  period: TrackedWorkExportPeriod,
  date: string,
): { tasks: PlannerTask[]; from: string; through: string; label: string } {
  if (!isIsoDate(date)) throw new RangeError('Choose a valid reference date.');
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(start);
  if (period === 'week') {
    start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
    end.setTime(start.getTime());
    end.setUTCDate(end.getUTCDate() + 6);
  } else if (period === 'year') {
    start.setUTCMonth(0, 1);
    end.setUTCMonth(11, 31);
  }
  const from = start.toISOString().split('T')[0];
  const through = end.toISOString().split('T')[0];
  return {
    tasks: tasks.filter((task) => task.automaticallyTracked && !task.backloggedAt
      && isIsoDate(task.date) && Date.parse(task.date) >= start.getTime() && Date.parse(task.date) <= end.getTime())
      .sort((a, b) => a.date.localeCompare(b.date)),
    from, through, label: period === 'day' ? date : period === 'year' ? date.slice(0, 4) : `${from} to ${through}`,
  };
}

export interface PlannerExport {
  content: string;
  mime: string;
  filename: string;
}

/** Columns included in the CSV/JSON export, in order. */
const CSV_COLUMNS: Array<keyof PlannerTask> = [
  'date',
  'title',
  'notes',
  'status',
  'priority',
  'kind',
  'prUrl',
  'launchKind',
  'launchLabel',
  'backloggedAt',
  'automaticallyTracked',
];

/** Quotes a CSV field when it contains a comma, quote, or newline. */
function csvCell(value: unknown): string {
  const raw = value == null ? '' : String(value);
  const text = /^[\s]*[=+\-@]|^[\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Markdown checkbox for a task based on its status. */
function checkbox(task: PlannerTask): string {
  return task.status === 'done' ? '[x]' : '[ ]';
}

function toMarkdown(tasks: readonly PlannerTask[], label: string): string {
  const lines = [`# Planner — ${label}`, ''];
  if (tasks.length === 0) {
    lines.push('_No tasks._');
    return lines.join('\n');
  }
  const byDate = new Map<string, PlannerTask[]>();
  for (const task of tasks) {
    const bucket = byDate.get(task.date) ?? [];
    bucket.push(task);
    byDate.set(task.date, bucket);
  }
  const entries = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [date, bucket] of entries) {
    lines.push(`## ${date}`, '');
    for (const task of bucket) {
      const tags = [task.priority.toUpperCase()];
      if (task.kind === 'pr') {
        tags.push('PR');
      }
      if (task.backloggedAt) {
        tags.push('backlog');
      }
      lines.push(`- ${checkbox(task)} ${task.title} _(${tags.join(', ')})_`);
      if (task.notes.trim()) {
        lines.push(...task.notes.trim().split(/\r?\n/).map((line) => `  ${line}`));
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function toCsv(tasks: readonly PlannerTask[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = tasks.map((task) =>
    CSV_COLUMNS.map((col) => csvCell(task[col])).join(','),
  );
  return [header, ...rows].join('\n');
}

/**
 * Serializes `tasks` into `format`. `label` describes the exported range (e.g.
 * a day or "All tasks") and is used in the Markdown heading and the filename.
 */
export function exportPlannerTasks(
  tasks: readonly PlannerTask[],
  format: PlannerExportFormat,
  label: string,
): PlannerExport {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'planner';
  if (format === 'json') {
    return {
      content: JSON.stringify(tasks, null, 2),
      mime: 'application/json',
      filename: `planner-${slug}.json`,
    };
  }
  if (format === 'csv') {
    return {
      content: toCsv(tasks),
      mime: 'text/csv',
      filename: `planner-${slug}.csv`,
    };
  }
  return {
    content: toMarkdown(tasks, label),
    mime: 'text/markdown',
    filename: `planner-${slug}.md`,
  };
}

/**
 * Pure serializers that turn Planner tasks into a downloadable document in one
 * of three formats. Each returns the file `content`, its `mime` type, and a
 * suggested `filename` so the caller only has to trigger the browser download.
 */
import type { PlannerTask } from './types.js';

export type PlannerExportFormat = 'md' | 'json' | 'csv';

export interface PlannerExport {
  content: string;
  mime: string;
  filename: string;
}

/** Columns included in the CSV/JSON export, in order. */
const CSV_COLUMNS: Array<keyof PlannerTask> = [
  'date',
  'title',
  'status',
  'priority',
  'kind',
  'prUrl',
  'launchKind',
  'launchLabel',
  'backloggedAt',
];

/** Quotes a CSV field when it contains a comma, quote, or newline. */
function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) {
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

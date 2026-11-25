import { describe, it, expect } from 'vitest';
import { exportPlannerTasks, trackedWorkForExport } from './planner-export.js';
import type { PlannerTask } from './types.js';

function task(overrides: Partial<PlannerTask> = {}): PlannerTask {
  return {
    id: 't1',
    title: 'A task',
    notes: '',
    priority: 'p2',
    status: 'open',
    kind: 'task',
    prUrl: '',
    date: '2026-02-10',
    repoId: null,
    launchKind: null,
    featureId: null,
    sessionId: null,
    launchLabel: null,
    backloggedAt: null,
    createdAt: '2026-02-10T08:00:00.000Z',
    updatedAt: '2026-02-10T08:00:00.000Z',
    ...overrides,
  };
}

describe('exportPlannerTasks', () => {
  it('serializes markdown grouped by date with status, pr and backlog tags', () => {
    const result = exportPlannerTasks(
      [
        task({ id: 'a', title: 'Done thing', status: 'done', date: '2026-02-10' }),
        task({ id: 'b', title: 'Review it', kind: 'pr', date: '2026-02-09' }),
        task({ id: 'c', title: 'Deferred', backloggedAt: '2026-02-08', date: '2026-02-09' }),
      ],
      'md',
      'Today',
    );
    expect(result.mime).toBe('text/markdown');
    expect(result.filename).toBe('planner-today.md');
    expect(result.content).toContain('# Planner — Today');
    expect(result.content).toContain('## 2026-02-09');
    expect(result.content).toContain('- [ ] Review it _(P2, PR)_');
    expect(result.content).toContain('- [ ] Deferred _(P2, backlog)_');
    expect(result.content).toContain('- [x] Done thing _(P2)_');
    // 2026-02-09 sorts before 2026-02-10.
    expect(result.content.indexOf('## 2026-02-09')).toBeLessThan(
      result.content.indexOf('## 2026-02-10'),
    );
  });

  it('renders an empty markdown document', () => {
    const result = exportPlannerTasks([], 'md', 'All tasks');
    expect(result.content).toBe('# Planner — All tasks\n\n_No tasks._');
    expect(result.filename).toBe('planner-all-tasks.md');
  });

  it('serializes JSON', () => {
    const tasks = [task({ id: 'a' })];
    const result = exportPlannerTasks(tasks, 'json', 'Today');
    expect(result.mime).toBe('application/json');
    expect(result.filename).toBe('planner-today.json');
    expect(JSON.parse(result.content)).toEqual(tasks);
  });

  it('serializes CSV with a header and quotes risky cells', () => {
    const result = exportPlannerTasks(
      [task({ title: 'Fix, urgently', launchLabel: 'has "quotes"' })],
      'csv',
      'Today',
    );
    expect(result.mime).toBe('text/csv');
    const [header, row] = result.content.split('\n');
    expect(header).toBe('date,title,notes,status,priority,kind,prUrl,launchKind,launchLabel,backloggedAt,automaticallyTracked');
    expect(row).toContain('"Fix, urgently"');
    expect(row).toContain('"has ""quotes"""');
  });

  it('retains multiline notes in Markdown and CSV and makes spreadsheet formulas inert', () => {
    const tasks = [task({ title: '=HYPERLINK("https://example.test")', notes: 'First line\r\nSecond, line' }),
      task({ title: ' \t+SUM(1,2)', notes: '\rnote' }), task({ title: '\tplain' })];
    expect(exportPlannerTasks(tasks, 'csv', 'Tracked work').content).toContain(`"'=HYPERLINK(""https://example.test"")"`);
    expect(exportPlannerTasks(tasks, 'csv', 'Tracked work').content).toContain(`"' \t+SUM(1,2)"`);
    expect(exportPlannerTasks(tasks, 'csv', 'Tracked work').content).toContain("'\tplain");
    expect(exportPlannerTasks(tasks, 'md', 'Tracked work').content).toContain('  First line\n  Second, line');
  });

  it('falls back to a default slug when the label has no usable characters', () => {
    const result = exportPlannerTasks([], 'json', '!!!');
    expect(result.filename).toBe('planner-planner.json');
  });

  describe('trackedWorkForExport', () => {
    const tracked = (date: string, values: Partial<PlannerTask> = {}) => task({
      id: date, date, automaticallyTracked: true, ...values,
    });
    const tasks = [
      tracked('2026-01-04'), tracked('2025-12-29'), tracked('2026-01-01', { status: 'done' }),
      tracked('2025-12-28'), tracked('2026-01-05'), tracked('2026-12-31'), tracked('2027-01-01'),
      tracked('2026-01-01', { id: 'backlog', backloggedAt: '2026-01-01' }),
      tracked('invalid'), task({ date: '2026-01-01' }),
    ];
    it('exports only tracked work assigned to the selected day, including completed tasks', () => {
      expect(trackedWorkForExport(tasks, 'day', '2026-01-01')).toMatchObject({
        from: '2026-01-01', through: '2026-01-01', label: '2026-01-01',
        tasks: [expect.objectContaining({ id: '2026-01-01', status: 'done' })],
      });
    });
    it.each(['2025-12-29', '2026-01-01', '2026-01-04'])('uses the same Monday-Sunday week across years for %s', (date) => {
      const result = trackedWorkForExport(tasks, 'week', date);
      expect(result.label).toBe('2025-12-29 to 2026-01-04');
      expect(result.tasks.map((entry) => entry.id)).toEqual(['2025-12-29', '2026-01-01', '2026-01-04']);
    });
    it('covers the whole calendar year, not just the visible day or a rolling year', () => {
      expect(trackedWorkForExport(tasks, 'year', '2026-06-15').tasks.map((entry) => entry.id))
        .toEqual(['2026-01-01', '2026-01-04', '2026-01-05', '2026-12-31']);
    });
    it('handles leap days and DST transitions as calendar dates', () => {
      const entries = [tracked('2024-02-29'), tracked('2024-03-10'), tracked('2024-03-11')];
      expect(trackedWorkForExport(entries, 'year', '2024-12-31').tasks).toHaveLength(3);
      expect(trackedWorkForExport(entries, 'week', '2024-03-10').tasks.map((entry) => entry.id)).toEqual(['2024-03-10']);
    });
    it('rejects invalid anchors and does not mutate the source order', () => {
      expect(() => trackedWorkForExport(tasks, 'week', '2026-02-30')).toThrow('valid reference date');
      const original = [...tasks];
      trackedWorkForExport(tasks, 'year', '2026-01-01');
      expect(tasks).toEqual(original);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { exportPlannerTasks } from './planner-export.js';
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
    expect(header).toBe('date,title,status,priority,kind,prUrl,launchKind,launchLabel,backloggedAt');
    expect(row).toContain('"Fix, urgently"');
    expect(row).toContain('"has ""quotes"""');
  });

  it('falls back to a default slug when the label has no usable characters', () => {
    const result = exportPlannerTasks([], 'json', '!!!');
    expect(result.filename).toBe('planner-planner.json');
  });
});

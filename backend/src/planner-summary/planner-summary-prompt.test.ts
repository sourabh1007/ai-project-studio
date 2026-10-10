import { describe, expect, it } from 'vitest';
import type { PlannerTask } from '../planner/planner-contract.js';
import { plannerSummaryDefaults } from './config.js';
import { buildPlannerSummaryPrompt } from './planner-summary-prompt.js';

function task(partial: Partial<PlannerTask>): PlannerTask {
  return {
    id: 'id',
    title: 'Task',
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
    createdAt: '2026-02-10T00:00:00.000Z',
    updatedAt: '2026-02-10T00:00:00.000Z',
    ...partial,
  };
}

const config = plannerSummaryDefaults;

describe('buildPlannerSummaryPrompt', () => {
  it('renders done and open task marks with scope and range', () => {
    const prompt = buildPlannerSummaryPrompt(
      [
        task({ title: 'Ship it', status: 'done', priority: 'p0' }),
        task({ title: 'Write docs', status: 'open', priority: 'p1' }),
      ],
      { scope: 'month', date: '2026-02-10', prompt: 'Focus on wins' },
      config,
    );
    expect(prompt).toContain('Summarize the month of 2026-02,');
    expect(prompt).toContain('Guidance: Focus on wins');
    expect(prompt).toContain('[x] [2026-02-10 · p0] Ship it');
    expect(prompt).toContain('[ ] [2026-02-10 · p1] Write docs');
  });

  it('falls back to default guidance when the prompt is blank', () => {
    const prompt = buildPlannerSummaryPrompt(
      [task({})],
      { scope: 'day', date: '2026-02-10', prompt: '   ' },
      config,
    );
    expect(prompt).toContain(`Guidance: ${config.defaultGuidance}`);
  });

  it('uses the no-tasks placeholder when the scope is empty', () => {
    const prompt = buildPlannerSummaryPrompt(
      [],
      { scope: 'year', date: '2026-02-10', prompt: 'anything' },
      config,
    );
    expect(prompt).toContain(config.noTasksPlaceholder);
  });
});

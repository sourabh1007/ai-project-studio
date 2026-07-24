import { describe, it, expect } from 'vitest';
import { buildTaskPlanPrompt } from './task-plan-prompt-builder.js';
import { featureTasksDefaults } from './config.js';
import type { Feature } from '../feature/feature-contract.js';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'f1',
    name: 'Login',
    description: 'Add email login',
    createdAt: '2026-01-01T00:00:00.000Z',
    summary: null,
    ...overrides,
  };
}

describe('buildTaskPlanPrompt', () => {
  it('substitutes the feature name, description and task cap', () => {
    const prompt = buildTaskPlanPrompt(feature(), featureTasksDefaults);
    expect(prompt).toContain('Login');
    expect(prompt).toContain('Add email login');
    expect(prompt).toContain(String(featureTasksDefaults.maxTasks));
    expect(prompt).not.toContain('{{');
  });

  it('falls back to the placeholder when the description is blank', () => {
    const prompt = buildTaskPlanPrompt(
      feature({ description: '   ' }),
      featureTasksDefaults,
    );
    expect(prompt).toContain(featureTasksDefaults.emptyDescriptionPlaceholder);
  });
});

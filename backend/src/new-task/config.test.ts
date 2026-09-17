import { describe, it, expect } from 'vitest';
import {
  NEW_TASK_NAMESPACE,
  newTaskConfigSchema,
  newTaskDefaults,
} from './config.js';

describe('new-task config', () => {
  it('exposes a stable namespace', () => {
    expect(NEW_TASK_NAMESPACE).toBe('newTask');
  });

  it('accepts its own defaults', () => {
    expect(() => newTaskConfigSchema.parse(newTaskDefaults)).not.toThrow();
    expect(newTaskDefaults.planTimeoutMs).toBeGreaterThan(0);
    expect(newTaskDefaults.implementTimeoutMs).toBeGreaterThan(0);
    expect(newTaskDefaults.planPromptTemplate.length).toBeGreaterThan(0);
    expect(newTaskDefaults.implementPromptTemplate.length).toBeGreaterThan(0);
    expect(newTaskDefaults.refinePromptTemplate.length).toBeGreaterThan(0);
  });

  it('rejects an empty refine prompt template', () => {
    expect(() =>
      newTaskConfigSchema.parse({ ...newTaskDefaults, refinePromptTemplate: '' }),
    ).toThrow();
  });

  it('rejects a non-positive timeout', () => {
    expect(() =>
      newTaskConfigSchema.parse({ ...newTaskDefaults, planTimeoutMs: 0 }),
    ).toThrow();
  });
});

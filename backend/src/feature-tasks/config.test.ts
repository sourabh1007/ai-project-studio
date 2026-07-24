import { describe, it, expect } from 'vitest';
import {
  featureTasksConfigSchema,
  featureTasksDefaults,
  FEATURE_TASKS_NAMESPACE,
} from './config.js';

describe('feature-tasks config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(FEATURE_TASKS_NAMESPACE).toBe('featureTasks');
    expect(() => featureTasksConfigSchema.parse(featureTasksDefaults)).not.toThrow();
  });

  it('rejects a non-positive max tasks', () => {
    expect(() =>
      featureTasksConfigSchema.parse({ ...featureTasksDefaults, maxTasks: 0 }),
    ).toThrow();
  });

  it('rejects an empty prompt template', () => {
    expect(() =>
      featureTasksConfigSchema.parse({ ...featureTasksDefaults, promptTemplate: '' }),
    ).toThrow();
  });

  it('rejects an empty set of title keys', () => {
    expect(() =>
      featureTasksConfigSchema.parse({ ...featureTasksDefaults, titleKeys: [] }),
    ).toThrow();
  });
});

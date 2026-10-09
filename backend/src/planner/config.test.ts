import { describe, it, expect } from 'vitest';
import {
  plannerConfigSchema,
  plannerDefaults,
  PLANNER_NAMESPACE,
} from './config.js';

describe('planner config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(PLANNER_NAMESPACE).toBe('planner');
    expect(() => plannerConfigSchema.parse(plannerDefaults)).not.toThrow();
  });

  it('rejects a non-positive max title length', () => {
    expect(() =>
      plannerConfigSchema.parse({ ...plannerDefaults, maxTitleLength: 0 }),
    ).toThrow();
  });

  it('rejects an unknown default priority', () => {
    expect(() =>
      plannerConfigSchema.parse({ ...plannerDefaults, defaultPriority: 'p9' }),
    ).toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import {
  COPILOT_HISTORY_NAMESPACE,
  copilotHistoryConfigSchema,
  copilotHistoryDefaults,
} from './config.js';

describe('copilot-history config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(COPILOT_HISTORY_NAMESPACE).toBe('copilotHistory');
    expect(() =>
      copilotHistoryConfigSchema.parse(copilotHistoryDefaults),
    ).not.toThrow();
  });

  it('rejects an empty subdir', () => {
    expect(() =>
      copilotHistoryConfigSchema.parse({ ...copilotHistoryDefaults, subdir: '' }),
    ).toThrow();
  });

  it('rejects an empty database file', () => {
    expect(() =>
      copilotHistoryConfigSchema.parse({
        ...copilotHistoryDefaults,
        databaseFile: '',
      }),
    ).toThrow();
  });

  it('rejects a non-positive checkpoint cap', () => {
    expect(() =>
      copilotHistoryConfigSchema.parse({
        ...copilotHistoryDefaults,
        maxCheckpointsPerSession: 0,
      }),
    ).toThrow();
  });

  it('rejects a non-positive overview cap', () => {
    expect(() =>
      copilotHistoryConfigSchema.parse({
        ...copilotHistoryDefaults,
        maxOverviewChars: -1,
      }),
    ).toThrow();
  });
});

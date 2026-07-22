import { describe, it, expect } from 'vitest';
import { buildUsageFilePath } from './session-paths.js';
import { sessionDefaults } from './config.js';

describe('session-paths', () => {
  it('joins usage dir, session id and extension', () => {
    const p = buildUsageFilePath(sessionDefaults, 'abc');
    expect(p.endsWith('abc.jsonl')).toBe(true);
    expect(p).toContain('usage');
  });

  it('honours a custom extension', () => {
    const p = buildUsageFilePath(
      { ...sessionDefaults, usageDir: 'out', usageFileExtension: '.log' },
      'sess-1',
    );
    expect(p).toContain('sess-1.log');
  });
});

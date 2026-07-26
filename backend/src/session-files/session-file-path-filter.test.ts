import { describe, it, expect } from 'vitest';
import { shouldIgnore } from './session-file-path-filter.js';

describe('shouldIgnore', () => {
  it('ignores dependency, build, VCS and tool directories anywhere in the path', () => {
    expect(shouldIgnore('C:\\proj\\node_modules\\x\\index.js')).toBe(true);
    expect(shouldIgnore('/proj/.git/HEAD')).toBe(true);
    expect(shouldIgnore('C:\\proj\\dist\\main.js')).toBe(true);
    expect(shouldIgnore('/proj/coverage/report.html')).toBe(true);
    expect(shouldIgnore('C:\\proj\\.copilot\\session-store.db')).toBe(true);
    expect(shouldIgnore('/proj/__pycache__/mod.pyc')).toBe(true);
  });

  it('ignores log, temp, lock, editor-backup and OS metadata files', () => {
    expect(shouldIgnore('C:\\proj\\server.log')).toBe(true);
    expect(shouldIgnore('/proj/a.tmp')).toBe(true);
    expect(shouldIgnore('/proj/pnpm-lock.lock')).toBe(true);
    expect(shouldIgnore('C:\\proj\\file.ts~')).toBe(true);
    expect(shouldIgnore('/proj/.DS_Store')).toBe(true);
    expect(shouldIgnore('C:\\proj\\Thumbs.db')).toBe(true);
    expect(shouldIgnore('C:\\proj\\CASE.LOG')).toBe(true);
  });

  it('ignores empty or separator-only paths', () => {
    expect(shouldIgnore('')).toBe(true);
    expect(shouldIgnore('///')).toBe(true);
  });

  it('keeps ordinary source files', () => {
    expect(shouldIgnore('C:\\proj\\src\\app.ts')).toBe(false);
    expect(shouldIgnore('/proj/README.md')).toBe(false);
    expect(shouldIgnore('notes.md')).toBe(false);
  });
});

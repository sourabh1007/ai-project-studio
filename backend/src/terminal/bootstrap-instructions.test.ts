import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  CUSTOM_INSTRUCTIONS_DIRS_ENV,
  INJECTING_CONTEXT_NOTICE,
  appendInstructionsDir,
  instructionsFilePath,
  withInstructionsDir,
} from './bootstrap-instructions.js';

describe('bootstrap-instructions', () => {
  it('exposes the CLI custom-instructions env var name', () => {
    expect(CUSTOM_INSTRUCTIONS_DIRS_ENV).toBe('COPILOT_CUSTOM_INSTRUCTIONS_DIRS');
  });

  it('ends the injecting notice on its own line', () => {
    expect(INJECTING_CONTEXT_NOTICE.endsWith('\r\n')).toBe(true);
  });

  describe('instructionsFilePath', () => {
    it('places the file under a per-session .github/instructions subtree', () => {
      const { dir, filePath } = instructionsFilePath('/base', 'sess-1');
      expect(dir).toBe(join('/base', 'sess-1'));
      expect(filePath).toBe(
        join('/base', 'sess-1', '.github', 'instructions', 'studio-context.instructions.md'),
      );
    });
  });

  describe('appendInstructionsDir', () => {
    it('returns the sole directory when nothing was set', () => {
      expect(appendInstructionsDir(undefined, '/a')).toBe('/a');
      expect(appendInstructionsDir('', '/a')).toBe('/a');
    });

    it('appends to an existing list preserving order', () => {
      expect(appendInstructionsDir('/a,/b', '/c')).toBe('/a,/b,/c');
    });

    it('never adds a duplicate directory', () => {
      expect(appendInstructionsDir('/a,/b', '/a')).toBe('/a,/b');
    });

    it('drops blank and whitespace-only entries', () => {
      expect(appendInstructionsDir('/a, ,,/b ', '/c')).toBe('/a,/b,/c');
    });
  });

  describe('withInstructionsDir', () => {
    it('merges the dir into the env without touching other variables', () => {
      const env = { PATH: '/usr/bin', OTHER: 'x' };
      const next = withInstructionsDir(env, '/ctx');
      expect(next).toEqual({
        PATH: '/usr/bin',
        OTHER: 'x',
        [CUSTOM_INSTRUCTIONS_DIRS_ENV]: '/ctx',
      });
      // Leaves the source env untouched.
      expect(env).not.toHaveProperty(CUSTOM_INSTRUCTIONS_DIRS_ENV);
    });

    it('appends to a pre-existing search path', () => {
      const env = { [CUSTOM_INSTRUCTIONS_DIRS_ENV]: '/existing' };
      expect(withInstructionsDir(env, '/ctx')[CUSTOM_INSTRUCTIONS_DIRS_ENV]).toBe(
        '/existing,/ctx',
      );
    });
  });
});

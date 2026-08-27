import { describe, it, expect } from 'vitest';
import { resolveGhExecutable } from './gh-executable.js';

describe('resolveGhExecutable', () => {
  it('finds gh in a well-known Windows install dir when not on PATH', () => {
    const resolved = resolveGhExecutable({
      isWindows: true,
      pathEnv: 'C:\\nowhere',
      pathExt: '.EXE',
      env: { ProgramFiles: 'C:\\Program Files' },
      fileExists: (candidate) =>
        candidate === 'C:\\Program Files\\GitHub CLI\\gh.EXE',
    });
    expect(resolved).toBe('C:\\Program Files\\GitHub CLI\\gh.EXE');
  });

  it('prefers a gh already on PATH', () => {
    const resolved = resolveGhExecutable({
      isWindows: true,
      pathEnv: 'C:\\tools',
      pathExt: '.EXE',
      env: { ProgramFiles: 'C:\\Program Files' },
      fileExists: (candidate) => candidate === 'C:\\tools\\gh.EXE',
    });
    expect(resolved).toBe('C:\\tools\\gh.EXE');
  });

  it('searches ProgramFiles(x86), WinGet Links and Programs dirs', () => {
    const resolved = resolveGhExecutable({
      isWindows: true,
      pathEnv: '',
      pathExt: '.EXE',
      env: {
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      },
      fileExists: (candidate) =>
        candidate ===
        'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\gh.EXE',
    });
    expect(resolved).toBe(
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\gh.EXE',
    );
  });

  it('falls back to the Programs\\GitHub CLI dir', () => {
    const resolved = resolveGhExecutable({
      isWindows: true,
      pathEnv: '',
      pathExt: '.EXE',
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      fileExists: (candidate) =>
        candidate ===
        'C:\\Users\\me\\AppData\\Local\\Programs\\GitHub CLI\\gh.EXE',
    });
    expect(resolved).toBe(
      'C:\\Users\\me\\AppData\\Local\\Programs\\GitHub CLI\\gh.EXE',
    );
  });

  it('returns the bare command when nothing matches (Windows, no env dirs)', () => {
    const resolved = resolveGhExecutable({
      isWindows: true,
      pathEnv: 'C:\\nowhere',
      pathExt: '.EXE',
      env: {},
      fileExists: () => false,
    });
    expect(resolved).toBe('gh');
  });

  it('finds gh in a well-known POSIX dir', () => {
    const resolved = resolveGhExecutable({
      isWindows: false,
      pathEnv: '/nowhere',
      env: {},
      fileExists: (candidate) => candidate === '/opt/homebrew/bin/gh',
    });
    expect(resolved).toBe('/opt/homebrew/bin/gh');
  });

  it('falls back to env.PATH when no pathEnv is given', () => {
    const resolved = resolveGhExecutable({
      isWindows: false,
      env: { PATH: '/custom/bin' },
      fileExists: (candidate) => candidate === '/custom/bin/gh',
    });
    expect(resolved).toBe('/custom/bin/gh');
  });

  it('treats a missing env.PATH as empty and still searches known dirs', () => {
    const resolved = resolveGhExecutable({
      isWindows: true,
      pathExt: '.EXE',
      env: { ProgramFiles: 'C:\\Program Files' },
      fileExists: (candidate) =>
        candidate === 'C:\\Program Files\\GitHub CLI\\gh.EXE',
    });
    expect(resolved).toBe('C:\\Program Files\\GitHub CLI\\gh.EXE');
  });

  it('uses process defaults for platform and env when omitted', () => {
    // Exercises the `?? process.platform` / `?? process.env` default branches.
    expect(typeof resolveGhExecutable({ fileExists: () => false })).toBe(
      'string',
    );
  });
});

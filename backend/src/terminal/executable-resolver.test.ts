import { describe, it, expect } from 'vitest';
import { resolveExecutable } from './executable-resolver.js';

describe('resolveExecutable', () => {
  it('finds a bare name on the Windows PATH applying PATHEXT', () => {
    const existing = new Set(['C:\\bin\\copilot.EXE']);
    const result = resolveExecutable('copilot', {
      isWindows: true,
      pathEnv: 'C:\\other;C:\\bin',
      pathExt: '.COM;.EXE;.CMD',
      fileExists: (p) => existing.has(p),
    });
    expect(result).toBe('C:\\bin\\copilot.EXE');
  });

  it('prefers a name that already carries its extension', () => {
    const existing = new Set(['C:\\bin\\copilot.exe']);
    const result = resolveExecutable('copilot.exe', {
      isWindows: true,
      pathEnv: 'C:\\bin',
      pathExt: '.EXE',
      fileExists: (p) => existing.has(p),
    });
    expect(result).toBe('C:\\bin\\copilot.exe');
  });

  it('resolves an absolute path with an extension applied', () => {
    const existing = new Set(['C:\\tools\\cli.CMD']);
    const result = resolveExecutable('C:\\tools\\cli', {
      isWindows: true,
      pathExt: '.CMD',
      fileExists: (p) => existing.has(p),
    });
    expect(result).toBe('C:\\tools\\cli.CMD');
  });

  it('returns the original command when nothing is found', () => {
    const result = resolveExecutable('missing', {
      isWindows: true,
      pathEnv: 'C:\\bin',
      pathExt: '.EXE',
      fileExists: () => false,
    });
    expect(result).toBe('missing');
  });

  it('resolves a bare name on a POSIX PATH without extensions', () => {
    const existing = new Set(['/usr/local/bin/agency']);
    const result = resolveExecutable('agency', {
      isWindows: false,
      pathEnv: '/usr/bin:/usr/local/bin',
      fileExists: (p) => existing.has(p),
    });
    expect(result).toBe('/usr/local/bin/agency');
  });

  it('returns an absolute POSIX path unchanged when it exists', () => {
    const result = resolveExecutable('/opt/cli', {
      isWindows: false,
      fileExists: (p) => p === '/opt/cli',
    });
    expect(result).toBe('/opt/cli');
  });

  it('handles an empty PATH by returning the command', () => {
    const result = resolveExecutable('copilot', {
      isWindows: false,
      pathEnv: '',
      fileExists: () => true,
    });
    expect(result).toBe('copilot');
  });

  it('falls back to real defaults when deps are omitted', () => {
    // Exercises the default fileExists (fs.existsSync), default isWindows
    // (process.platform) and default pathEnv (process.env.PATH). A name that
    // cannot resolve anywhere returns the original command deterministically.
    expect(resolveExecutable('copilot-workspace-missing-xyz')).toBe(
      'copilot-workspace-missing-xyz',
    );
  });

  it('falls back to default PATHEXT on Windows when pathExt is omitted', () => {
    const result = resolveExecutable('missing', {
      isWindows: true,
      pathEnv: '',
      fileExists: () => false,
    });
    expect(result).toBe('missing');
  });

  it('treats a forward-slash relative path as a path on Windows', () => {
    const existing = new Set(['rel/cli.EXE']);
    const result = resolveExecutable('rel/cli', {
      isWindows: true,
      pathExt: '.EXE',
      fileExists: (p) => existing.has(p),
    });
    expect(result).toBe('rel/cli.EXE');
  });

  it('returns a path-like command unchanged when it does not exist', () => {
    const result = resolveExecutable('/opt/missing', {
      isWindows: false,
      fileExists: () => false,
    });
    expect(result).toBe('/opt/missing');
  });

  it('uses the built-in PATHEXT default when the environment lacks one', () => {
    const original = process.env.PATHEXT;
    delete process.env.PATHEXT;
    try {
      const existing = new Set(['C:\\bin\\tool.BAT']);
      const result = resolveExecutable('tool', {
        isWindows: true,
        pathEnv: 'C:\\bin',
        fileExists: (p) => existing.has(p),
      });
      expect(result).toBe('C:\\bin\\tool.BAT');
    } finally {
      if (original === undefined) {
        delete process.env.PATHEXT;
      } else {
        process.env.PATHEXT = original;
      }
    }
  });

  it('treats an absent process PATH as empty', () => {
    const original = process.env.PATH;
    delete process.env.PATH;
    try {
      const result = resolveExecutable('missing', {
        isWindows: false,
        fileExists: () => false,
      });
      expect(result).toBe('missing');
    } finally {
      if (original === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = original;
      }
    }
  });
});

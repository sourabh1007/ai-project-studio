import { describe, expect, it, vi } from 'vitest';
import { createFilesystemEvidenceCollector } from './filesystem-evidence-adapter.js';
import type { RepositoryEvidenceCollectionRequest } from './repository-evidence-port.js';

const request: RepositoryEvidenceCollectionRequest = {
  repositoryPath: 'C:\\repo',
  prioritizedFiles: [
    'AGENTS.md',
    '.github/copilot-instructions.md',
    'CLAUDE.md',
    'README.md',
    'docs',
  ],
  ignoredDirectories: ['node_modules', 'dist'],
  maxFileBytes: 100,
  maxFileChars: 20,
  maxTreeChars: 100,
  maxContentChars: 30,
  maxEvidenceFiles: 3,
};

describe('filesystem repository evidence adapter', () => {
  it('prioritizes guidance and documentation before other tracked files', async () => {
    const sizes = new Map([
      ['AGENTS.md', 6],
      ['nested/README.rst', 6],
      ['docs/guide.md', 4],
      ['z.ts', 1],
    ]);
    const fileSystem = {
      size: vi.fn(async (path: string) => {
        const relative = path.slice('C:\\repo\\'.length).replaceAll('\\', '/');
        return sizes.get(relative) ?? 0;
      }),
      read: vi.fn(async (path: string, maxBytes: number) => {
        const relative = path.slice('C:\\repo\\'.length).replaceAll('\\', '/');
        return Buffer.from(relative).subarray(0, maxBytes);
      }),
    };
    const collector = createFilesystemEvidenceCollector({
      trackedFiles: {
        listTrackedFiles: vi
          .fn()
          .mockResolvedValue([
            'z.ts',
            'docs/guide.md',
            'nested\\README.rst',
            'AGENTS.md',
          ]),
      },
      fileSystem,
    });

    const result = await collector.collect(request);

    expect(result.files.map((file) => file.path)).toEqual([
      'AGENTS.md',
      'nested/README.rst',
      'docs/guide.md',
    ]);
    expect(result.tree).toBe(
      ['AGENTS.md', 'docs/guide.md', 'nested/README.rst', 'z.ts'].join('\n'),
    );
    expect(result.totalTrackedFileCount).toBe(4);
    expect(fileSystem.read).toHaveBeenCalledTimes(3);
  });

  it('ignores configured, absolute, and escaping paths', async () => {
    const collector = createFilesystemEvidenceCollector({
      trackedFiles: {
        listTrackedFiles: vi
          .fn()
          .mockResolvedValue([
            'src/a.ts',
            'node_modules/pkg/a.js',
            'dist/out.js',
            '../secret',
            'C:\\outside.txt',
          ]),
      },
      fileSystem: {
        size: vi.fn().mockResolvedValue(1),
        read: vi.fn().mockResolvedValue(Buffer.from('a')),
      },
    });

    const result = await collector.collect(request);

    expect(result.tree).toBe('src/a.ts');
    expect(result.files.map((file) => file.path)).toEqual(['src/a.ts']);
    expect(result.totalTrackedFileCount).toBe(1);
  });

  it('rejects empty, oversized, and binary files while bounding reads', async () => {
    const size = vi.fn(async (path: string) => {
      if (path.endsWith('empty.txt')) return 0;
      if (path.endsWith('symlink.txt')) return -1;
      if (path.endsWith('large.txt')) return 101;
      if (path.endsWith('binary.dat')) return 4;
      return 50;
    });
    const read = vi.fn(async (path: string, maxBytes: number) => {
      if (path.endsWith('binary.dat')) return Buffer.from([0, 1, 2, 3]);
      return Buffer.from('abcdefghijklmnopqrstuvwxyz').subarray(0, maxBytes);
    });
    const collector = createFilesystemEvidenceCollector({
      trackedFiles: {
        listTrackedFiles: vi
          .fn()
          .mockResolvedValue([
            'empty.txt',
            'symlink.txt',
            'large.txt',
            'binary.dat',
            'text.txt',
            'zz-later.txt',
          ]),
      },
      fileSystem: { size, read },
    });

    const result = await collector.collect({
      ...request,
      prioritizedFiles: ['missing'],
      maxContentChars: 5,
    });

    expect(result.files).toEqual([
      { path: 'text.txt', content: 'abcde', sizeBytes: 50 },
    ]);
    expect(read).toHaveBeenCalledWith('C:\\repo\\binary.dat', 4);
    expect(read).toHaveBeenCalledWith('C:\\repo\\text.txt', 5);
    expect(read).not.toHaveBeenCalledWith('C:\\repo\\large.txt', expect.anything());
    expect(size).not.toHaveBeenCalledWith('C:\\repo\\zz-later.txt');
  });

  it('rejects control-heavy binary data and propagates filesystem failures', async () => {
    const collector = createFilesystemEvidenceCollector({
      trackedFiles: {
        listTrackedFiles: vi.fn().mockResolvedValue(['binary.dat', 'failed.txt']),
      },
      fileSystem: {
        size: vi
          .fn()
          .mockResolvedValueOnce(4)
          .mockRejectedValueOnce(new Error('stat failed')),
        read: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3, 65])),
      },
    });

    await expect(collector.collect(request)).rejects.toThrow('stat failed');
  });
});

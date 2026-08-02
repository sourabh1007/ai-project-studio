import { describe, expect, it } from 'vitest';
import { repositoryContextDefaults } from './config.js';
import { buildRepositoryEvidence } from './evidence-builder.js';
import type { RepositoryEvidenceCandidate } from './repository-context-contract.js';

function candidate(
  path: string,
  content: string,
): RepositoryEvidenceCandidate {
  return { path, content, sizeBytes: Buffer.byteLength(content) };
}

describe('buildRepositoryEvidence', () => {
  it('prioritizes guidance, normalizes paths, and sorts remaining files', () => {
    const evidence = buildRepositoryEvidence(
      'abc123',
      'tree',
      [
        candidate('z.ts', 'z'),
        candidate('src\\AGENTS.md', 'nested guidance'),
        candidate('a.ts', 'a'),
        candidate('.github/copilot-instructions.md', 'copilot guidance'),
      ],
      repositoryContextDefaults,
    );

    expect(evidence.files.map((file) => file.path)).toEqual([
      'src/AGENTS.md',
      '.github/copilot-instructions.md',
      'a.ts',
      'z.ts',
    ]);
    expect(evidence.sourceRevision).toBe('abc123');
    expect(evidence.omittedFileCount).toBe(0);
    expect(evidence.largeRepository).toBe(false);
  });

  it('prioritizes README variants and nested documentation', () => {
    const evidence = buildRepositoryEvidence(
      'rev',
      '',
      [
        candidate('z.ts', 'z'),
        candidate('module/docs/guide.md', 'docs'),
        candidate('module/README.rst', 'readme'),
      ],
      repositoryContextDefaults,
    );

    expect(evidence.files.map((file) => file.path)).toEqual([
      'module/README.rst',
      'module/docs/guide.md',
      'z.ts',
    ]);
  });

  it('enforces tree, file, total-content, and file-count budgets', () => {
    const config = {
      ...repositoryContextDefaults,
      prioritizedFiles: ['README.md'],
      maxTreeChars: 4,
      maxFileChars: 5,
      maxContentChars: 7,
      maxEvidenceFiles: 2,
    };
    const evidence = buildRepositoryEvidence(
      'rev',
      '123456',
      [
        candidate('./README.md', 'abcdefgh'),
        candidate('b.ts', '123456'),
        candidate('c.ts', 'ignored'),
      ],
      config,
    );

    expect(evidence.tree).toBe('1234');
    expect(evidence.files).toEqual([
      { path: 'README.md', content: 'abcde' },
      { path: 'b.ts', content: '12' },
    ]);
    expect(evidence.totalContentChars).toBe(21);
    expect(evidence.totalFileCount).toBe(3);
    expect(evidence.omittedFileCount).toBe(1);
  });

  it('skips empty files and stops when the content budget is exhausted', () => {
    const evidence = buildRepositoryEvidence(
      'rev',
      '',
      [candidate('a.ts', ''), candidate('b.ts', 'b'), candidate('c.ts', 'c')],
      {
        ...repositoryContextDefaults,
        prioritizedFiles: ['missing'],
        maxContentChars: 1,
      },
    );

    expect(evidence.files).toEqual([{ path: 'b.ts', content: 'b' }]);
    expect(evidence.omittedFileCount).toBe(2);
  });

  it('marks repositories large by either file count or raw content size', () => {
    const candidates = [candidate('a.ts', '12345'), candidate('b.ts', '1')];
    expect(
      buildRepositoryEvidence('rev', '', candidates, {
        ...repositoryContextDefaults,
        largeRepositoryFileThreshold: 2,
        largeRepositoryContentThreshold: 100,
      }).largeRepository,
    ).toBe(true);
    expect(
      buildRepositoryEvidence('rev', '', candidates, {
        ...repositoryContextDefaults,
        largeRepositoryFileThreshold: 100,
        largeRepositoryContentThreshold: 6,
      }).largeRepository,
    ).toBe(true);
  });
});

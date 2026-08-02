import { describe, expect, it, vi } from 'vitest';
import { repositoryContextDefaults } from './config.js';
import {
  createRepositoryContextGenerator,
  groupRepositoryEvidence,
} from './repository-context-generator.js';
import type { RepositoryEvidence } from './repository-context-contract.js';

function evidence(largeRepository: boolean): RepositoryEvidence {
  return {
    sourceRevision: 'revision',
    tree: ['README.md', 'backend/src/main.ts', 'ui/src/main.ts'].join('\n'),
    files: [
      { path: 'README.md', content: 'root evidence' },
      { path: 'backend/src/main.ts', content: 'backend evidence' },
      { path: 'ui/src/main.ts', content: 'ui evidence' },
    ],
    totalFileCount: 3,
    omittedFileCount: 0,
    totalContentChars: 40,
    largeRepository,
  };
}

describe('repository context generator', () => {
  it('uses one analysis pass for a small repository', async () => {
    const execute = vi.fn().mockResolvedValue('  repository summary  ');
    const generator = createRepositoryContextGenerator({
      executor: { execute },
      config: repositoryContextDefaults,
    });

    await expect(
      generator.generate({
        repositoryId: 'repo-1',
        repositoryPath: 'C:\\repo',
        evidence: evidence(false),
      }),
    ).resolves.toEqual({ content: 'repository summary' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: 'repo-1',
        repositoryPath: 'C:\\repo',
        maxOutputChars: repositoryContextDefaults.maxOutputChars,
        prompt: expect.stringContaining('BEGIN UNTRUSTED REPOSITORY FILE'),
      }),
    );
  });

  it('groups large repositories by top-level module and synthesizes summaries', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce('root summary')
      .mockResolvedValueOnce('backend summary')
      .mockResolvedValueOnce('ui summary')
      .mockResolvedValueOnce('final summary');
    const generator = createRepositoryContextGenerator({
      executor: { execute },
      config: repositoryContextDefaults,
    });

    await expect(
      generator.generate({
        repositoryId: 'repo-1',
        repositoryPath: 'C:\\repo',
        evidence: evidence(true),
      }),
    ).resolves.toEqual({ content: 'final summary' });

    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls[0][0].prompt).toContain('Section: root');
    expect(execute.mock.calls[1][0].prompt).toContain('Section: backend');
    expect(execute.mock.calls[2][0].prompt).toContain('Section: ui');
    expect(execute.mock.calls[3][0].prompt).toContain('root summary');
    expect(execute.mock.calls[3][0].prompt).toContain('backend summary');
    expect(execute.mock.calls[3][0].prompt).toContain('ui summary');
  });

  it('caps deterministic groups and evidence characters', () => {
    const chunks = groupRepositoryEvidence(evidence(true), {
      ...repositoryContextDefaults,
      maxChunks: 2,
      maxChunkChars: 12,
    });

    expect(chunks.map((chunk) => chunk.label)).toEqual(['root', 'backend']);
    for (const chunk of chunks) {
      expect(
        chunk.tree.length +
          chunk.files.reduce((total, file) => total + file.content.length, 0),
      ).toBeLessThanOrEqual(12);
    }
  });

  it('drops empty groups and stops adding files when a chunk is full', () => {
    const chunks = groupRepositoryEvidence(
      {
        ...evidence(true),
        tree: '',
        files: [
          { path: 'z/empty.ts', content: '' },
          { path: 'a/one.ts', content: 'a' },
          { path: 'a/two.ts', content: 'b' },
        ],
      },
      {
        ...repositoryContextDefaults,
        maxChunkChars: 1,
      },
    );

    expect(chunks).toEqual([
      {
        label: 'a',
        tree: '',
        files: [{ path: 'a/one.ts', content: 'a' }],
      },
    ]);
  });

  it('rejects empty output and large repositories without analyzable evidence', async () => {
    const generator = createRepositoryContextGenerator({
      executor: { execute: vi.fn().mockResolvedValue('   ') },
      config: repositoryContextDefaults,
    });
    await expect(
      generator.generate({
        repositoryId: 'repo',
        repositoryPath: 'path',
        evidence: evidence(false),
      }),
    ).rejects.toThrow('returned no content');

    await expect(
      generator.generate({
        repositoryId: 'repo',
        repositoryPath: 'path',
        evidence: {
          ...evidence(true),
          tree: '',
          files: [],
        },
      }),
    ).rejects.toThrow('no analyzable evidence');
  });

  it('wraps a failed chunk analysis with its section label and stops', async () => {
    const failure = new Error('provider failed');
    const execute = vi.fn().mockRejectedValue(failure);
    const generator = createRepositoryContextGenerator({
      executor: { execute },
      config: repositoryContextDefaults,
    });

    await expect(
      generator.generate({
        repositoryId: 'repo',
        repositoryPath: 'path',
        evidence: evidence(true),
      }),
    ).rejects.toThrow('Section "root" analysis failed: provider failed');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('wraps a non-Error chunk failure with a stringified detail', async () => {
    const execute = vi.fn().mockRejectedValue('boom');
    const generator = createRepositoryContextGenerator({
      executor: { execute },
      config: repositoryContextDefaults,
    });

    await expect(
      generator.generate({
        repositoryId: 'repo',
        repositoryPath: 'path',
        evidence: evidence(true),
      }),
    ).rejects.toThrow('Section "root" analysis failed: boom');
  });

  it('reports progress for a single-pass analysis', async () => {
    const generator = createRepositoryContextGenerator({
      executor: { execute: vi.fn().mockResolvedValue('summary') },
      config: repositoryContextDefaults,
    });
    const progress: string[] = [];
    await generator.generate(
      {
        repositoryId: 'repo',
        repositoryPath: 'path',
        evidence: evidence(false),
      },
      (detail) => progress.push(detail),
    );
    expect(progress).toEqual(['Analyzing repository evidence']);
  });

  it('reports per-section and synthesis progress for a large repository', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce('root summary')
      .mockResolvedValueOnce('backend summary')
      .mockResolvedValueOnce('ui summary')
      .mockResolvedValueOnce('final summary');
    const generator = createRepositoryContextGenerator({
      executor: { execute },
      config: repositoryContextDefaults,
    });
    const progress: string[] = [];
    await generator.generate(
      {
        repositoryId: 'repo',
        repositoryPath: 'path',
        evidence: evidence(true),
      },
      (detail) => progress.push(detail),
    );
    expect(progress).toEqual([
      'Summarizing section 1 of 3: root',
      'Summarizing section 2 of 3: backend',
      'Summarizing section 3 of 3: ui',
      'Synthesizing 3 sections',
    ]);
  });
});

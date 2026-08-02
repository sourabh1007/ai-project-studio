import { describe, expect, it, vi } from 'vitest';
import { repositoryContextDefaults } from './config.js';
import { createRepositoryEvidenceService } from './repository-evidence-service.js';

describe('repository evidence service', () => {
  it('collects revision and bounded filesystem evidence into the domain model', async () => {
    const collect = vi.fn().mockResolvedValue({
      tree: 'a.ts',
      files: [{ path: 'a.ts', content: 'a', sizeBytes: 1 }],
      totalTrackedFileCount: 2500,
    });
    const service = createRepositoryEvidenceService({
      revisionLookup: { getRevision: vi.fn().mockResolvedValue('revision') },
      collector: { collect },
      config: repositoryContextDefaults,
    });

    const evidence = await service.collect('C:\\repo');

    expect(collect).toHaveBeenCalledWith({
      repositoryPath: 'C:\\repo',
      prioritizedFiles: repositoryContextDefaults.prioritizedFiles,
      ignoredDirectories: repositoryContextDefaults.ignoredDirectories,
      maxFileBytes: repositoryContextDefaults.maxFileBytes,
      maxFileChars: repositoryContextDefaults.maxFileChars,
      maxTreeChars: repositoryContextDefaults.maxTreeChars,
      maxContentChars: repositoryContextDefaults.maxContentChars,
      maxEvidenceFiles: repositoryContextDefaults.maxEvidenceFiles,
    });
    expect(evidence).toMatchObject({
      sourceRevision: 'revision',
      totalFileCount: 2500,
      omittedFileCount: 2499,
      largeRepository: true,
    });
  });

  it('propagates collection failures', async () => {
    const failure = new Error('collection failed');
    const service = createRepositoryEvidenceService({
      revisionLookup: { getRevision: vi.fn().mockResolvedValue('revision') },
      collector: { collect: vi.fn().mockRejectedValue(failure) },
      config: repositoryContextDefaults,
    });

    await expect(service.collect('repo')).rejects.toBe(failure);
  });
});

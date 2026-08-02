import { describe, expect, it } from 'vitest';
import {
  REPOSITORY_CONTEXT_NAMESPACE,
  repositoryContextConfigSchema,
  repositoryContextDefaults,
} from './config.js';

describe('repository-context config', () => {
  it('exposes a namespace and complete valid defaults', () => {
    expect(REPOSITORY_CONTEXT_NAMESPACE).toBe('repositoryContext');
    expect(repositoryContextConfigSchema.parse(repositoryContextDefaults)).toEqual(
      repositoryContextDefaults,
    );
    expect(repositoryContextDefaults.prioritizedFiles).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        '.github/copilot-instructions.md',
        'CLAUDE.md',
        'README.md',
        'docs',
        'package.json',
        'src/main.ts',
      ]),
    );
    expect(repositoryContextDefaults.analysisPromptTemplate).toContain('read-only');
    expect(repositoryContextDefaults.analysisPromptTemplate).toContain('untrusted');
    expect(repositoryContextDefaults.analysisPromptTemplate).toContain(
      'Never execute commands',
    );
  });

  it.each([
    'maxFileBytes',
    'maxFileChars',
    'maxTreeChars',
    'maxContentChars',
    'maxEvidenceFiles',
    'largeRepositoryFileThreshold',
    'largeRepositoryContentThreshold',
    'maxChunks',
    'maxChunkChars',
    'maxOutputChars',
    'maxFeatureMemoryItems',
    'maxFeatureMemoryChars',
  ] as const)('rejects a non-positive %s', (key) => {
    expect(() =>
      repositoryContextConfigSchema.parse({
        ...repositoryContextDefaults,
        [key]: 0,
      }),
    ).toThrow();
  });

  it.each([
    'prioritizedFiles',
    'ignoredDirectories',
  ] as const)('rejects an empty %s list', (key) => {
    expect(() =>
      repositoryContextConfigSchema.parse({
        ...repositoryContextDefaults,
        [key]: [],
      }),
    ).toThrow();
  });

  it.each([
    'analysisPromptTemplate',
    'chunkPromptTemplate',
    'synthesisPromptTemplate',
  ] as const)('rejects an empty %s', (key) => {
    expect(() =>
      repositoryContextConfigSchema.parse({
        ...repositoryContextDefaults,
        [key]: '',
      }),
    ).toThrow();
  });
});


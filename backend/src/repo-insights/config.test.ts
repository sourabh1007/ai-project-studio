import { describe, expect, it } from 'vitest';
import {
  REPO_INSIGHTS_NAMESPACE,
  repoInsightsConfigSchema,
  repoInsightsDefaults,
} from './config.js';

describe('repo-insights config', () => {
  it('exposes a namespace and complete valid defaults', () => {
    expect(REPO_INSIGHTS_NAMESPACE).toBe('repoInsights');
    expect(repoInsightsConfigSchema.parse(repoInsightsDefaults)).toEqual(
      repoInsightsDefaults,
    );
    expect(repoInsightsDefaults.readinessChecks.map((check) => check.key)).toEqual(
      ['agent-instructions', 'custom-agent'],
    );
  });

  it.each([
    'agentsDirectories',
    'skillsDirectories',
    'docsDirectories',
  ] as const)('rejects an empty %s array', (key) => {
    expect(() =>
      repoInsightsConfigSchema.parse({ ...repoInsightsDefaults, [key]: [] }),
    ).toThrow();
  });

  it.each(['agentsDirectories', 'skillsDirectories', 'docsDirectories'] as const)(
    'rejects a blank entry in %s',
    (key) => {
      expect(() =>
        repoInsightsConfigSchema.parse({ ...repoInsightsDefaults, [key]: [''] }),
      ).toThrow();
    },
  );

  it('rejects an empty definitionExtension', () => {
    expect(() =>
      repoInsightsConfigSchema.parse({
        ...repoInsightsDefaults,
        definitionExtension: '',
      }),
    ).toThrow();
  });

  it('rejects a non-boolean recursiveScan', () => {
    expect(() =>
      repoInsightsConfigSchema.parse({
        ...repoInsightsDefaults,
        recursiveScan: 'yes',
      }),
    ).toThrow();
  });

  it('rejects a non-positive maxDescriptionChars', () => {
    expect(() =>
      repoInsightsConfigSchema.parse({
        ...repoInsightsDefaults,
        maxDescriptionChars: 0,
      }),
    ).toThrow();
  });

  it('rejects an empty readiness checklist', () => {
    expect(() =>
      repoInsightsConfigSchema.parse({
        ...repoInsightsDefaults,
        readinessChecks: [],
      }),
    ).toThrow();
  });

  it('rejects an unknown readiness requirement kind', () => {
    expect(() =>
      repoInsightsConfigSchema.parse({
        ...repoInsightsDefaults,
        readinessChecks: [
          {
            key: 'x',
            label: 'X',
            requirement: 'nope',
            test: { kind: 'somethingElse', paths: ['a'] },
          },
        ],
      }),
    ).toThrow();
  });

  it('accepts an anyDefinitionUnder requirement', () => {
    const parsed = repoInsightsConfigSchema.parse({
      ...repoInsightsDefaults,
      readinessChecks: [
        {
          key: 'x',
          label: 'X',
          requirement: 'dir has a definition',
          test: { kind: 'anyDefinitionUnder', directory: 'agents' },
        },
      ],
    });
    expect(parsed.readinessChecks[0].test).toEqual({
      kind: 'anyDefinitionUnder',
      directory: 'agents',
    });
  });
});

import { describe, expect, it } from 'vitest';

import type { Command } from '../command-palette.js';
import { fuzzyScore } from '../command-palette.js';
import { buildCommandBarResults } from './results.js';

describe('buildCommandBarResults', () => {
  const commands: Command[] = [
    { id: 'workspace', title: 'Open Workspace', keywords: ['files'] },
    { id: 'review', title: 'Review PR' },
    { id: 'usage', title: 'Show Usage' },
  ];

  it('returns no rows for empty or whitespace-only input', () => {
    expect(buildCommandBarResults('', commands)).toEqual([]);
    expect(buildCommandBarResults('   ', commands)).toEqual([]);
  });

  it('returns fuzzy-ranked command rows for plain command queries', () => {
    expect(buildCommandBarResults('  usage  ', commands)).toEqual([
      {
        kind: 'command',
        command: commands[2],
        score: fuzzyScore('show usage', 'usage'),
      },
    ]);
  });

  it('matches commands through command-palette keywords and keeps scores', () => {
    expect(buildCommandBarResults('files', commands)).toEqual([
      {
        kind: 'command',
        command: commands[0],
        score: fuzzyScore('open workspace files', 'files'),
      },
    ]);
  });

  it('puts an AI-intent row before fuzzy command matches', () => {
    expect(buildCommandBarResults('Review PR', commands)).toEqual([
      {
        kind: 'ai',
        intent: 'review-pr',
        label: 'Review PR',
        argument: '',
        query: 'Review PR',
      },
      {
        kind: 'command',
        command: commands[1],
        score: fuzzyScore('review pr', 'review pr'),
      },
    ]);
  });

  it('preserves a trimmed AI argument and query casing', () => {
    expect(buildCommandBarResults('  explain    ui/src/App.tsx  ', commands)).toEqual([
      {
        kind: 'ai',
        intent: 'explain-file',
        label: 'Explain file',
        argument: 'ui/src/App.tsx',
        query: 'explain    ui/src/App.tsx',
      },
    ]);
  });

  it('limits the unified list across AI and command rows', () => {
    expect(buildCommandBarResults('Review PR', commands, { limit: 1 })).toEqual([
      {
        kind: 'ai',
        intent: 'review-pr',
        label: 'Review PR',
        argument: '',
        query: 'Review PR',
      },
    ]);
  });

  it('returns no rows when the limit is zero or lower', () => {
    expect(buildCommandBarResults('usage', commands, { limit: 0 })).toEqual([]);
    expect(buildCommandBarResults('usage', commands, { limit: -1 })).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  AI_INTENT_TRIGGERS,
  aiIntentLabel,
  parseCommandInput,
  type AiIntent,
} from './intent.js';

if (process.env.VITEST_POOL_ID === '1' && process.env.VITEST_WORKER_ID === '1') {
  await Promise.all([
    import('../activity.test.js'),
    import('../api-base.test.js'),
    import('../api.test.js'),
    import('../automation-view.test.js'),
    import('../change-graph-layout.test.js'),
    import('../change-graph-worker-protocol.test.js'),
    import('../command-palette.test.js'),
    import('../connection-status.test.js'),
    import('../credential-storage.test.js'),
    import('../diagnostics.test.js'),
    import('../diff-lines.test.js'),
    import('../disposer.test.js'),
    import('../draft-store.test.js'),
    import('../error-model.test.js'),
    import('../failure-log.test.js'),
    import('../feature-color.test.js'),
    import('../format.test.js'),
    import('../graph/graph-model.test.js'),
    import('../graph/layered-layout.test.js'),
    import('../graph/node-ai-actions.test.js'),
    import('../graph/react-flow-adapter.test.js'),
    import('../keyboard-shortcuts.test.js'),
    import('../markdown.test.js'),
    import('../network-activity.test.js'),
    import('../persisted-state.test.js'),
    import('../progress-stages.test.js'),
    import('../search/search-index.test.js'),
    import('../session-names.test.js'),
    import('../session-status.test.js'),
    import('../stream.test.js'),
    import('../task-progress.test.js'),
    import('../terminal-protocol.test.js'),
    import('../terminal-url.test.js'),
    import('../test-method-diff.test.js'),
    import('../theme.test.js'),
    import('../update-state.test.js'),
    import('../usage-tree.test.js'),
    import('../virtual-window.test.js'),
  ]);
}

describe('parseCommandInput', () => {
  it('returns an empty command result for empty and whitespace-only input', () => {
    expect(parseCommandInput('')).toEqual({ kind: 'command', query: '' });
    expect(parseCommandInput('   \t  ')).toEqual({ kind: 'command', query: '' });
  });

  it.each([
    ['explain src/App.tsx', 'explain-file', 'src/App.tsx'],
    ['analyze repo packages', 'analyze-repo', 'packages'],
    ['review pr 123', 'review-pr', '123'],
    ['find dependency react', 'find-dependency', 'react'],
    ['find dep vite', 'find-dependency', 'vite'],
    ['find lodash', 'find-dependency', 'lodash'],
    ['show usage today', 'show-usage', 'today'],
    ['find tests command bar', 'find-tests', 'command bar'],
    ['show tests parser', 'find-tests', 'parser'],
    ['investigate crash on launch', 'investigate-issue', 'crash on launch'],
  ] satisfies Array<[string, AiIntent, string]>) (
    'parses %s as %s with its argument',
    (raw, intent, argument) => {
      expect(parseCommandInput(raw)).toEqual({
        kind: 'ai',
        intent,
        argument,
        query: raw,
      });
    },
  );

  it('matches triggers case-insensitively while preserving original query casing', () => {
    expect(parseCommandInput('  ReViEw PR Add caching  ')).toEqual({
      kind: 'ai',
      intent: 'review-pr',
      argument: 'Add caching',
      query: 'ReViEw PR Add caching',
    });
  });

  it('trims the argument after a recognized trigger', () => {
    expect(parseCommandInput('explain    backend/src/main.ts')).toEqual({
      kind: 'ai',
      intent: 'explain-file',
      argument: 'backend/src/main.ts',
      query: 'explain    backend/src/main.ts',
    });
  });

  it('allows a trigger without an argument', () => {
    expect(parseCommandInput('investigate')).toEqual({
      kind: 'ai',
      intent: 'investigate-issue',
      argument: '',
      query: 'investigate',
    });
  });

  it('uses longest trigger precedence before shorter trigger phrases', () => {
    expect(parseCommandInput('find dependency react')).toEqual({
      kind: 'ai',
      intent: 'find-dependency',
      argument: 'react',
      query: 'find dependency react',
    });
    expect(parseCommandInput('find tests command-bar')).toEqual({
      kind: 'ai',
      intent: 'find-tests',
      argument: 'command-bar',
      query: 'find tests command-bar',
    });
  });

  it('does not match trigger text inside a longer leading word', () => {
    expect(parseCommandInput('explainer foo')).toEqual({
      kind: 'command',
      query: 'explainer foo',
    });
  });

  it('returns a command result for input without a recognized trigger', () => {
    expect(parseCommandInput('  open settings  ')).toEqual({
      kind: 'command',
      query: 'open settings',
    });
  });

  it('exports readonly trigger definitions for callers that need discoverability', () => {
    expect(AI_INTENT_TRIGGERS).toContainEqual({
      phrase: 'find dependency',
      intent: 'find-dependency',
    });
  });
});

describe('aiIntentLabel', () => {
  it.each([
    ['explain-file', 'Explain file'],
    ['analyze-repo', 'Analyze repo'],
    ['review-pr', 'Review PR'],
    ['find-dependency', 'Find dependency'],
    ['show-usage', 'Show usage'],
    ['find-tests', 'Find tests'],
    ['investigate-issue', 'Investigate issue'],
  ] satisfies Array<[AiIntent, string]>)('labels %s', (intent, label) => {
    expect(aiIntentLabel(intent)).toBe(label);
  });
});

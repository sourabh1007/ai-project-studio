import { describe, expect, it } from 'vitest';
import {
  detectIntent,
  detectPullNumber,
  startsWithActionVerb,
} from './planner-detect';

describe('detectPullNumber', () => {
  it('reads a GitHub pull URL', () => {
    expect(detectPullNumber('review https://github.com/o/r/pull/123')).toBe(123);
  });

  it('reads an Azure DevOps pullrequest URL', () => {
    expect(
      detectPullNumber('https://dev.azure.com/o/p/_git/r/pullrequest/42 please'),
    ).toBe(42);
  });

  it('reads a labelled PR reference', () => {
    expect(detectPullNumber('Review PR 7')).toBe(7);
    expect(detectPullNumber('look at pull request #88')).toBe(88);
    expect(detectPullNumber('merge request 15')).toBe(15);
  });

  it('reads a bare hash reference', () => {
    expect(detectPullNumber('check #256 before merge')).toBe(256);
    expect(detectPullNumber('#9')).toBe(9);
  });

  it('ignores incidental numbers', () => {
    expect(detectPullNumber('ship the 2026 roadmap')).toBeNull();
    expect(detectPullNumber('fix bug in v2 parser')).toBeNull();
  });

  it('returns null for blank input', () => {
    expect(detectPullNumber('   ')).toBeNull();
  });
});

describe('startsWithActionVerb', () => {
  it('detects an imperative opening verb', () => {
    expect(startsWithActionVerb('Fix the login bug')).toBe(true);
    expect(startsWithActionVerb('  implement caching')).toBe(true);
    expect(startsWithActionVerb('Refactor: the parser')).toBe(true);
  });

  it('is false for non-actionable text', () => {
    expect(startsWithActionVerb('login bug notes')).toBe(false);
    expect(startsWithActionVerb('')).toBe(false);
  });
});

describe('detectIntent', () => {
  it('prefers review when a PR is named', () => {
    expect(detectIntent('Review PR #42')).toEqual({
      primary: 'review',
      pullNumber: 42,
    });
  });

  it('chooses the agent for actionable work', () => {
    expect(detectIntent('Implement the settings page')).toEqual({
      primary: 'agent',
      pullNumber: null,
    });
  });

  it('defaults to a session otherwise', () => {
    expect(detectIntent('scratch notes about auth')).toEqual({
      primary: 'session',
      pullNumber: null,
    });
  });
});

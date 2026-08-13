import { describe, expect, it } from 'vitest';
import { summarizeStages, type ProgressStage } from './progress-stages.js';

const stage = (
  id: string,
  status: ProgressStage['status'],
): ProgressStage => ({ id, label: `Stage ${id}`, status });

describe('summarizeStages', () => {
  it('returns an idle summary for no stages', () => {
    expect(summarizeStages([])).toEqual({
      total: 0,
      done: 0,
      active: 0,
      failed: 0,
      percent: 0,
      state: 'idle',
      currentIndex: null,
      currentLabel: null,
      headline: 'No stages',
    });
  });

  it('is idle when every stage is pending', () => {
    const summary = summarizeStages([stage('a', 'pending'), stage('b', 'pending')]);
    expect(summary.state).toBe('idle');
    expect(summary.percent).toBe(0);
    expect(summary.currentIndex).toBe(1);
    expect(summary.currentLabel).toBe('Stage a');
    expect(summary.headline).toBe('Waiting to start');
  });

  it('is running with the active stage as current', () => {
    const summary = summarizeStages([
      stage('a', 'done'),
      stage('b', 'active'),
      stage('c', 'pending'),
    ]);
    expect(summary.state).toBe('running');
    expect(summary.done).toBe(1);
    expect(summary.active).toBe(1);
    expect(summary.percent).toBe(33);
    expect(summary.currentIndex).toBe(2);
    expect(summary.headline).toBe('Stage 2 of 3: Stage b');
  });

  it('treats "some done, rest pending" (no active) as running', () => {
    const summary = summarizeStages([stage('a', 'done'), stage('b', 'pending')]);
    expect(summary.state).toBe('running');
    expect(summary.currentIndex).toBe(2);
    expect(summary.headline).toBe('Stage 2 of 2: Stage b');
  });

  it('is complete when every stage is done', () => {
    const summary = summarizeStages([stage('a', 'done'), stage('b', 'done')]);
    expect(summary.state).toBe('complete');
    expect(summary.percent).toBe(100);
    expect(summary.currentIndex).toBeNull();
    expect(summary.currentLabel).toBeNull();
    expect(summary.headline).toBe('Complete');
  });

  it('is failed when a stage failed and nothing is active or done', () => {
    const summary = summarizeStages([
      stage('a', 'failed'),
      stage('b', 'pending'),
    ]);
    expect(summary.state).toBe('failed');
    expect(summary.failed).toBe(1);
    expect(summary.currentIndex).toBe(1);
    expect(summary.headline).toBe('Failed: Stage a');
  });

  it('prefers an active stage over a failed one for "current"', () => {
    const summary = summarizeStages([
      stage('a', 'failed'),
      stage('b', 'active'),
    ]);
    expect(summary.state).toBe('running');
    expect(summary.currentIndex).toBe(2);
    expect(summary.currentLabel).toBe('Stage b');
  });

  it('stays running when a later stage failed but an earlier one is done', () => {
    const summary = summarizeStages([
      stage('a', 'done'),
      stage('b', 'failed'),
    ]);
    expect(summary.state).toBe('running');
    // No active/pending, so the failed stage is current.
    expect(summary.currentIndex).toBe(2);
    expect(summary.headline).toBe('Stage 2 of 2: Stage b');
  });
});

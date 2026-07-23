import { describe, expect, it } from 'vitest';
import { workSummarySessionTitle } from './work-summary.js';
import type { SessionWorkSummary } from '../../lib/types.js';

function session(overrides: Partial<SessionWorkSummary> = {}): SessionWorkSummary {
  return {
    sessionId: 's1',
    prompt: '',
    status: 'completed',
    createdAt: '2024-01-01T00:00:00Z',
    summary: null,
    checkpoints: [],
    ...overrides,
  };
}

describe('workSummarySessionTitle', () => {
  it('uses the prompt when present', () => {
    expect(workSummarySessionTitle(session({ prompt: 'Build login' }), 0)).toBe(
      'Build login',
    );
  });

  it('falls back to a session label when the prompt is empty', () => {
    expect(workSummarySessionTitle(session(), 0)).toBe('Session #1');
  });
});

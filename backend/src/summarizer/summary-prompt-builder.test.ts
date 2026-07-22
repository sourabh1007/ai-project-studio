import { describe, it, expect } from 'vitest';
import { buildSummaryPrompt } from './summary-prompt-builder.js';
import { summarizerDefaults } from './config.js';
import type { Feature } from '../feature/feature-contract.js';
import type { Session } from '../session/session-contract.js';
import type { Transcript } from '../session/transcript-capture.js';
import type {
  FeatureTranscripts,
  SessionTranscript,
} from './summarizer-contract.js';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'f1',
    name: 'Login',
    description: 'Add login',
    createdAt: '2025-01-01T00:00:00.000Z',
    summary: null,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    featureId: 'f1',
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5.4-mini',
    status: 'completed',
    kind: 'dev',
    prompt: 'do the thing',
    usageFilePath: 'u.jsonl',
    createdAt: '2025-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    exitCode: 0,
    ...overrides,
  };
}

function transcript(stdout: string[]): Transcript {
  return { sessionId: 's1', stdout, stderr: [], exitCode: 0 };
}

function collected(sessions: SessionTranscript[]): FeatureTranscripts {
  return { feature: feature(), sessions };
}

describe('buildSummaryPrompt', () => {
  const config = summarizerDefaults;

  it('renders the no-sessions placeholder when empty', () => {
    const prompt = buildSummaryPrompt(collected([]), config);
    expect(prompt).toContain(config.noSessionsPlaceholder);
    expect(prompt).toContain('Login');
    expect(prompt).toContain('Add login');
  });

  it('renders resolved model and captured output', () => {
    const prompt = buildSummaryPrompt(
      collected([
        { session: session(), transcript: transcript(['built it']) },
      ]),
      config,
    );
    expect(prompt).toContain('gpt-5.4-mini');
    expect(prompt).toContain('built it');
    expect(prompt).toContain('Session 1');
  });

  it('falls back to requested model and empty-output placeholder', () => {
    const prompt = buildSummaryPrompt(
      collected([
        {
          session: session({ resolvedModel: null }),
          transcript: null,
        },
      ]),
      config,
    );
    expect(prompt).toContain('auto');
    expect(prompt).toContain(config.emptyOutputPlaceholder);
  });

  it('truncates output beyond the configured cap', () => {
    const long = 'x'.repeat(config.maxOutputCharsPerSession + 50);
    const prompt = buildSummaryPrompt(
      collected([{ session: session(), transcript: transcript([long]) }]),
      config,
    );
    expect(prompt).toContain('x'.repeat(config.maxOutputCharsPerSession));
    expect(prompt).not.toContain(
      'x'.repeat(config.maxOutputCharsPerSession + 1),
    );
  });

  it('joins multiple sessions with the configured separator', () => {
    const prompt = buildSummaryPrompt(
      collected([
        { session: session({ id: 's1' }), transcript: transcript(['a']) },
        { session: session({ id: 's2' }), transcript: transcript(['b']) },
      ]),
      config,
    );
    expect(prompt).toContain(config.sessionSeparator.trim());
    expect(prompt).toContain('Session 2');
  });
});

import { describe, it, expect } from 'vitest';
import { createTranscriptCollector } from './transcript-collector.js';
import { summarizerDefaults } from './config.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { Feature } from '../feature/feature-contract.js';
import type { Session } from '../session/session-contract.js';
import type { Transcript } from '../session/transcript-capture.js';

const feature: Feature = {
  id: 'f1',
  name: 'Login',
  description: 'Add login',
  createdAt: '2025-01-01T00:00:00.000Z',
  summary: null,
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    featureId: 'f1',
    name: null,
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'completed',
    kind: 'dev',
    prompt: 'p',
    usageFilePath: 'u.jsonl',
    createdAt: '2025-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    exitCode: 0,
    ...overrides,
  };
}

function harness(sessions: Session[], transcripts: Record<string, Transcript>) {
  const features = {
    get: () => feature,
  } as unknown as FeatureService;
  const repo = {
    listByFeature: () => sessions,
  } as unknown as SessionRepo;
  const store: TranscriptStore = {
    save: async () => undefined,
    load: async (id: string) => transcripts[id] ?? null,
    delete: async () => undefined,
  };
  return createTranscriptCollector({
    features,
    sessions: repo,
    transcripts: store,
    config: summarizerDefaults,
  });
}

describe('transcript-collector', () => {
  it('collects eligible sessions with their transcripts', async () => {
    const dev = session({ id: 's1', kind: 'dev' });
    const collector = harness([dev], {
      s1: { sessionId: 's1', stdout: ['x'], stderr: [], exitCode: 0 },
    });
    const result = await collector.collect('f1');
    expect(result.feature).toBe(feature);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].transcript?.stdout).toEqual(['x']);
  });

  it('excludes sessions whose kind is not a source kind', async () => {
    const collector = harness(
      [session({ id: 's1', kind: 'dev' }), session({ id: 's2', kind: 'meta' })],
      {},
    );
    const result = await collector.collect('f1');
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].session.id).toBe('s1');
    expect(result.sessions[0].transcript).toBeNull();
  });
});

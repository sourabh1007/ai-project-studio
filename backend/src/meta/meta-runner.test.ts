import { describe, it, expect } from 'vitest';
import { createMetaRunner } from './meta-runner.js';
import { metaDefaults } from './config.js';
import type {
  LaunchedSession,
  SessionLauncher,
} from '../session/session-launcher.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { Session, StartSessionRequest } from '../session/session-contract.js';
import type { Transcript } from '../session/transcript-capture.js';
import type { RunningSession } from '../provider/provider-contract.js';

const metaSession: Session = {
  id: 'meta1',
  featureId: 'f1',
  name: null,
  provider: 'agency',
  requestedModel: 'auto',
  resolvedModel: null,
  status: 'completed',
  kind: 'meta',
  prompt: 'p',
  usageFilePath: 'u',
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  endedAt: null,
  exitCode: 0,
};

function harness(transcript: Transcript | null) {
  const requests: StartSessionRequest[] = [];
  const launcher: SessionLauncher = {
    start: async (request) => {
      requests.push(request);
      const launched: LaunchedSession = {
        session: metaSession,
        running: {} as unknown as RunningSession,
        completion: Promise.resolve(metaSession),
      };
      return launched;
    },
  };
  const transcripts: TranscriptStore = {
    save: async () => undefined,
    load: async () => transcript,
    delete: async () => undefined,
  };
  const runner = createMetaRunner({
    launcher,
    transcripts,
    config: metaDefaults,
  });
  return { runner, requests };
}

describe('meta-runner', () => {
  it('launches a meta session and returns the extracted response', async () => {
    const h = harness({
      sessionId: 'meta1',
      stdout: [JSON.stringify({ response: 'the answer' })],
      stderr: [],
      exitCode: 0,
    });

    const result = await h.runner.run({ featureId: 'f1', prompt: 'do it' });

    expect(result).toBe('the answer');
    expect(h.requests[0]).toMatchObject({
      featureId: 'f1',
      providerId: metaDefaults.providerId,
      model: metaDefaults.model,
      prompt: 'do it',
      kind: 'meta',
    });
  });

  it('returns an empty string when the meta session captured nothing', async () => {
    const h = harness(null);
    expect(await h.runner.run({ featureId: 'f1', prompt: 'do it' })).toBe('');
  });
});

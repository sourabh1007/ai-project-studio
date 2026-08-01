import { describe, it, expect } from 'vitest';
import { createSummaryRunner } from './summary-runner.js';
import { summarizerDefaults } from './config.js';
import { createClock } from '../kernel/clock.js';
import type { TranscriptCollector } from './transcript-collector.js';
import type { SummaryStore } from './summary-store-port.js';
import type { FeatureSummary } from './summarizer-contract.js';
import type {
  LaunchedSession,
  SessionLauncher,
} from '../session/session-launcher.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { Feature } from '../feature/feature-contract.js';
import type { Session } from '../session/session-contract.js';
import type { StartSessionRequest } from '../session/session-contract.js';
import type { Transcript } from '../session/transcript-capture.js';
import type { RunningSession } from '../provider/provider-contract.js';

const feature: Feature = {
  id: 'f1',
  name: 'Login',
  description: 'Add login',
  createdAt: '2025-01-01T00:00:00.000Z',
  summary: null,
};

const metaSession: Session = {
  id: 'meta1',
  featureId: 'f1',
  name: null,
  provider: 'copilot',
  requestedModel: 'auto',
  resolvedModel: 'gpt-5.4-mini',
  status: 'completed',
  kind: 'meta',
  prompt: 'built prompt',
  usageFilePath: 'u.jsonl',
  createdAt: '2025-01-01T00:00:00.000Z',
  startedAt: '2025-01-01T00:00:01.000Z',
  endedAt: '2025-01-01T00:00:02.000Z',
  exitCode: 0,
};

function harness(transcript: Transcript | null) {
  const requests: StartSessionRequest[] = [];
  const attached: Array<{ id: string; summary: string }> = [];
  const savedSummaries: FeatureSummary[] = [];

  const collector: TranscriptCollector = {
    collect: async () => ({ feature, sessions: [] }),
  };
  const running = { sessionId: 'meta1' } as unknown as RunningSession;
  const launcher: SessionLauncher = {
    start: async (request) => {
      requests.push(request);
      const launched: LaunchedSession = {
        session: metaSession,
        running,
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
  const summaries: SummaryStore = {
    save: (s) => savedSummaries.push(s),
    load: () => null,
    delete: () => undefined,
  };
  const features = {
    attachSummary: (id: string, summary: string) => {
      attached.push({ id, summary });
      return feature;
    },
  } as unknown as FeatureService;

  const runner = createSummaryRunner({
    collector,
    launcher,
    transcripts,
    summaries,
    features,
    clock: createClock(() => 0),
    config: summarizerDefaults,
  });
  return { runner, requests, attached, savedSummaries };
}

describe('summary-runner', () => {
  it('runs a meta session and persists the extracted summary', async () => {
    const h = harness({
      sessionId: 'meta1',
      stdout: ['All login work done.'],
      stderr: [],
      exitCode: 0,
    });
    const summary = await h.runner.summarize({ featureId: 'f1' });

    expect(h.requests[0].kind).toBe('meta');
    expect(h.requests[0].providerId).toBe(summarizerDefaults.providerId);
    expect(h.requests[0].prompt).toContain('Login');
    expect(summary.content).toBe('All login work done.');
    expect(summary.createdAt).toBe('1970-01-01T00:00:00.000Z');
    expect(h.savedSummaries).toEqual([summary]);
    expect(h.attached).toEqual([{ id: 'f1', summary: 'All login work done.' }]);
  });

  it('falls back to the empty-summary placeholder', async () => {
    const h = harness(null);
    const summary = await h.runner.summarize({ featureId: 'f1' });
    expect(summary.content).toBe(summarizerDefaults.emptySummaryPlaceholder);
  });
});

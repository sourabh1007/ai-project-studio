import { describe, it, expect } from 'vitest';
import { createSessionSummaryRunner } from './session-summary-runner.js';
import type { SessionSummary } from './session-summary-contract.js';
import type { SessionSummaryStore } from './session-summary-store-port.js';
import { summarizerDefaults } from '../summarizer/config.js';
import { createClock } from '../kernel/clock.js';
import { NotFoundError } from '../kernel/error-types.js';
import type {
  LaunchedSession,
  SessionLauncher,
} from '../session/session-launcher.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { Feature } from '../feature/feature-contract.js';
import type {
  Session,
  StartSessionRequest,
} from '../session/session-contract.js';
import type { Transcript } from '../session/transcript-capture.js';
import type { RunningSession } from '../provider/provider-contract.js';

const feature: Feature = {
  id: 'f1',
  name: 'Login',
  description: 'Add login',
  createdAt: '2025-01-01T00:00:00.000Z',
  summary: null,
};

const devSession: Session = {
  id: 'dev1',
  featureId: 'f1',
  provider: 'copilot',
  requestedModel: 'auto',
  resolvedModel: 'gpt-5.4-mini',
  status: 'cancelled',
  kind: 'dev',
  prompt: 'wire up the login form',
  usageFilePath: 'u.jsonl',
  createdAt: '2025-01-01T00:00:00.000Z',
  startedAt: '2025-01-01T00:00:01.000Z',
  endedAt: '2025-01-01T00:00:02.000Z',
  exitCode: null,
};

const metaSession: Session = {
  ...devSession,
  id: 'meta1',
  kind: 'meta',
  status: 'completed',
  exitCode: 0,
};

function harness(options: {
  transcript: Transcript | null;
  session?: Session | null;
  stored?: SessionSummary | null;
}) {
  const requests: StartSessionRequest[] = [];
  const saved: SessionSummary[] = [];

  const sessions = {
    get: () =>
      options.session === undefined ? devSession : options.session,
  } as unknown as SessionRepo;
  const features = {
    get: () => feature,
  } as unknown as FeatureService;
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
    load: async () => options.transcript,
    delete: async () => undefined,
  };
  const store: SessionSummaryStore = {
    save: (s) => saved.push(s),
    load: () => options.stored ?? null,
    delete: () => undefined,
  };

  const runner = createSessionSummaryRunner({
    sessions,
    features,
    transcripts,
    launcher,
    store,
    clock: createClock(() => 0),
    config: summarizerDefaults,
  });
  return { runner, requests, saved };
}

describe('session-summary-runner', () => {
  it('spawns a silent meta session and persists the extracted summary', async () => {
    const h = harness({
      transcript: {
        sessionId: 'meta1',
        stdout: ['Wired the login form and validation.'],
        stderr: [],
        exitCode: 0,
      },
    });

    const summary = await h.runner.summarize({ sessionId: 'dev1' });

    expect(h.requests[0].kind).toBe('meta');
    expect(h.requests[0].featureId).toBe('f1');
    expect(h.requests[0].prompt).toContain('Login');
    expect(h.requests[0].prompt).toContain('wire up the login form');
    expect(summary).toEqual({
      sessionId: 'dev1',
      content: 'Wired the login form and validation.',
      createdAt: '1970-01-01T00:00:00.000Z',
    });
    expect(h.saved).toEqual([summary]);
  });

  it('falls back to the empty-summary placeholder when nothing was captured', async () => {
    const h = harness({ transcript: null });
    const summary = await h.runner.summarize({ sessionId: 'dev1' });
    expect(summary.content).toBe(summarizerDefaults.emptySummaryPlaceholder);
  });

  it('throws when the session does not exist', async () => {
    const h = harness({ transcript: null, session: null });
    await expect(h.runner.summarize({ sessionId: 'missing' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('reads a stored summary via get', () => {
    const stored: SessionSummary = {
      sessionId: 'dev1',
      content: 'previously generated',
      createdAt: '2025-01-01T00:00:00.000Z',
    };
    const h = harness({ transcript: null, stored });
    expect(h.runner.get('dev1')).toEqual(stored);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Feature } from '../feature/feature-contract.js';
import type { FeatureService } from '../feature/feature-service.js';
import { NotFoundError } from '../kernel/error-types.js';
import type { RunningSession } from '../provider/provider-contract.js';
import type {
  Session,
  StartSessionRequest,
} from '../session/session-contract.js';
import type {
  LaunchedSession,
  SessionLauncher,
} from '../session/session-launcher.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { Transcript } from '../session/transcript-capture.js';
import { summarizerDefaults } from '../summarizer/config.js';
import { contextDefaults } from './config.js';
import type { ContextDocument } from './context-contract.js';
import type { ContextService } from './context-service.js';
import { createContextMergeRunner } from './context-merge-runner.js';

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
  name: null,
  provider: 'copilot',
  requestedModel: 'auto',
  resolvedModel: 'gpt-5.4-mini',
  status: 'completed',
  kind: 'dev',
  prompt: 'wire up login',
  usageFilePath: 'u.jsonl',
  createdAt: '2025-01-01T00:00:00.000Z',
  startedAt: '2025-01-01T00:00:01.000Z',
  endedAt: '2025-01-01T00:00:02.000Z',
  exitCode: 0,
};

const metaSession: Session = { ...devSession, id: 'meta1', kind: 'meta' };

function harness(options: {
  transcript: Transcript | null;
  session?: Session | null;
  existing?: string;
  withStatus?: boolean;
}) {
  const requests: StartSessionRequest[] = [];
  const statuses: string[] = [];
  const set = vi.fn(
    (input: {
      scope: 'workspace' | 'repo' | 'feature';
      scopeId: string;
      content: string;
      updatedBy: 'merge' | 'manual' | 'import';
    }): ContextDocument => ({
      ...input,
      updatedAt: '2026-09-01T00:00:00.000Z',
    }),
  );

  const sessions = {
    get: () => (options.session === undefined ? devSession : options.session),
  } as unknown as SessionRepo;
  const features = { get: () => feature } as unknown as FeatureService;
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
  const service = {
    get: () =>
      options.existing !== undefined
        ? ({ content: options.existing } as ContextDocument)
        : null,
    setContent: set,
  } as unknown as ContextService;

  const runner = createContextMergeRunner({
    sessions,
    features,
    transcripts,
    launcher,
    service,
    summarizerConfig: summarizerDefaults,
    config: contextDefaults,
    onStatus: options.withStatus
      ? (status) => statuses.push(status.phase)
      : undefined,
  });
  return { runner, requests, set, statuses };
}

describe('context-merge-runner', () => {
  it('launches a meta session and persists the curated feature document', async () => {
    const h = harness({
      transcript: {
        sessionId: 'meta1',
        stdout: ['- Use bcrypt for password hashing.'],
        stderr: [],
        exitCode: 0,
      },
      existing: '- Prior fact.',
    });

    const doc = await h.runner.merge({ sessionId: 'dev1' });

    expect(h.requests[0].kind).toBe('meta');
    expect(h.requests[0].featureId).toBe('f1');
    expect(h.requests[0].prompt).toContain('Login');
    expect(h.requests[0].prompt).toContain('- Prior fact.');
    expect(h.set).toHaveBeenCalledWith({
      scope: 'feature',
      scopeId: 'f1',
      content: '- Use bcrypt for password hashing.',
      updatedBy: 'merge',
    });
    expect(doc?.updatedBy).toBe('merge');
  });

  it('emits generating → saving → sharing → idle status frames on success', async () => {
    const h = harness({
      transcript: {
        sessionId: 'meta1',
        stdout: ['- Use bcrypt for password hashing.'],
        stderr: [],
        exitCode: 0,
      },
      withStatus: true,
    });

    await h.runner.merge({ sessionId: 'dev1' });

    expect(h.statuses).toEqual(['generating', 'saving', 'sharing', 'idle']);
  });

  it('emits generating then idle (no save) when curation is empty', async () => {
    const h = harness({
      transcript: { sessionId: 'meta1', stdout: [], stderr: [], exitCode: 0 },
      withStatus: true,
    });

    await h.runner.merge({ sessionId: 'dev1' });

    expect(h.statuses).toEqual(['generating', 'idle']);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('uses placeholders when there is no existing context or output', async () => {
    const h = harness({ transcript: null });
    await h.runner.merge({ sessionId: 'dev1' });
    expect(h.requests[0].prompt).toContain(contextDefaults.emptyContextPlaceholder);
    expect(h.requests[0].prompt).toContain(contextDefaults.emptyOutputPlaceholder);
  });

  it('returns null and skips the write when curation is empty', async () => {
    const h = harness({
      transcript: { sessionId: 'meta1', stdout: [], stderr: [], exitCode: 0 },
    });
    const doc = await h.runner.merge({ sessionId: 'dev1' });
    expect(doc).toBeNull();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('throws when the session does not exist', async () => {
    const h = harness({ transcript: null, session: null });
    await expect(h.runner.merge({ sessionId: 'missing' })).rejects.toThrow(
      NotFoundError,
    );
  });
});

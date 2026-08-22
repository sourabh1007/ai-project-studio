import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../kernel/error-types.js';
import { repositoryContextDefaults } from '../repository-context/config.js';
import type { RepositoryContext } from '../repository-context/repository-context-contract.js';
import type { Session } from '../session/session-contract.js';
import {
  composeBootstrappedPrompt,
  createSessionBootstrap,
} from './session-bootstrap.js';

const baseSession: Session = {
  id: 'current',
  featureId: 'feature-1',
  name: null,
  provider: 'copilot',
  requestedModel: 'auto',
  resolvedModel: null,
  status: 'created',
  kind: 'dev',
  scope: 'feature',
  prompt: 'original',
  usageFilePath: 'usage.jsonl',
  createdAt: '2026-01-04T00:00:00.000Z',
  startedAt: null,
  endedAt: null,
  exitCode: null,
};

const readyContext: RepositoryContext = {
  repositoryId: 'repo-1',
  status: 'ready',
  content: 'Repository summary',
  sourceRevision: 'abc',
  timestamps: {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    generationStartedAt: '2026-01-01T00:00:00.000Z',
    generatedAt: '2026-01-01T00:00:00.000Z',
  },
  steps: [],
  failure: null,
};

function session(
  id: string,
  createdAt: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    ...baseSession,
    id,
    status: 'completed',
    createdAt,
    ...overrides,
  };
}

function harness(options: {
  repoId?: string | null;
  context?: RepositoryContext | null;
  contextError?: Error;
  sessions?: Session[];
  summaries?: Record<string, string>;
  storedCurrent?: boolean;
  featureInstructions?: string;
  sessionInstructions?: string;
  maxItems?: number;
  maxChars?: number;
  maxOutputChars?: number;
  checkoutPath?: string | null;
  sharedContext?: string;
} = {}) {
  const loads: string[] = [];
  const instructions: string[] = [];
  const contextIds: string[] = [];
  const composeInputs: { repoId?: string | null; featureId?: string | null }[] =
    [];
  const allSessions = options.sessions ?? [];
  const bootstrap = createSessionBootstrap({
    features: {
      get: () => ({
        id: 'feature-1',
        name: 'Feature name',
        description: 'Feature description',
        createdAt: '2026-01-01T00:00:00.000Z',
        summary: null,
        repoId: options.repoId === undefined ? 'repo-1' : options.repoId,
        checkoutPath: options.checkoutPath,
      }),
    },
    sessions: {
      get: () => (options.storedCurrent ? baseSession : null),
      listByFeature: () => allSessions,
    },
    summaries: {
      load: (id) => {
        loads.push(id);
        const content = options.summaries?.[id];
        return content ? { sessionId: id, content, createdAt: '' } : null;
      },
    },
    skills: {
      instructionsForFeature: (id) => {
        instructions.push(`feature:${id}`);
        return options.featureInstructions ?? 'Feature skill';
      },
      instructionsForSession: (id) => {
        instructions.push(`session:${id}`);
        return options.sessionInstructions ?? 'Session skill';
      },
    },
    contexts: {
      ensureFresh: async (repositoryId) => {
        contextIds.push(repositoryId);
        if (options.contextError) {
          throw options.contextError;
        }
        if (options.context === null) {
          throw new NotFoundError('missing');
        }
        return options.context ?? readyContext;
      },
    },
    sharedContext: {
      composeLayered: (input) => {
        composeInputs.push(input);
        return options.sharedContext ?? '';
      },
    },
    config: {
      ...repositoryContextDefaults,
      maxFeatureMemoryItems: options.maxItems ?? 12,
      maxFeatureMemoryChars: options.maxChars ?? 32_000,
      maxOutputChars:
        options.maxOutputChars ?? repositoryContextDefaults.maxOutputChars,
    },
  });
  return { bootstrap, loads, instructions, contextIds, composeInputs };
}

describe('session bootstrap', () => {
  it('composes repository, feature, recent summaries, and skills in order', async () => {
    const old = session('old', '2026-01-01T00:00:00.000Z');
    const recent = session('recent', '2026-01-03T00:00:00.000Z');
    const h = harness({
      sessions: [old, recent],
      summaries: { old: 'Old work', recent: 'Recent work' },
    });

    const result = await h.bootstrap.composeForSession(baseSession);
    const headings = [
      '## Repository Context',
      '## Feature',
      '## Prior Completed Development Sessions',
      '## Effective Skill Instructions',
    ];
    expect(result.indexOf(headings[0])).toBeLessThan(result.indexOf(headings[1]));
    expect(result.indexOf(headings[1])).toBeLessThan(result.indexOf(headings[2]));
    expect(result.indexOf(headings[2])).toBeLessThan(result.indexOf(headings[3]));
    expect(result.indexOf('Recent work')).toBeLessThan(result.indexOf('Old work'));
    expect(h.loads).toEqual(['recent', 'old']);
    expect(h.instructions).toEqual(['feature:feature-1']);
  });

  it('filters non-completed, meta, internal, current, and unsummarized sessions', async () => {
    const h = harness({
      sessions: [
        baseSession,
        session('failed', '2026-01-05T00:00:00.000Z', { status: 'failed' }),
        session('meta', '2026-01-05T00:00:00.000Z', { kind: 'meta' }),
        session('internal', '2026-01-05T00:00:00.000Z', { scope: 'internal' }),
        session('missing', '2026-01-05T00:00:00.000Z'),
        session('kept', '2026-01-02T00:00:00.000Z'),
      ],
      summaries: { kept: 'Kept summary' },
    });
    const result = await h.bootstrap.composeForSession(baseSession);
    expect(result).toContain('Kept summary');
    expect(result).not.toContain('failed');
    expect(result).not.toContain('meta');
    expect(result).not.toContain('internal');
    expect(h.loads).toEqual(['missing', 'kept']);
  });

  it('bounds summary count and total summary characters', async () => {
    const h = harness({
      sessions: [
        session('third', '2026-01-01T00:00:00.000Z'),
        session('second', '2026-01-02T00:00:00.000Z'),
        session('first', '2026-01-03T00:00:00.000Z'),
      ],
      summaries: { first: '12345', second: 'abcdef', third: 'ignored' },
      maxItems: 2,
      maxChars: 8,
    });
    const result = await h.bootstrap.composeForSession(baseSession);
    expect(result).toContain('12345');
    expect(result).toContain('abc');
    expect(result).not.toContain('ignored');
    expect(h.loads).toEqual(['first', 'second']);
  });

  it('bounds the ready repository summary using repository-context config', async () => {
    const h = harness({
      context: { ...readyContext, content: '123456789' },
      maxOutputChars: 5,
    });
    const result = await h.bootstrap.composeForSession(baseSession);
    expect(result).toContain('## Repository Context\n\n12345');
    expect(result).not.toContain('123456');
  });

  it('uses effective session skills when the session is already persisted', async () => {
    const h = harness({ storedCurrent: true });
    expect(await h.bootstrap.composeForSession(baseSession)).toContain('Session skill');
    expect(h.instructions).toEqual(['session:current']);
  });

  it('omits the skills section when no effective instructions exist', async () => {
    const h = harness({ featureInstructions: '' });
    expect(await h.bootstrap.composeForSession(baseSession)).not.toContain(
      '## Effective Skill Instructions',
    );
  });

  it('recomposes feature memory fresh for every launch', async () => {
    const summaries = { previous: 'First summary' };
    const h = harness({
      sessions: [session('previous', '2026-01-03T00:00:00.000Z')],
      summaries,
    });
    expect(await h.bootstrap.composeForSession(baseSession)).toContain('First summary');
    summaries.previous = 'Updated summary';
    expect(await h.bootstrap.composeForSession(baseSession)).toContain(
      'Updated summary',
    );
  });

  it.each(['pending', 'generating', 'stale', 'failed'] as const)(
    'does not block a session launch while repository context is %s',
    async (status) => {
      const h = harness({ context: { ...readyContext, status } });
      await expect(
        h.bootstrap.assertFeatureReady('feature-1'),
      ).resolves.toBeUndefined();
      // Analysis was still triggered so it keeps making progress in the
      // background, but the session launches without the (not-yet-ready) section.
      expect(h.contextIds).toEqual(['repo-1']);
      const result = await h.bootstrap.composeForSession(baseSession);
      expect(result).not.toContain('## Repository Context');
      expect(result).toContain('## Feature');
    },
  );

  it('does not block a launch when the repository context is missing', async () => {
    const h = harness({ context: null });
    await expect(
      h.bootstrap.assertFeatureReady('feature-1'),
    ).resolves.toBeUndefined();
    expect(h.contextIds).toEqual(['repo-1']);
    const result = await h.bootstrap.composeForSession(baseSession);
    expect(result).not.toContain('## Repository Context');
  });

  it('does not block a launch when the repository-context lookup fails', async () => {
    const failure = new Error('database unavailable');
    const h = harness({ contextError: failure });
    await expect(
      h.bootstrap.assertFeatureReady('feature-1'),
    ).resolves.toBeUndefined();
    const result = await h.bootstrap.composeForSession(baseSession);
    expect(result).not.toContain('## Repository Context');
  });

  it('omits a ready context that has no usable content without blocking', async () => {
    const h = harness({ context: { ...readyContext, content: ' ' } });
    await expect(
      h.bootstrap.assertFeatureReady('feature-1'),
    ).resolves.toBeUndefined();
    const result = await h.bootstrap.composeForSession(baseSession);
    expect(result).not.toContain('## Repository Context');
  });

  it('allows repo-less features and omits repository context', async () => {
    const h = harness({ repoId: null });
    await expect(h.bootstrap.assertFeatureReady('feature-1')).resolves.toBeUndefined();
    const result = await h.bootstrap.composeForSession(baseSession);
    expect(result).not.toContain('## Repository Context');
    expect(result).toContain('## Feature');
  });

  it('uses the base repository context for PR worktree features', async () => {
    const h = harness({ checkoutPath: 'C:\\worktrees\\pr-42' });
    expect(await h.bootstrap.composeForSession(baseSession)).toContain(
      'Repository summary',
    );
    expect(h.contextIds).toEqual(['repo-1']);
  });

  it('excludes meta and internal sessions', async () => {
    const h = harness();
    expect(await h.bootstrap.composeForSession({ ...baseSession, kind: 'meta' })).toBe('');
    expect(
      await h.bootstrap.composeForSession({ ...baseSession, scope: 'internal' }),
    ).toBe('');
  });

  it('injects the layered shared context between repository and feature', async () => {
    const h = harness({
      sharedContext: '## Shared Context\n\n### Feature\n\n- Curated fact',
    });
    const result = await h.bootstrap.composeForSession(baseSession);
    expect(result).toContain('- Curated fact');
    expect(result.indexOf('## Repository Context')).toBeLessThan(
      result.indexOf('## Shared Context'),
    );
    expect(result.indexOf('## Shared Context')).toBeLessThan(
      result.indexOf('## Feature'),
    );
    expect(h.composeInputs).toEqual([
      { repoId: 'repo-1', featureId: 'feature-1' },
    ]);
  });

  it('omits the shared context block when no layer has content', async () => {
    const h = harness();
    expect(await h.bootstrap.composeForSession(baseSession)).not.toContain(
      '## Shared Context',
    );
  });

  it('keeps the original user request in a distinct final section', async () => {
    expect(composeBootstrappedPrompt('BOOTSTRAP', 'USER')).toBe(
      'BOOTSTRAP\n\n## User Request\n\nUSER',
    );
    expect(composeBootstrappedPrompt('', 'USER')).toBe('USER');
  });

  it('always injects the monitoring policy directing monitors to create_monitor', async () => {
    const h = harness();
    const result = await h.bootstrap.composeForSession(baseSession);
    expect(result).toContain('## Monitoring & Automations');
    expect(result).toContain('create_monitor');
    expect(result).toContain('ai-project-studio');
    // The standing policy leads the bootstrap, ahead of repository context.
    expect(result.indexOf('## Monitoring & Automations')).toBeLessThan(
      result.indexOf('## Repository Context'),
    );
  });
});

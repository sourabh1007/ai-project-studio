import { describe, expect, it } from 'vitest';
import { createClock } from '../kernel/clock.js';
import {
  MetaAbortError,
  type MetaRequest,
  type MetaRunResult,
  type MetaRunner,
} from '../meta/meta-runner.js';
import type { Repository } from '../repo/repo-contract.js';
import { type RepoInsightsConfig, repoInsightsDefaults } from './config.js';
import type {
  RepoInsightsSection,
  RepoInsightsStreamEvent,
} from './repo-insights-contract.js';
import { createRepoInsightsService } from './repo-insights-service.js';
import type { RepoInsightsGit } from './repo-insights-git-port.js';

interface FakeGitData {
  defaultBranch?: string | null;
  files?: Record<string, string[]>;
  contents?: Record<string, string>;
  authors?: Record<string, string>;
  exists?: string[];
}

function fakeGit(data: FakeGitData): RepoInsightsGit {
  return {
    resolveDefaultBranch: async () => data.defaultBranch ?? null,
    listFiles: async (_path, _ref, directory) => data.files?.[directory] ?? [],
    readFile: async (_path, _ref, file) =>
      Object.prototype.hasOwnProperty.call(data.contents ?? {}, file)
        ? (data.contents as Record<string, string>)[file]
        : null,
    fileExists: async (_path, _ref, file) => (data.exists ?? []).includes(file),
    lastCommitAuthor: async (_path, _ref, file) => data.authors?.[file] ?? null,
  };
}
function repo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 'r1',
    provider: 'github',
    remoteUrl: 'https://github.com/acme/app.git',
    name: 'acme/app',
    localPath: 'C:/work/app',
    defaultBranch: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const clock = createClock(() => Date.parse('2026-02-01T00:00:00.000Z'));

function serviceWith(git: RepoInsightsGit, repository: Repository) {
  return createRepoInsightsService({
    repos: { get: () => repository },
    git,
    clock,
    config: repoInsightsDefaults,
  });
}

describe('createRepoInsightsService', () => {
  it('builds full insights from the resolved default branch', async () => {
    const git = fakeGit({
      defaultBranch: 'develop',
      files: {
        '.github/agents': [
          '.github/agents/b.md',
          '.github/agents/a.md',
          '.github/agents/gone.md',
          '.github/agents/notes.txt',
        ],
        '.github/skills': ['.github/skills/z.md', '.github/skills/empty.md'],
      },
      contents: {
        '.github/agents/a.md': `---\nname: Alpha\ndescription: ${'x'.repeat(200)}\nauthor: Ada\n---\nbody`,
        '.github/agents/b.md': '# Heading B\n\ndetails',
        '.github/skills/z.md': '---\nname: Zeta\n---\n\n## Does things\nmore',
        '.github/skills/empty.md': '',
      },
      authors: {
        '.github/agents/b.md': 'Bob Committer',
        '.github/skills/empty.md': 'Eve',
      },
      exists: ['AGENTS.md', '.github/workflows/copilot-setup-steps.yml'],
    });

    const insights = await serviceWith(git, repo()).load('r1');

    expect(insights.branch).toBe('develop');
    expect(insights.repositoryId).toBe('r1');
    expect(insights.generatedAt).toBe('2026-02-01T00:00:00.000Z');

    expect(insights.agents).toEqual([
      {
        name: 'Alpha',
        description: `${'x'.repeat(159)}…`,
        author: 'Ada',
        path: '.github/agents/a.md',
      },
      {
        name: 'b',
        description: 'Heading B',
        author: 'Bob Committer',
        path: '.github/agents/b.md',
      },
    ]);
    expect(insights.skills).toEqual([
      {
        name: 'empty',
        description: '',
        author: 'Eve',
        path: '.github/skills/empty.md',
      },
      {
        name: 'Zeta',
        description: 'Does things',
        author: 'Unknown',
        path: '.github/skills/z.md',
      },
    ]);
    expect(insights.docs).toEqual([]);

    expect(insights.readiness).toEqual([
      {
        key: 'agent-instructions',
        label: 'Agent instructions',
        requirement: 'AGENTS.md or .github/copilot-instructions.md is present.',
        status: 'pass',
        detail: 'AGENTS.md',
      },
      {
        key: 'custom-agent',
        label: 'Custom agent defined',
        requirement: 'At least one custom agent exists under .github/agents.',
        status: 'pass',
        detail: '3 found',
      },
    ]);
    expect(insights.agentReady).toBe(true);
  });

  it('discovers repo-native skills and docs outside .github, deduping overlaps', async () => {
    const git = fakeGit({
      defaultBranch: 'main',
      files: {
        'skills': [
          'skills/nested/custom.md',
          '.github/skills/shared.md',
          'skills/readme.txt',
        ],
        '.github/skills': ['.github/skills/shared.md'],
        'skills-dup': [],
        'docs': ['docs/tsg/outage.md', 'docs/guide.md'],
        '.github/docs': ['.github/docs/shared.md'],
      },
      contents: {
        'skills/nested/custom.md': '---\nname: Custom Skill\n---\nDoes X',
        '.github/skills/shared.md': '---\nname: Shared\n---\nShared skill',
        'docs/tsg/outage.md': '# Outage TSG\n\nHow to recover.',
        'docs/guide.md': 'Getting started guide.',
        '.github/docs/shared.md': 'Shared doc',
      },
    });

    const insights = await serviceWith(git, repo()).load('r1');

    expect(insights.skills.map((s) => s.path)).toEqual([
      '.github/skills/shared.md',
      'skills/nested/custom.md',
    ]);
    expect(insights.docs.map((d) => ({ name: d.name, path: d.path }))).toEqual([
      { name: 'shared', path: '.github/docs/shared.md' },
      { name: 'guide', path: 'docs/guide.md' },
      { name: 'outage', path: 'docs/tsg/outage.md' },
    ]);
  });

  it('reads a discovered definition file from the default branch', async () => {
    const git = fakeGit({
      defaultBranch: 'main',
      contents: { 'docs/guide.md': '# Guide\n\nHello' },
    });
    const result = await serviceWith(git, repo()).readDefinition(
      'r1',
      'docs/guide.md',
    );
    expect(result).toEqual({
      path: 'docs/guide.md',
      branch: 'main',
      content: '# Guide\n\nHello',
    });
  });

  it.each([
    'secrets.md',
    '../outside/evil.md',
    'docs/../../etc/passwd.md',
    '/etc/hosts.md',
    'docs/guide.txt',
  ])('rejects reading an unsafe path %s', async (path) => {
    const git = fakeGit({ defaultBranch: 'main' });
    await expect(
      serviceWith(git, repo()).readDefinition('r1', path),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('throws NotFound when a readable path is absent on the branch', async () => {
    const git = fakeGit({ defaultBranch: 'main', contents: {} });
    await expect(
      serviceWith(git, repo()).readDefinition('r1', 'docs/missing.md'),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('falls back to the stored default branch and reports failures', async () => {
    const git = fakeGit({ defaultBranch: null });
    const insights = await serviceWith(
      git,
      repo({ defaultBranch: 'master' }),
    ).load('r1');

    expect(insights.branch).toBe('master');
    expect(insights.agents).toEqual([]);
    expect(insights.skills).toEqual([]);
    expect(insights.readiness.map((check) => check.status)).toEqual([
      'fail',
      'fail',
    ]);
    expect(insights.readiness.every((check) => check.detail === null)).toBe(true);
    expect(insights.agentReady).toBe(false);
  });

  it('falls back to the configured branch and matches a later listed path', async () => {
    const git = fakeGit({
      defaultBranch: null,
      exists: ['.github/copilot-instructions.md'],
    });
    const insights = await serviceWith(git, repo({ defaultBranch: null })).load(
      'r1',
    );

    expect(insights.branch).toBe('main');
    expect(insights.readiness[0]).toEqual({
      key: 'agent-instructions',
      label: 'Agent instructions',
      requirement: 'AGENTS.md or .github/copilot-instructions.md is present.',
      status: 'pass',
      detail: '.github/copilot-instructions.md',
    });
    expect(insights.agentReady).toBe(false);
  });

  it('caches the first scan and reuses it for later loads', async () => {
    let scans = 0;
    const git = fakeGit({ defaultBranch: 'main' });
    const counting: RepoInsightsGit = {
      ...git,
      resolveDefaultBranch: async (path) => {
        scans += 1;
        return git.resolveDefaultBranch(path);
      },
    };
    const svc = serviceWith(counting, repo());
    const first = await svc.load('r1');
    const second = await svc.load('r1');
    expect(scans).toBe(1);
    expect(second).toBe(first);
  });

  it('forces a fresh scan when refresh is requested', async () => {
    let scans = 0;
    const git = fakeGit({ defaultBranch: 'main' });
    const counting: RepoInsightsGit = {
      ...git,
      resolveDefaultBranch: async (path) => {
        scans += 1;
        return git.resolveDefaultBranch(path);
      },
    };
    const svc = serviceWith(counting, repo());
    await svc.load('r1');
    const refreshed = await svc.load('r1', { refresh: true });
    expect(scans).toBe(2);
    expect(refreshed.branch).toBe('main');
  });

  it('dedupes concurrent first-time loads into a single scan', async () => {
    let scans = 0;
    const git = fakeGit({ defaultBranch: 'main' });
    const counting: RepoInsightsGit = {
      ...git,
      resolveDefaultBranch: async (path) => {
        scans += 1;
        return git.resolveDefaultBranch(path);
      },
    };
    const svc = serviceWith(counting, repo());
    const [a, b] = await Promise.all([svc.load('r1'), svc.load('r1')]);
    expect(scans).toBe(1);
    expect(a).toBe(b);
  });
});

type AiOutcome = 'ok' | 'fail' | 'timeout' | 'aborted';

function fakeAi(
  behaviors: Partial<Record<RepoInsightsSection, AiOutcome[]>>,
  onCall?: (section: RepoInsightsSection, req: MetaRequest) => void,
): Pick<MetaRunner, 'runDetailed'> & { calls: MetaRequest[] } {
  const calls: MetaRequest[] = [];
  const idx: Partial<Record<RepoInsightsSection, number>> = {};
  return {
    calls,
    runDetailed: async (req: MetaRequest): Promise<MetaRunResult> => {
      const section = (req.label ?? '').split(' · ')[1] as RepoInsightsSection;
      calls.push(req);
      onCall?.(section, req);
      const seq = behaviors[section] ?? ['ok'];
      const i = idx[section] ?? 0;
      idx[section] = i + 1;
      const outcome = seq[Math.min(i, seq.length - 1)];
      if (outcome === 'fail') {
        throw new Error(`boom-${section}`);
      }
      if (outcome === 'timeout') {
        throw new MetaAbortError({ kind: 'timed_out', termination: 'confirmed' });
      }
      if (outcome === 'aborted') {
        throw new MetaAbortError({ kind: 'aborted', termination: 'confirmed' });
      }
      return { text: `  analysis-${section}  `, sessionId: 's' };
    },
  };
}

function enrichConfig(
  over: Partial<RepoInsightsConfig['enrichment']>,
): RepoInsightsConfig {
  return {
    ...repoInsightsDefaults,
    enrichment: { ...repoInsightsDefaults.enrichment, ...over },
  };
}

interface StreamOpts {
  ai?: Pick<MetaRunner, 'runDetailed'>;
  live?: () => number;
  sleep?: (ms: number) => Promise<void>;
  config?: RepoInsightsConfig;
}

function streamWith(
  git: RepoInsightsGit,
  repository: Repository,
  opts: StreamOpts = {},
) {
  return createRepoInsightsService({
    repos: { get: () => repository },
    git,
    clock,
    config: opts.config ?? repoInsightsDefaults,
    ai: opts.ai,
    liveMetaSessions: opts.live,
    sleep: opts.sleep,
  });
}

async function collect(
  svc: ReturnType<typeof streamWith>,
  signal?: AbortSignal,
): Promise<RepoInsightsStreamEvent[]> {
  const events: RepoInsightsStreamEvent[] = [];
  await svc.analyzeStream('r1', { emit: (event) => events.push(event) }, signal);
  return events;
}

function sectionEvent(
  events: RepoInsightsStreamEvent[],
  section: RepoInsightsSection,
): Extract<RepoInsightsStreamEvent, { type: 'section' }> | undefined {
  return events.find(
    (event): event is Extract<RepoInsightsStreamEvent, { type: 'section' }> =>
      event.type === 'section' && event.section === section,
  );
}

const readyGit = () =>
  fakeGit({
    defaultBranch: 'main',
    files: {
      '.github/agents': ['.github/agents/a.md'],
      '.github/skills': ['.github/skills/s.md'],
      docs: ['docs/d.md'],
    },
    contents: {
      '.github/agents/a.md': '---\nname: A\ndescription: agent a\n---\n',
      '.github/skills/s.md': '---\nname: S\ndescription: skill s\n---\n',
      'docs/d.md': '# Doc\n\ncontent',
    },
    exists: ['AGENTS.md'],
  });

describe('createRepoInsightsService.analyzeStream', () => {
  it('streams enriched sections in parallel and a final assembled snapshot', async () => {
    const ai = fakeAi({});
    const svc = streamWith(readyGit(), repo(), {
      ai,
      live: () => 4,
      sleep: async () => {},
    });

    const events = await collect(svc);

    expect(events[0]).toEqual({ type: 'branch', branch: 'main' });
    for (const section of ['agents', 'skills', 'docs', 'readiness'] as const) {
      expect(
        events.some(
          (e) =>
            e.type === 'section-analyzing' &&
            e.section === section &&
            e.healing === false,
        ),
      ).toBe(true);
      expect(sectionEvent(events, section)?.analysis).toBe(`analysis-${section}`);
    }
    expect(sectionEvent(events, 'agents')?.entries).toHaveLength(1);
    expect(sectionEvent(events, 'readiness')?.readiness).toHaveLength(2);

    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.insights.agentReady).toBe(true);
    expect(done.insights.branch).toBe('main');

    expect(ai.calls).toHaveLength(4);
    for (const call of ai.calls) {
      expect(call.forceCold).toBe(false);
      expect(call.noTools).toBe(true);
      expect(call.toolsOptional).toBe(true);
      expect(call.scope).toBe('internal');
      expect(call.featureId).toBe('repository:r1');
      expect(call.cwd).toBe('C:/work/app');
      expect(call.timeoutMs).toBe(60_000);
      expect(call.label?.startsWith('Repo insights · ')).toBe(true);
    }

    expect(await svc.load('r1')).toBe(done.insights);
  });

  it('runs structural-only with no analysis when no metasession runner is wired', async () => {
    const svc = streamWith(
      fakeGit({ defaultBranch: 'main' }),
      repo({ defaultBranch: null }),
    );
    const events = await collect(svc);

    for (const section of ['agents', 'skills', 'docs', 'readiness'] as const) {
      const evt = sectionEvent(events, section);
      expect(evt?.analysis).toBeNull();
      expect(evt?.analysisError).toBeUndefined();
    }
    expect(
      events.some((e) => e.type === 'section-analyzing' && e.healing === true),
    ).toBe(false);
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.insights.agentReady).toBe(false);
  });

  it('skips enrichment when it is disabled by config', async () => {
    const ai = fakeAi({});
    const svc = streamWith(readyGit(), repo(), {
      ai,
      live: () => 4,
      config: enrichConfig({ enabled: false }),
    });
    const events = await collect(svc);

    expect(sectionEvent(events, 'agents')?.analysis).toBeNull();
    expect(ai.calls).toHaveLength(0);
  });

  it('self-heals a failed section by retrying on a warm session', async () => {
    const ai = fakeAi({ agents: ['fail', 'ok'] });
    const svc = streamWith(readyGit(), repo(), {
      ai,
      config: enrichConfig({ retryBackoffMs: 0 }),
    });
    const events = await collect(svc);

    expect(
      events.some(
        (e) =>
          e.type === 'section-analyzing' &&
          e.section === 'agents' &&
          e.healing === true,
      ),
    ).toBe(true);
    expect(sectionEvent(events, 'agents')?.analysis).toBe('analysis-agents');
  });

  it('skips warm retries and forces a cold session after a provider timeout', async () => {
    const ai = fakeAi({ agents: ['timeout', 'ok'] });
    const svc = streamWith(readyGit(), repo(), {
      ai,
      live: () => 4,
      sleep: async () => {},
    });
    const events = await collect(svc);

    expect(sectionEvent(events, 'agents')?.analysis).toBe('analysis-agents');
    const agentCalls = ai.calls.filter((c) => c.label === 'Repo insights · agents');
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[1]?.forceCold).toBe(true);
  });

  it('retries a non-timeout abort error on a warm session', async () => {
    const ai = fakeAi({ agents: ['aborted', 'ok'] });
    const svc = streamWith(readyGit(), repo(), {
      ai,
      live: () => 4,
      sleep: async () => {},
    });
    const events = await collect(svc);

    expect(sectionEvent(events, 'agents')?.analysis).toBe('analysis-agents');
    expect(
      ai.calls.filter((c) => c.label === 'Repo insights · agents'),
    ).toHaveLength(2);
  });

  it('degrades to an analysis error when every enrichment attempt fails', async () => {
    const git = fakeGit({
      defaultBranch: 'main',
      files: { '.github/skills': ['.github/skills/s.md'] },
      contents: { '.github/skills/s.md': '---\nname: S\n---\n' },
      exists: ['AGENTS.md'],
    });
    const ai = fakeAi({ agents: ['fail'] });
    const svc = streamWith(git, repo(), {
      ai,
      live: () => 4,
      sleep: async () => {},
    });
    const events = await collect(svc);

    const agents = sectionEvent(events, 'agents');
    expect(agents?.analysis).toBeNull();
    expect(agents?.analysisError).toBe('boom-agents');
    expect(agents?.entries).toEqual([]);
    expect(events.some((e) => e.type === 'section-failed')).toBe(false);
    expect(
      ai.calls.filter((c) => c.label === 'Repo insights · agents'),
    ).toHaveLength(3);
  });

  it('emits section-failed when a structural scan throws', async () => {
    const base = fakeGit({ defaultBranch: 'main', exists: ['AGENTS.md'] });
    const git: RepoInsightsGit = {
      ...base,
      listFiles: async (path, ref, directory) => {
        if (repoInsightsDefaults.agentsDirectories.includes(directory)) {
          throw new Error('git blew up');
        }
        return base.listFiles(path, ref, directory);
      },
    };
    const ai = fakeAi({});
    const events = await collect(streamWith(git, repo(), { ai, live: () => 4 }));

    expect(events).toContainEqual({
      type: 'section-failed',
      section: 'agents',
      error: 'git blew up',
    });
    expect(sectionEvent(events, 'agents')).toBeUndefined();
    expect(
      ai.calls.some((c) => c.label === 'Repo insights · agents'),
    ).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('stringifies a non-Error structural failure', async () => {
    const base = fakeGit({ defaultBranch: 'main', exists: ['AGENTS.md'] });
    const git: RepoInsightsGit = {
      ...base,
      listFiles: async (path, ref, directory) => {
        if (repoInsightsDefaults.skillsDirectories.includes(directory)) {
          throw 'plain string failure';
        }
        return base.listFiles(path, ref, directory);
      },
    };
    const events = await collect(streamWith(git, repo(), { live: () => 4 }));

    expect(events).toContainEqual({
      type: 'section-failed',
      section: 'skills',
      error: 'plain string failure',
    });
  });

  it('stops fanning out and emits no done once the request is aborted', async () => {
    const controller = new AbortController();
    const ai = fakeAi({ agents: ['aborted'] }, (section) => {
      if (section === 'agents') {
        controller.abort();
      }
    });
    const svc = streamWith(readyGit(), repo(), { ai, live: () => 2 });
    const events = await collect(svc, controller.signal);

    expect(sectionEvent(events, 'agents')?.analysisError).toBeDefined();
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(
      events.some((e) => e.type === 'section' && e.section === 'skills'),
    ).toBe(false);
  });

  it('emits nothing when the request is aborted before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      streamWith(readyGit(), repo(), { ai: fakeAi({}), live: () => 4 }),
      controller.signal,
    );
    expect(events).toEqual([]);
  });
});

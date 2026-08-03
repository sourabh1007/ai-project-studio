import { describe, expect, it } from 'vitest';
import { createClock } from '../kernel/clock.js';
import type { Repository } from '../repo/repo-contract.js';
import { repoInsightsDefaults } from './config.js';
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

    expect(insights.readiness).toEqual([
      {
        key: 'agent-instructions',
        label: 'Agent instructions',
        requirement: 'AGENTS.md or .github/copilot-instructions.md is present.',
        status: 'pass',
        detail: 'AGENTS.md',
      },
      {
        key: 'copilot-setup-steps',
        label: 'Cloud agent setup',
        requirement: '.github/workflows/copilot-setup-steps.yml is present.',
        status: 'pass',
        detail: '.github/workflows/copilot-setup-steps.yml',
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
});

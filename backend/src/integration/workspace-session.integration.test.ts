import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { contextDefaults } from '../context-store/config.js';
import { createContextService } from '../context-store/context-service.js';
import { featureTreeDefaults } from '../feature-tree/config.js';
import { createFeatureTreeService } from '../feature-tree/feature-tree-service.js';
import { createFeatureService } from '../feature/feature-service.js';
import { createClock } from '../kernel/clock.js';
import { createIdGenerator } from '../kernel/id-generator.js';
import { createContextRepo } from '../persistence/context-repo.js';
import { createDatabase } from '../persistence/db/connection.js';
import { createFeatureGroupsRepo } from '../persistence/feature-groups-repo.js';
import { createFeatureRepo } from '../persistence/feature-repo.js';
import { createRepoRepo } from '../persistence/repo-repo.js';
import { createSessionRepo } from '../persistence/session-repo.js';
import { createSessionSummaryRepo } from '../persistence/session-summary-repo.js';
import { createSkillsRepo } from '../persistence/skills-repo.js';
import { createRepoService } from '../repo/repo-service.js';
import { repositoryContextDefaults } from '../repository-context/config.js';
import type { RepositoryContext } from '../repository-context/repository-context-contract.js';
import { createSessionBootstrap } from '../session-bootstrap/session-bootstrap.js';
import type { Session } from '../session/session-contract.js';
import { skillsDefaults } from '../skills/config.js';
import { createSkillsService } from '../skills/skills-service.js';

const now = Date.parse('2026-09-10T06:30:00.000Z');
const clock = createClock(() => now);

function session(
  id: string,
  featureId: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    featureId,
    name: null,
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'completed',
    kind: 'dev',
    scope: 'feature',
    groupId: null,
    orderIndex: 0,
    prompt: 'Implement the feature',
    usageFilePath: `usage/${id}.jsonl`,
    createdAt: new Date(now).toISOString(),
    startedAt: new Date(now).toISOString(),
    endedAt: new Date(now + 1_000).toISOString(),
    exitCode: 0,
    ...overrides,
  };
}

function readyContext(repositoryId: string): RepositoryContext {
  const timestamp = new Date(now).toISOString();
  return {
    repositoryId,
    status: 'ready',
    content: 'Repository architecture from tracked source files.',
    sourceRevision: 'abc123',
    timestamps: {
      createdAt: timestamp,
      updatedAt: timestamp,
      generationStartedAt: timestamp,
      generatedAt: timestamp,
    },
    steps: [],
    failure: null,
  };
}

describe('workspace and session integration', () => {
  let db: DatabaseSync | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  function harness() {
    db = createDatabase({ databasePath: ':memory:' });
    const repoRepo = createRepoRepo(db);
    const featureRepo = createFeatureRepo(db);
    const sessions = createSessionRepo(db);
    const summaries = createSessionSummaryRepo(db);
    const repos = createRepoService({
      repo: repoRepo,
      ids: createIdGenerator(() => 'repo-1'),
      clock,
    });
    let featureId = 0;
    const features = createFeatureService({
      repo: featureRepo,
      ids: createIdGenerator(() => `feature-${(featureId += 1)}`),
      clock,
      repos,
    });
    let groupId = 0;
    const tree = createFeatureTreeService({
      groups: createFeatureGroupsRepo(db),
      sessions,
      features,
      ids: createIdGenerator(() => `group-${(groupId += 1)}`),
      clock,
      config: featureTreeDefaults,
    });
    let skillId = 0;
    const skills = createSkillsService({
      repo: createSkillsRepo(db),
      ids: createIdGenerator(() => `skill-${(skillId += 1)}`),
      clock,
      features,
      sessions,
      config: skillsDefaults,
    });
    const contextUpdates: string[] = [];
    const context = createContextService({
      store: createContextRepo(db),
      clock,
      config: contextDefaults,
      onUpdated: (document) =>
        contextUpdates.push(`${document.scope}:${document.scopeId}`),
    });
    return {
      context,
      contextUpdates,
      features,
      repos,
      sessions,
      skills,
      summaries,
      tree,
    };
  }

  it('persists repository features and prevents cyclic nested moves', () => {
    const h = harness();
    const repository = h.repos.create({
      provider: 'github',
      remoteUrl: 'https://github.com/acme/app.git',
      name: 'acme/app',
      localPath: 'C:\\work\\app',
      defaultBranch: 'main',
    });
    const parent = h.features.create({
      name: 'Checkout',
      description: 'Build checkout',
      repoId: repository.id,
    });
    const child = h.features.create({
      name: 'Payments',
      description: 'Add payment processing',
      repoId: repository.id,
    });

    h.features.moveFeature({
      id: child.id,
      targetRepoId: repository.id,
      targetParentFeatureId: parent.id,
      targetIndex: 0,
    });

    expect(h.features.get(child.id)).toMatchObject({
      repoId: repository.id,
      parentFeatureId: parent.id,
      orderIndex: 0,
    });
    expect(() =>
      h.features.moveFeature({
        id: parent.id,
        targetRepoId: repository.id,
        targetParentFeatureId: child.id,
        targetIndex: 0,
      }),
    ).toThrow(/descendants/);
  });

  it('persists sub-category and session moves as one ordered tree', () => {
    const h = harness();
    const first = h.features.create({
      name: 'First',
      description: '',
    });
    const second = h.features.create({
      name: 'Second',
      description: '',
    });
    const group = h.tree.createGroup({
      featureId: first.id,
      kind: 'subcategory',
      name: 'Implementation',
    });
    h.sessions.save(session('session-1', first.id));

    h.tree.moveNode({
      type: 'session',
      id: 'session-1',
      targetFeatureId: first.id,
      targetParentGroupId: group.id,
      targetIndex: 0,
    });
    expect(h.sessions.get('session-1')).toMatchObject({
      featureId: first.id,
      groupId: group.id,
      orderIndex: 0,
    });

    h.tree.moveNode({
      type: 'group',
      id: group.id,
      targetFeatureId: second.id,
      targetParentGroupId: null,
      targetIndex: 0,
    });
    expect(h.tree.listGroups(second.id)[0]).toMatchObject({
      id: group.id,
      featureId: second.id,
      parentGroupId: null,
    });
    expect(h.sessions.get('session-1')).toMatchObject({
      featureId: second.id,
      groupId: group.id,
    });
  });

  it('composes persisted context, memory, and effective skills into launch context', async () => {
    const h = harness();
    const repository = h.repos.create({
      provider: 'github',
      remoteUrl: 'https://github.com/acme/app.git',
      name: 'acme/app',
      localPath: 'C:\\work\\app',
    });
    const feature = h.features.create({
      name: 'Payments',
      description: 'Add payment processing',
      repoId: repository.id,
    });
    const prior = session('prior', feature.id, {
      createdAt: '2026-09-09T00:00:00.000Z',
    });
    const current = session('current', feature.id, {
      status: 'created',
      startedAt: null,
      endedAt: null,
      exitCode: null,
    });
    h.sessions.save(prior);
    h.sessions.save(current);
    h.summaries.save({
      sessionId: prior.id,
      content: 'Implemented the payment domain model.',
      createdAt: new Date(now).toISOString(),
    });
    h.context.setContent({
      scope: 'workspace',
      scopeId: '',
      content: 'Use strict TypeScript.',
      updatedBy: 'manual',
    });
    h.context.setContent({
      scope: 'repo',
      scopeId: repository.id,
      content: 'Run workspace tests before merging.',
      updatedBy: 'manual',
    });
    h.context.setContent({
      scope: 'feature',
      scopeId: feature.id,
      content: 'Preserve payment idempotency.',
      updatedBy: 'manual',
    });
    const skill = h.skills.createSkill({
      name: 'Testing',
      kind: 'instruction',
      instructions: 'Add regression tests for every fix.',
      recommendedScope: 'feature',
    });
    h.skills.tag({
      skillId: skill.id,
      scope: 'feature',
      targetId: feature.id,
    });

    const bootstrap = createSessionBootstrap({
      features: h.features,
      sessions: h.sessions,
      summaries: h.summaries,
      skills: h.skills,
      contexts: {
        ensureFresh: async (repositoryId) => readyContext(repositoryId),
      },
      sharedContext: h.context,
      config: repositoryContextDefaults,
    });
    const prompt = await bootstrap.composeForSession(current);

    expect(prompt).toContain('Repository architecture from tracked source files.');
    expect(prompt).toContain('Use strict TypeScript.');
    expect(prompt).toContain('Run workspace tests before merging.');
    expect(prompt).toContain('Preserve payment idempotency.');
    expect(prompt).toContain('Implemented the payment domain model.');
    expect(prompt).toContain('Add regression tests for every fix.');
    expect(h.contextUpdates).toEqual([
      'workspace:',
      `repo:${repository.id}`,
      `feature:${feature.id}`,
    ]);
  });
});

import { describe, it, expect } from 'vitest';
import { createSkillsService } from './skills-service.js';
import { skillsDefaults } from './config.js';
import type { SkillsRepo } from './skills-repo-port.js';
import type { Skill, SkillAttachment, SkillScope } from './skills-contract.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { Session } from '../session/session-contract.js';
import { NotFoundError, ValidationError } from '../kernel/error-types.js';

function inMemoryRepo(): SkillsRepo {
  const skills = new Map<string, Skill>();
  const attachments = new Map<string, SkillAttachment>();
  return {
    createSkill: (skill) => void skills.set(skill.id, skill),
    getSkill: (id) => skills.get(id) ?? null,
    listSkills: () => [...skills.values()],
    updateSkill: (id, patch) => {
      const existing = skills.get(id);
      if (existing) {
        skills.set(id, { ...existing, ...patch });
      }
    },
    deleteSkill: (id) => void skills.delete(id),
    createAttachment: (a) => void attachments.set(a.id, a),
    getAttachment: (id) => attachments.get(id) ?? null,
    findAttachment: (skillId, scope, targetId) =>
      [...attachments.values()].find(
        (a) => a.skillId === skillId && a.scope === scope && a.targetId === targetId,
      ) ?? null,
    deleteAttachment: (id) => void attachments.delete(id),
    deleteAttachmentsBySkill: (skillId) => {
      for (const [id, a] of attachments) {
        if (a.skillId === skillId) {
          attachments.delete(id);
        }
      }
    },
    listAttachmentsByTarget: (scope, targetId) =>
      [...attachments.values()].filter(
        (a) => a.scope === scope && a.targetId === targetId,
      ),
  };
}

function fakeFeatures(ids: string[]): FeatureService {
  const set = new Set(ids);
  return {
    get: (id) => {
      if (!set.has(id)) {
        throw new NotFoundError(`Unknown feature: ${id}`);
      }
      return {
        id,
        name: 'F',
        description: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        summary: null,
      };
    },
  } as unknown as FeatureService;
}

function fakeSessions(sessions: Session[]): SessionRepo {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return {
    get: (id) => byId.get(id) ?? null,
  } as unknown as SessionRepo;
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    featureId: 'f1',
    provider: 'agency',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'completed',
    kind: 'dev',
    prompt: 'p',
    usageFilePath: 'u',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function build(options: { features?: string[]; sessions?: Session[] } = {}) {
  let counter = 0;
  const repo = inMemoryRepo();
  const service = createSkillsService({
    repo,
    ids: { next: () => `id-${(counter += 1)}` },
    clock: { isoNow: () => '2026-01-01T00:00:00.000Z' },
    features: fakeFeatures(options.features ?? ['f1']),
    sessions: fakeSessions(options.sessions ?? [session()]),
    config: skillsDefaults,
  });
  return Object.assign(service, { __repo: repo });
}

describe('skills-service CRUD', () => {
  it('creates, gets, lists and trims the name', () => {
    const svc = build();
    const skill = svc.createSkill({
      name: '  Testing  ',
      kind: 'instruction',
      instructions: 'Write tests.',
    });
    expect(skill.name).toBe('Testing');
    expect(svc.getSkill(skill.id)).toEqual(skill);
    expect(svc.listSkills()).toEqual([skill]);
  });

  it('rejects an empty name', () => {
    const svc = build();
    expect(() =>
      svc.createSkill({ name: '   ', kind: 'instruction', instructions: '' }),
    ).toThrow(ValidationError);
  });

  it('rejects an over-long name', () => {
    const svc = build();
    expect(() =>
      svc.createSkill({
        name: 'x'.repeat(skillsDefaults.maxNameLength + 1),
        kind: 'instruction',
        instructions: '',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects over-long instructions', () => {
    const svc = build();
    expect(() =>
      svc.createSkill({
        name: 'ok',
        kind: 'instruction',
        instructions: 'x'.repeat(skillsDefaults.maxInstructionsLength + 1),
      }),
    ).toThrow(ValidationError);
  });

  it('throws when getting an unknown skill', () => {
    expect(() => build().getSkill('nope')).toThrow(NotFoundError);
  });

  it('updates an existing skill', () => {
    const svc = build();
    const skill = svc.createSkill({
      name: 'A',
      kind: 'instruction',
      instructions: 'old',
    });
    const updated = svc.updateSkill(skill.id, { name: 'B', instructions: 'new' });
    expect(updated.name).toBe('B');
    expect(updated.instructions).toBe('new');
  });

  it('throws when updating an unknown skill', () => {
    expect(() =>
      build().updateSkill('nope', { name: 'B', instructions: 'x' }),
    ).toThrow(NotFoundError);
  });

  it('deletes a skill and cascades its attachments', () => {
    const svc = build();
    const skill = svc.createSkill({
      name: 'A',
      kind: 'instruction',
      instructions: 'x',
    });
    svc.tag({ skillId: skill.id, scope: 'feature', targetId: 'f1' });
    svc.deleteSkill(skill.id);
    expect(svc.listSkills()).toEqual([]);
    expect(svc.listForFeature('f1')).toEqual([]);
  });

  it('throws when deleting an unknown skill', () => {
    expect(() => build().deleteSkill('nope')).toThrow(NotFoundError);
  });
});

describe('skills-service tagging', () => {
  it('tags a skill to a feature and is idempotent', () => {
    const svc = build();
    const skill = svc.createSkill({
      name: 'A',
      kind: 'instruction',
      instructions: 'x',
    });
    const first = svc.tag({ skillId: skill.id, scope: 'feature', targetId: 'f1' });
    const second = svc.tag({ skillId: skill.id, scope: 'feature', targetId: 'f1' });
    expect(second).toEqual(first);
    expect(svc.listForFeature('f1')).toEqual([{ ...skill, attachmentId: first.id }]);
  });

  it('tags a skill to a session', () => {
    const svc = build();
    const skill = svc.createSkill({
      name: 'A',
      kind: 'instruction',
      instructions: 'x',
    });
    const att = svc.tag({ skillId: skill.id, scope: 'session', targetId: 's1' });
    expect(svc.listForSession('s1')).toEqual([{ ...skill, attachmentId: att.id }]);
  });

  it('throws when tagging an unknown skill', () => {
    expect(() =>
      build().tag({ skillId: 'nope', scope: 'feature', targetId: 'f1' }),
    ).toThrow(NotFoundError);
  });

  it('throws when tagging to an unknown session', () => {
    const svc = build();
    const skill = svc.createSkill({
      name: 'A',
      kind: 'instruction',
      instructions: 'x',
    });
    expect(() =>
      svc.tag({ skillId: skill.id, scope: 'session', targetId: 'nope' }),
    ).toThrow(NotFoundError);
  });

  it('untags an attachment', () => {
    const svc = build();
    const skill = svc.createSkill({
      name: 'A',
      kind: 'instruction',
      instructions: 'x',
    });
    const att = svc.tag({ skillId: skill.id, scope: 'feature', targetId: 'f1' });
    svc.untag(att.id);
    expect(svc.listForFeature('f1')).toEqual([]);
  });

  it('throws when untagging an unknown attachment', () => {
    expect(() => build().untag('nope')).toThrow(NotFoundError);
  });

  it('throws when listing skills for an unknown session', () => {
    expect(() => build().listForSession('nope')).toThrow(NotFoundError);
  });

  it('throws when listing skills for an unknown feature', () => {
    expect(() => build().listForFeature('nope')).toThrow(NotFoundError);
  });

  it('ignores attachments whose skill was removed from the repo', () => {
    const svc = build();
    const skill = svc.createSkill({
      name: 'A',
      kind: 'instruction',
      instructions: 'x',
    });
    svc.tag({ skillId: skill.id, scope: 'feature', targetId: 'f1' });
    // Dangling attachment: references a skill id that isn't in the library.
    svc.__repo.createAttachment({
      id: 'dangling',
      skillId: 'ghost',
      scope: 'feature',
      targetId: 'f1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(svc.listForFeature('f1')).toEqual([
      { ...skill, attachmentId: expect.any(String) },
    ]);
  });
});

describe('skills-service effective set + injection', () => {
  it('unions session and feature skills, de-duplicated', () => {
    const svc = build();
    const shared = svc.createSkill({
      name: 'Shared',
      kind: 'instruction',
      instructions: 's',
    });
    const featureOnly = svc.createSkill({
      name: 'FeatureOnly',
      kind: 'instruction',
      instructions: 'f',
    });
    svc.tag({ skillId: shared.id, scope: 'feature', targetId: 'f1' });
    svc.tag({ skillId: featureOnly.id, scope: 'feature', targetId: 'f1' });
    svc.tag({ skillId: shared.id, scope: 'session', targetId: 's1' });
    const effective = svc.effectiveForSession('s1');
    expect(effective.map((s) => s.id).sort()).toEqual(
      [shared.id, featureOnly.id].sort(),
    );
  });

  it('throws for an unknown session in the effective set', () => {
    expect(() => build().effectiveForSession('nope')).toThrow(NotFoundError);
  });

  it('composes a feature instruction block', () => {
    const svc = build();
    const skill = svc.createSkill({
      name: 'Style',
      kind: 'instruction',
      instructions: 'Be concise.',
    });
    svc.tag({ skillId: skill.id, scope: 'feature', targetId: 'f1' });
    const block = svc.instructionsForFeature('f1');
    expect(block).toContain('Be concise.');
    expect(svc.instructionsForFeature('f1')).toContain(
      skillsDefaults.injectionHeader,
    );
  });

  it('prepends feature instructions to a prompt', () => {
    const svc = build();
    const skill = svc.createSkill({
      name: 'Style',
      kind: 'instruction',
      instructions: 'Be concise.',
    });
    svc.tag({ skillId: skill.id, scope: 'feature', targetId: 'f1' });
    const composed = svc.composeFeaturePrompt('f1', 'Build login');
    expect(composed).toContain('Be concise.');
    expect(composed).toContain('Build login');
  });

  it('leaves the prompt unchanged when the feature has no skills', () => {
    const svc = build();
    expect(svc.composeFeaturePrompt('f1', 'Build login')).toBe('Build login');
  });

  it('composes a session instruction block from the effective set', () => {
    const svc = build();
    const featureSkill = svc.createSkill({
      name: 'FeatureRule',
      kind: 'instruction',
      instructions: 'Feature rule.',
    });
    const sessionSkill = svc.createSkill({
      name: 'SessionRule',
      kind: 'instruction',
      instructions: 'Session rule.',
    });
    svc.tag({ skillId: featureSkill.id, scope: 'feature', targetId: 'f1' });
    svc.tag({ skillId: sessionSkill.id, scope: 'session', targetId: 's1' });
    const block = svc.instructionsForSession('s1');
    expect(block).toContain('Feature rule.');
    expect(block).toContain('Session rule.');
  });

  it('returns an empty session instruction block when nothing is tagged', () => {
    expect(build().instructionsForSession('s1')).toBe('');
  });

  it('composes a single skill block for live injection', () => {
    const svc = build();
    const skill = svc.createSkill({
      name: 'SessionRule',
      kind: 'instruction',
      instructions: 'Session rule.',
    });
    const block = svc.instructionsForSkill(skill.id);
    expect(block).toContain('Session rule.');
    expect(block).toContain(skillsDefaults.injectionHeader);
  });

  it('returns an empty block for an unknown skill id', () => {
    expect(build().instructionsForSkill('nope')).toBe('');
  });

  it('returns an empty block for a non-instruction (task-plan) skill', () => {
    const svc = build();
    const skill = svc.createSkill({
      name: 'Plan',
      kind: 'task-plan',
      instructions: 'ignored',
    });
    expect(svc.instructionsForSkill(skill.id)).toBe('');
  });
});

describe('skills-service portability', () => {
  it('exports a single skill and all skills', () => {
    const svc = build();
    const skill = svc.createSkill({
      name: 'A',
      kind: 'instruction',
      instructions: 'x',
    });
    expect(svc.exportSkill(skill.id)).toEqual({
      schemaVersion: skillsDefaults.exportSchemaVersion,
      name: 'A',
      kind: 'instruction',
      instructions: 'x',
    });
    expect(svc.exportAll()).toHaveLength(1);
  });

  it('imports a valid skill', () => {
    const svc = build();
    const imported = svc.importSkill({
      schemaVersion: skillsDefaults.exportSchemaVersion,
      name: 'Imported',
      kind: 'instruction',
      instructions: 'y',
    });
    expect(imported.name).toBe('Imported');
    expect(svc.listSkills()).toHaveLength(1);
  });

  it('rejects a malformed payload', () => {
    expect(() => build().importSkill({ nope: true })).toThrow(ValidationError);
  });

  it('rejects an unsupported schema version', () => {
    expect(() =>
      build().importSkill({
        schemaVersion: skillsDefaults.exportSchemaVersion + 1,
        name: 'X',
        kind: 'instruction',
        instructions: 'y',
      }),
    ).toThrow(ValidationError);
  });

  it('renames on a single name conflict', () => {
    const svc = build();
    svc.createSkill({ name: 'Dup', kind: 'instruction', instructions: 'x' });
    const imported = svc.importSkill({
      schemaVersion: skillsDefaults.exportSchemaVersion,
      name: 'Dup',
      kind: 'instruction',
      instructions: 'y',
    });
    expect(imported.name).toBe(`Dup${skillsDefaults.importConflictSuffix}`);
  });

  it('appends a counter when the renamed name also collides', () => {
    const svc = build();
    svc.createSkill({ name: 'Dup', kind: 'instruction', instructions: 'x' });
    svc.createSkill({
      name: `Dup${skillsDefaults.importConflictSuffix}`,
      kind: 'instruction',
      instructions: 'x',
    });
    const imported = svc.importSkill({
      schemaVersion: skillsDefaults.exportSchemaVersion,
      name: 'Dup',
      kind: 'instruction',
      instructions: 'y',
    });
    expect(imported.name).toBe(`Dup${skillsDefaults.importConflictSuffix} 2`);
  });
});

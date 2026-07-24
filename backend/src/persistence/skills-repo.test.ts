import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createSkillsRepo } from './skills-repo.js';
import type { Skill, SkillAttachment } from '../skills/skills-contract.js';

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'k1',
    name: 'Testing',
    kind: 'instruction',
    instructions: 'Write tests.',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function attachment(overrides: Partial<SkillAttachment> = {}): SkillAttachment {
  return {
    id: 'a1',
    skillId: 'k1',
    scope: 'feature',
    targetId: 'f1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('skills-repo', () => {
  it('creates, reads, updates, lists and deletes skills', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSkillsRepo(db);

    repo.createSkill(skill());
    repo.createSkill(skill({ id: 'k2', name: 'Plan', kind: 'task-plan' }));
    expect(repo.getSkill('k1')).toEqual(skill());
    expect(repo.getSkill('missing')).toBeNull();
    expect(repo.listSkills().map((s) => s.id)).toEqual(['k1', 'k2']);

    repo.updateSkill('k1', { name: 'Renamed', instructions: 'New.' });
    expect(repo.getSkill('k1')).toEqual(
      skill({ name: 'Renamed', instructions: 'New.' }),
    );

    repo.deleteSkill('k2');
    expect(repo.listSkills().map((s) => s.id)).toEqual(['k1']);
    db.close();
  });

  it('creates, finds, lists and deletes attachments', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSkillsRepo(db);

    repo.createAttachment(attachment());
    repo.createAttachment(attachment({ id: 'a2', scope: 'session', targetId: 's1' }));
    expect(repo.getAttachment('a1')).toEqual(attachment());
    expect(repo.getAttachment('missing')).toBeNull();
    expect(repo.findAttachment('k1', 'feature', 'f1')).toEqual(attachment());
    expect(repo.findAttachment('k1', 'feature', 'other')).toBeNull();
    expect(repo.listAttachmentsByTarget('feature', 'f1').map((a) => a.id)).toEqual([
      'a1',
    ]);

    repo.deleteAttachment('a1');
    expect(repo.getAttachment('a1')).toBeNull();
    db.close();
  });

  it('deletes all attachments for a skill', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSkillsRepo(db);
    repo.createAttachment(attachment({ id: 'a1' }));
    repo.createAttachment(attachment({ id: 'a2', targetId: 'f2' }));
    repo.createAttachment(attachment({ id: 'a3', skillId: 'k9', targetId: 'f1' }));

    repo.deleteAttachmentsBySkill('k1');
    expect(repo.listAttachmentsByTarget('feature', 'f1').map((a) => a.id)).toEqual([
      'a3',
    ]);
    db.close();
  });
});

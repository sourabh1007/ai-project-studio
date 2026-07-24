import type { DatabaseSync } from 'node:sqlite';
import type {
  Skill,
  SkillAttachment,
  SkillKind,
  SkillScope,
} from '../skills/skills-contract.js';
import type { SkillsRepo } from '../skills/skills-repo-port.js';

interface SkillRow {
  id: string;
  name: string;
  kind: string;
  instructions: string;
  created_at: string;
}

interface AttachmentRow {
  id: string;
  skill_id: string;
  scope: string;
  target_id: string;
  created_at: string;
}

function mapSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as SkillKind,
    instructions: row.instructions,
    createdAt: row.created_at,
  };
}

function mapAttachment(row: AttachmentRow): SkillAttachment {
  return {
    id: row.id,
    skillId: row.skill_id,
    scope: row.scope as SkillScope,
    targetId: row.target_id,
    createdAt: row.created_at,
  };
}

/** SQLite-backed implementation of the SkillsRepo port. */
export function createSkillsRepo(db: DatabaseSync): SkillsRepo {
  const insertSkill = db.prepare(
    'INSERT INTO skills (id, name, kind, instructions, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const selectSkill = db.prepare('SELECT * FROM skills WHERE id = ?');
  const selectSkills = db.prepare('SELECT * FROM skills ORDER BY created_at, id');
  const updateSkillRow = db.prepare(
    'UPDATE skills SET name = ?, instructions = ? WHERE id = ?',
  );
  const deleteSkillRow = db.prepare('DELETE FROM skills WHERE id = ?');

  const insertAttachment = db.prepare(
    'INSERT INTO skill_attachments (id, skill_id, scope, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const selectAttachment = db.prepare('SELECT * FROM skill_attachments WHERE id = ?');
  const findAttachmentRow = db.prepare(
    'SELECT * FROM skill_attachments WHERE skill_id = ? AND scope = ? AND target_id = ?',
  );
  const deleteAttachmentRow = db.prepare('DELETE FROM skill_attachments WHERE id = ?');
  const deleteAttachmentsBySkillRow = db.prepare(
    'DELETE FROM skill_attachments WHERE skill_id = ?',
  );
  const selectAttachmentsByTarget = db.prepare(
    'SELECT * FROM skill_attachments WHERE scope = ? AND target_id = ? ORDER BY created_at, id',
  );

  return {
    createSkill(skill) {
      insertSkill.run(
        skill.id,
        skill.name,
        skill.kind,
        skill.instructions,
        skill.createdAt,
      );
    },
    getSkill(id) {
      const row = selectSkill.get(id) as SkillRow | undefined;
      return row ? mapSkill(row) : null;
    },
    listSkills() {
      return (selectSkills.all() as unknown as SkillRow[]).map(mapSkill);
    },
    updateSkill(id, patch) {
      updateSkillRow.run(patch.name, patch.instructions, id);
    },
    deleteSkill(id) {
      deleteSkillRow.run(id);
    },
    createAttachment(attachment) {
      insertAttachment.run(
        attachment.id,
        attachment.skillId,
        attachment.scope,
        attachment.targetId,
        attachment.createdAt,
      );
    },
    getAttachment(id) {
      const row = selectAttachment.get(id) as AttachmentRow | undefined;
      return row ? mapAttachment(row) : null;
    },
    findAttachment(skillId, scope, targetId) {
      const row = findAttachmentRow.get(skillId, scope, targetId) as
        | AttachmentRow
        | undefined;
      return row ? mapAttachment(row) : null;
    },
    deleteAttachment(id) {
      deleteAttachmentRow.run(id);
    },
    deleteAttachmentsBySkill(skillId) {
      deleteAttachmentsBySkillRow.run(skillId);
    },
    listAttachmentsByTarget(scope, targetId) {
      return (
        selectAttachmentsByTarget.all(scope, targetId) as unknown as AttachmentRow[]
      ).map(mapAttachment);
    },
  };
}

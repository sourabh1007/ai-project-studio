import type {
  Skill,
  SkillAttachment,
  SkillScope,
} from './skills-contract.js';

/** Persistence port for the skills library and its attachments. */
export interface SkillsRepo {
  createSkill(skill: Skill): void;
  getSkill(id: string): Skill | null;
  listSkills(): Skill[];
  updateSkill(
    id: string,
    patch: { name: string; instructions: string; removalInstructions: string },
  ): void;
  deleteSkill(id: string): void;

  createAttachment(attachment: SkillAttachment): void;
  getAttachment(id: string): SkillAttachment | null;
  findAttachment(
    skillId: string,
    scope: SkillScope,
    targetId: string,
  ): SkillAttachment | null;
  deleteAttachment(id: string): void;
  deleteAttachmentsBySkill(skillId: string): void;
  listAttachmentsByTarget(scope: SkillScope, targetId: string): SkillAttachment[];
}

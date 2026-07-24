/** A reusable, named unit of AI guidance that can be tagged to features/sessions. */
export type SkillKind = 'instruction' | 'task-plan';

/** Where a skill is tagged: to a whole feature or to a single session. */
export type SkillScope = 'feature' | 'session';

export interface Skill {
  id: string;
  name: string;
  kind: SkillKind;
  /** The instruction text injected into sessions (for `instruction` skills). */
  instructions: string;
  createdAt: string;
}

/** A skill tagged to a target (a feature id or a session id). */
export interface SkillAttachment {
  id: string;
  skillId: string;
  scope: SkillScope;
  targetId: string;
  createdAt: string;
}

/** A skill listed for a target, carrying the attachment id used to untag it. */
export interface TaggedSkill extends Skill {
  attachmentId: string;
}

export interface CreateSkillInput {
  name: string;
  kind: SkillKind;
  instructions: string;
}

export interface UpdateSkillInput {
  name: string;
  instructions: string;
}

export interface TagSkillInput {
  skillId: string;
  scope: SkillScope;
  targetId: string;
}

/** Portable representation of a skill for upload/download. */
export interface SkillExport {
  schemaVersion: number;
  name: string;
  kind: SkillKind;
  instructions: string;
}

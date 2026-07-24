import { z } from 'zod';
import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { Clock } from '../kernel/clock.js';
import type { IdGenerator } from '../kernel/id-generator.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { SkillsConfig } from './config.js';
import type {
  CreateSkillInput,
  Skill,
  SkillAttachment,
  SkillExport,
  SkillScope,
  TaggedSkill,
  TagSkillInput,
  UpdateSkillInput,
} from './skills-contract.js';
import type { SkillsRepo } from './skills-repo-port.js';
import { composeInstructions, composeSessionPrompt } from './skill-prompt-composer.js';

export interface SkillsServiceDeps {
  repo: SkillsRepo;
  ids: IdGenerator;
  clock: Clock;
  features: FeatureService;
  sessions: SessionRepo;
  config: SkillsConfig;
}

export interface SkillsService {
  createSkill(input: CreateSkillInput): Skill;
  getSkill(id: string): Skill;
  listSkills(): Skill[];
  updateSkill(id: string, input: UpdateSkillInput): Skill;
  deleteSkill(id: string): void;
  tag(input: TagSkillInput): SkillAttachment;
  untag(attachmentId: string): void;
  listForFeature(featureId: string): TaggedSkill[];
  listForSession(sessionId: string): TaggedSkill[];
  effectiveForSession(sessionId: string): Skill[];
  /** Composed instruction block for a session's effective instruction skills. */
  instructionsForSession(sessionId: string): string;
  /** Composed instruction block for a feature's tagged instruction skills. */
  instructionsForFeature(featureId: string): string;
  /**
   * Prepends a feature's instruction skills to a prompt. Returns the prompt
   * unchanged when the feature has no instruction skills.
   */
  composeFeaturePrompt(featureId: string, prompt: string): string;
  exportSkill(id: string): SkillExport;
  exportAll(): SkillExport[];
  importSkill(payload: unknown): Skill;
}

/** Application service for the central skills library and its attachments. */
export function createSkillsService(deps: SkillsServiceDeps): SkillsService {
  const importSchema = z.object({
    schemaVersion: z.number(),
    name: z.string().min(1),
    kind: z.enum(['instruction', 'task-plan']),
    instructions: z.string(),
  });

  const requireSkill = (id: string): Skill => {
    const skill = deps.repo.getSkill(id);
    if (!skill) {
      throw new NotFoundError(`Unknown skill: ${id}`);
    }
    return skill;
  };

  const requireTarget = (scope: SkillScope, targetId: string): void => {
    if (scope === 'feature') {
      // Throws NotFoundError when the feature does not exist.
      deps.features.get(targetId);
      return;
    }
    if (!deps.sessions.get(targetId)) {
      throw new NotFoundError(`Unknown session: ${targetId}`);
    }
  };

  const validateName = (name: string): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new ValidationError('Skill name must not be empty');
    }
    if (trimmed.length > deps.config.maxNameLength) {
      throw new ValidationError(
        `Skill name exceeds ${deps.config.maxNameLength} characters`,
      );
    }
  };

  const validateInstructions = (instructions: string): void => {
    if (instructions.length > deps.config.maxInstructionsLength) {
      throw new ValidationError(
        `Skill instructions exceed ${deps.config.maxInstructionsLength} characters`,
      );
    }
  };

  const skillsForTarget = (scope: SkillScope, targetId: string): Skill[] =>
    deps.repo
      .listAttachmentsByTarget(scope, targetId)
      .map((attachment) => deps.repo.getSkill(attachment.skillId))
      .filter((skill): skill is Skill => skill !== null);

  const taggedSkillsForTarget = (
    scope: SkillScope,
    targetId: string,
  ): TaggedSkill[] =>
    deps.repo
      .listAttachmentsByTarget(scope, targetId)
      .map((attachment) => {
        const skill = deps.repo.getSkill(attachment.skillId);
        return skill ? { ...skill, attachmentId: attachment.id } : null;
      })
      .filter((skill): skill is TaggedSkill => skill !== null);

  const effectiveForSession = (sessionId: string): Skill[] => {
    const session = deps.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundError(`Unknown session: ${sessionId}`);
    }
    const byId = new Map<string, Skill>();
    for (const skill of skillsForTarget('feature', session.featureId)) {
      byId.set(skill.id, skill);
    }
    for (const skill of skillsForTarget('session', sessionId)) {
      byId.set(skill.id, skill);
    }
    return [...byId.values()];
  };

  const uniqueName = (name: string): string => {
    const taken = new Set(deps.repo.listSkills().map((skill) => skill.name));
    if (!taken.has(name)) {
      return name;
    }
    let candidate = `${name}${deps.config.importConflictSuffix}`;
    let counter = 2;
    while (taken.has(candidate)) {
      candidate = `${name}${deps.config.importConflictSuffix} ${counter}`;
      counter += 1;
    }
    return candidate;
  };

  return {
    createSkill(input) {
      validateName(input.name);
      validateInstructions(input.instructions);
      const skill: Skill = {
        id: deps.ids.next(),
        name: input.name.trim(),
        kind: input.kind,
        instructions: input.instructions,
        createdAt: deps.clock.isoNow(),
      };
      deps.repo.createSkill(skill);
      return skill;
    },
    getSkill(id) {
      return requireSkill(id);
    },
    listSkills() {
      return deps.repo.listSkills();
    },
    updateSkill(id, input) {
      requireSkill(id);
      validateName(input.name);
      validateInstructions(input.instructions);
      deps.repo.updateSkill(id, {
        name: input.name.trim(),
        instructions: input.instructions,
      });
      return requireSkill(id);
    },
    deleteSkill(id) {
      requireSkill(id);
      deps.repo.deleteAttachmentsBySkill(id);
      deps.repo.deleteSkill(id);
    },
    tag(input) {
      requireSkill(input.skillId);
      requireTarget(input.scope, input.targetId);
      const existing = deps.repo.findAttachment(
        input.skillId,
        input.scope,
        input.targetId,
      );
      if (existing) {
        return existing;
      }
      const attachment: SkillAttachment = {
        id: deps.ids.next(),
        skillId: input.skillId,
        scope: input.scope,
        targetId: input.targetId,
        createdAt: deps.clock.isoNow(),
      };
      deps.repo.createAttachment(attachment);
      return attachment;
    },
    untag(attachmentId) {
      if (!deps.repo.getAttachment(attachmentId)) {
        throw new NotFoundError(`Unknown skill attachment: ${attachmentId}`);
      }
      deps.repo.deleteAttachment(attachmentId);
    },
    listForFeature(featureId) {
      deps.features.get(featureId);
      return taggedSkillsForTarget('feature', featureId);
    },
    listForSession(sessionId) {
      requireTarget('session', sessionId);
      return taggedSkillsForTarget('session', sessionId);
    },
    effectiveForSession(sessionId) {
      return effectiveForSession(sessionId);
    },
    instructionsForFeature(featureId) {
      return composeInstructions(
        skillsForTarget('feature', featureId),
        deps.config,
      );
    },
    instructionsForSession(sessionId) {
      return composeInstructions(effectiveForSession(sessionId), deps.config);
    },
    composeFeaturePrompt(featureId, prompt) {
      return composeSessionPrompt(
        composeInstructions(skillsForTarget('feature', featureId), deps.config),
        prompt,
        deps.config,
      );
    },
    exportSkill(id) {
      const skill = requireSkill(id);
      return {
        schemaVersion: deps.config.exportSchemaVersion,
        name: skill.name,
        kind: skill.kind,
        instructions: skill.instructions,
      };
    },
    exportAll() {
      return deps.repo.listSkills().map((skill) => ({
        schemaVersion: deps.config.exportSchemaVersion,
        name: skill.name,
        kind: skill.kind,
        instructions: skill.instructions,
      }));
    },
    importSkill(payload) {
      const parsed = importSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ValidationError('Invalid skill file', parsed.error.flatten());
      }
      if (parsed.data.schemaVersion !== deps.config.exportSchemaVersion) {
        throw new ValidationError(
          `Unsupported skill schema version: ${parsed.data.schemaVersion}`,
        );
      }
      validateName(parsed.data.name);
      validateInstructions(parsed.data.instructions);
      const skill: Skill = {
        id: deps.ids.next(),
        name: uniqueName(parsed.data.name.trim()),
        kind: parsed.data.kind,
        instructions: parsed.data.instructions,
        createdAt: deps.clock.isoNow(),
      };
      deps.repo.createSkill(skill);
      return skill;
    },
  };
}

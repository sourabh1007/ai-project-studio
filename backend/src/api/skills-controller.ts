import { z } from 'zod';
import type { SkillsService } from '../skills/skills-service.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

const createSkillSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['instruction', 'task-plan']),
  instructions: z.string(),
  removalInstructions: z.string().optional(),
});

const updateSkillSchema = z.object({
  name: z.string().min(1),
  instructions: z.string(),
  removalInstructions: z.string().optional(),
});

const tagSkillSchema = z.object({
  scope: z.enum(['feature', 'session']),
  targetId: z.string().min(1),
});

export interface SkillsControllerDeps {
  skills: SkillsService;
  /**
   * Applies a freshly-tagged session skill to that session's live terminal, if
   * one is running. Session-scoped skills can only be tagged once the session
   * is open, so launch-time seeding never sees them; injecting on tag is what
   * makes them take effect. Optional so the controller stays usable in
   * contexts without a terminal manager.
   */
  injectSessionSkill?: (sessionId: string, skillId: string) => void;
  /**
   * Applies a skill's removal reaction to a session's live terminal when a
   * session-scoped skill is untagged, so its guidance is actively reversed
   * (e.g. "stop following X" / "cancel the plan"). Optional, mirroring
   * {@link injectSessionSkill}.
   */
  removeSessionSkill?: (sessionId: string, skillId: string) => void;
}

/**
 * Routes for the central skills library: CRUD, tag/untag to a feature or
 * session, list by target, and JSON export/import. More specific paths are
 * listed before parameterized ones so `/skills/export` is not swallowed by
 * `/skills/:id`.
 */
export function createSkillsRoutes(deps: SkillsControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/skills/export',
      handler: () => ({ status: 200, body: deps.skills.exportAll() }),
    },
    {
      method: 'post',
      path: '/skills/import',
      handler: (req) => ({
        status: 201,
        body: deps.skills.importSkill(req.body),
      }),
    },
    {
      method: 'get',
      path: '/skills',
      handler: () => ({ status: 200, body: deps.skills.listSkills() }),
    },
    {
      method: 'post',
      path: '/skills',
      handler: (req) => {
        const input = parseInput(createSkillSchema, req.body);
        return { status: 201, body: deps.skills.createSkill(input) };
      },
    },
    {
      method: 'get',
      path: '/skills/:id/export',
      handler: (req) => ({
        status: 200,
        body: deps.skills.exportSkill(req.params.id),
      }),
    },
    {
      method: 'get',
      path: '/skills/:id',
      handler: (req) => ({
        status: 200,
        body: deps.skills.getSkill(req.params.id),
      }),
    },
    {
      method: 'put',
      path: '/skills/:id',
      handler: (req) => {
        const input = parseInput(updateSkillSchema, req.body);
        return { status: 200, body: deps.skills.updateSkill(req.params.id, input) };
      },
    },
    {
      method: 'delete',
      path: '/skills/:id',
      handler: (req) => {
        deps.skills.deleteSkill(req.params.id);
        return { status: 200, body: { id: req.params.id } };
      },
    },
    {
      method: 'post',
      path: '/skills/:id/attachments',
      handler: (req) => {
        const input = parseInput(tagSkillSchema, req.body);
        const attachment = deps.skills.tag({ skillId: req.params.id, ...input });
        if (input.scope === 'session') {
          deps.injectSessionSkill?.(input.targetId, req.params.id);
        }
        return { status: 201, body: attachment };
      },
    },
    {
      method: 'delete',
      path: '/skills/attachments/:attachmentId',
      handler: (req) => {
        // Resolve the attachment before deleting so a session-scoped removal can
        // be reversed on the live terminal.
        const attachment = deps.skills.getAttachment(req.params.attachmentId);
        deps.skills.untag(req.params.attachmentId);
        if (attachment?.scope === 'session') {
          deps.removeSessionSkill?.(attachment.targetId, attachment.skillId);
        }
        return { status: 200, body: { id: req.params.attachmentId } };
      },
    },
    {
      method: 'get',
      path: '/features/:featureId/skills',
      handler: (req) => ({
        status: 200,
        body: deps.skills.listForFeature(req.params.featureId),
      }),
    },
    {
      method: 'get',
      path: '/sessions/:sessionId/skills',
      handler: (req) => ({
        status: 200,
        body: deps.skills.listForSession(req.params.sessionId),
      }),
    },
  ];
}

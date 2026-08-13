import type { Route } from './http-contract.js';
import type { AutomationService } from '../automation/automation-service.js';
import type { SubagentService } from '../automation/subagent-service.js';
import { ValidationError } from '../kernel/error-types.js';
import {
  assertCreateAutomationInput,
  assertErrorBody,
  assertPlannedStepsBody,
  assertProgressBody,
  assertRegisterSubagentBody,
  assertResultBody,
} from '../automation/automation-input.js';

export interface AutomationControllerDeps {
  automations: AutomationService;
  subagents: SubagentService;
  controlToken?: string;
}

export const STUDIO_CONTROL_TOKEN_HEADER = 'x-studio-control-token';

function assertControlToken(
  req: Parameters<Route['handler']>[0],
  expected: string | undefined,
): void {
  if (expected === undefined) {
    return;
  }
  const actual = req.headers?.[STUDIO_CONTROL_TOKEN_HEADER];
  if (actual !== expected) {
    throw new ValidationError('Invalid Studio control token');
  }
}

/**
 * REST routes backing the **Automations** menu and the in-session MCP bridge.
 *
 * The local UI drives read + lifecycle routes (list/read/pause/resume/cancel/
 * run/delete) without a secret. The authoring routes the in-session AI uses via
 * the Studio MCP server (create + progress + planned-steps + subagent
 * registration/progress/complete/fail) are guarded by a per-launch control
 * token so only the Studio-spawned MCP server — not arbitrary local processes —
 * can create monitors that execute shell/AI work.
 */
export function createAutomationRoutes(
  deps: AutomationControllerDeps,
): Route[] {
  return [
    {
      method: 'get',
      path: '/automations',
      handler: () => ({
        status: 200,
        body: {
          automations: deps.automations.list(),
          subagents: deps.subagents.list(),
        },
      }),
    },
    {
      method: 'get',
      path: '/automations/:id',
      handler: (req) => ({
        status: 200,
        body: {
          automation: deps.automations.get(req.params.id),
          runs: deps.automations.listRuns(req.params.id),
          subagents: deps.subagents.listByAutomation(req.params.id),
        },
      }),
    },
    {
      method: 'post',
      path: '/automations',
      handler: async (req) => {
        assertControlToken(req, deps.controlToken);
        return {
          status: 201,
          body: deps.automations.create(assertCreateAutomationInput(req.body)),
        };
      },
    },
    {
      method: 'post',
      path: '/automations/:id/progress',
      handler: async (req) => {
        assertControlToken(req, deps.controlToken);
        return {
          status: 200,
          body: deps.automations.updateProgress(
            req.params.id,
            assertProgressBody(req.body),
          ),
        };
      },
    },
    {
      method: 'post',
      path: '/automations/:id/planned-steps',
      handler: async (req) => {
        assertControlToken(req, deps.controlToken);
        return {
          status: 200,
          body: deps.automations.setPlannedSteps(
            req.params.id,
            assertPlannedStepsBody(req.body),
          ),
        };
      },
    },
    {
      method: 'post',
      path: '/automations/:id/subagents',
      handler: async (req) => {
        assertControlToken(req, deps.controlToken);
        return {
          status: 201,
          body: deps.subagents.register(
            assertRegisterSubagentBody(req.body, req.params.id),
          ),
        };
      },
    },
    {
      method: 'post',
      path: '/automations/:id/pause',
      handler: (req) => ({
        status: 200,
        body: deps.automations.pause(req.params.id),
      }),
    },
    {
      method: 'post',
      path: '/automations/:id/resume',
      handler: (req) => ({
        status: 200,
        body: deps.automations.resume(req.params.id),
      }),
    },
    {
      method: 'post',
      path: '/automations/:id/cancel',
      handler: (req) => ({
        status: 200,
        body: deps.automations.cancel(req.params.id),
      }),
    },
    {
      method: 'post',
      path: '/automations/:id/run',
      handler: (req) => ({
        status: 200,
        body: deps.automations.runNow(req.params.id),
      }),
    },
    {
      method: 'post',
      path: '/subagents/:id/progress',
      handler: async (req) => {
        assertControlToken(req, deps.controlToken);
        return {
          status: 200,
          body: deps.subagents.updateProgress(
            req.params.id,
            assertProgressBody(req.body),
          ),
        };
      },
    },
    {
      method: 'post',
      path: '/subagents/:id/complete',
      handler: async (req) => {
        assertControlToken(req, deps.controlToken);
        return {
          status: 200,
          body: deps.subagents.complete(req.params.id, assertResultBody(req.body)),
        };
      },
    },
    {
      method: 'post',
      path: '/subagents/:id/fail',
      handler: async (req) => {
        assertControlToken(req, deps.controlToken);
        return {
          status: 200,
          body: deps.subagents.fail(req.params.id, assertErrorBody(req.body)),
        };
      },
    },
    {
      method: 'delete',
      path: '/automations/:id',
      handler: (req) => {
        deps.automations.remove(req.params.id);
        return { status: 200, body: { id: req.params.id } };
      },
    },
  ];
}

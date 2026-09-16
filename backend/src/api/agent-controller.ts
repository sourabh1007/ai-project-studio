import { ValidationError } from '../kernel/error-types.js';
import type { AgentService } from '../agents/agent-service.js';
import type { Route } from './http-contract.js';

export interface AgentControllerDeps {
  agents: AgentService;
}

/** Extracts and validates the `{ agentId }` of an attach request. */
function assertAttach(body: unknown): { agentId: string } {
  const agentId = (body as { agentId?: unknown })?.agentId;
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    throw new ValidationError('A non-empty "agentId" is required.');
  }
  return { agentId };
}

/**
 * Routes for the Agent platform: the management catalog (with rolled-up usage),
 * and the per-feature attach/detach flow that lets a user attach an agent like
 * the Review Board to any eligible feature.
 */
export function createAgentRoutes(deps: AgentControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/agents',
      handler: () => ({ status: 200, body: deps.agents.listCatalog() }),
    },
    {
      method: 'get',
      path: '/agents/:agentId',
      handler: (req) => ({
        status: 200,
        body: deps.agents.getCatalogItem(req.params.agentId),
      }),
    },
    {
      method: 'get',
      path: '/features/:featureId/agents',
      handler: (req) => ({
        status: 200,
        body: deps.agents.attachedAgents(req.params.featureId),
      }),
    },
    {
      method: 'get',
      path: '/features/:featureId/agents/available',
      handler: (req) => ({
        status: 200,
        body: deps.agents.availableAgents(req.params.featureId),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/agents',
      handler: (req) => {
        const { agentId } = assertAttach(req.body);
        return {
          status: 201,
          body: deps.agents.attach(req.params.featureId, agentId),
        };
      },
    },
    {
      method: 'delete',
      path: '/agents/attachments/:attachmentId',
      handler: (req) => {
        deps.agents.detach(req.params.attachmentId);
        return { status: 200, body: { id: req.params.attachmentId } };
      },
    },
  ];
}

import { assertCreateAutomationInput, assertRegisterSubagentBody } from '../automation/automation-input.js';
import type { AutomationOrigin } from '../automation/automation-contract.js';
import type { AutomationService } from '../automation/automation-service.js';
import type { SubagentService } from '../automation/subagent-service.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { FeatureTasksRepo } from '../feature-tasks/feature-tasks-repo-port.js';
import type { FeatureGroupsRepo } from '../feature-tree/feature-groups-repo-port.js';
import { NotFoundError } from '../kernel/error-types.js';
import type {
  ApplicationWorkOwnership,
  ApplicationWorkScope,
} from '../lifecycle/application-work.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { SkillsService } from '../skills/skills-service.js';
import type { HttpRequest, Route } from './http-contract.js';

export interface ApplicationRouteOwner {
  own<T>(
    run: (signal: AbortSignal) => T | Promise<T>,
    scope?: ApplicationWorkScope,
    ownership?: ApplicationWorkOwnership,
  ): Promise<T>;
}

export interface RouteOwnershipDeps {
  features: Pick<FeatureService, 'get'>;
  sessions: Pick<SessionRepo, 'get'>;
  taskLookup: Pick<FeatureTasksRepo, 'get'>;
  groupLookup: Pick<FeatureGroupsRepo, 'get'>;
  skills: Pick<SkillsService, 'getAttachment'>;
  automations: Pick<AutomationService, 'get'>;
  subagents: Pick<SubagentService, 'get'>;
}

function signature(route: Pick<Route, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

function appendUnique(target: string[], value: string | null | undefined): void {
  if (value && !target.includes(value)) {
    target.push(value);
  }
}

function combineScopes(
  ...scopes: readonly ApplicationWorkScope[]
): ApplicationWorkScope {
  const featureIds: string[] = [];
  const sessionIds: string[] = [];
  const collect = (
    values: readonly (string | null | undefined)[],
    target: string[],
  ) => {
    for (const value of values) {
      appendUnique(target, value);
    }
  };
  for (const scope of scopes) {
    collect([scope.featureId, ...(scope.featureIds ?? [])], featureIds);
    collect([scope.sessionId, ...(scope.sessionIds ?? [])], sessionIds);
  }
  const combined: ApplicationWorkScope = {};
  if (featureIds.length === 1) {
    combined.featureId = featureIds[0];
  } else if (featureIds.length > 1) {
    combined.featureIds = featureIds;
  }
  if (sessionIds.length === 1) {
    combined.sessionId = sessionIds[0];
  } else if (sessionIds.length > 1) {
    combined.sessionIds = sessionIds;
  }
  return combined;
}

function featureScope(featureId: string | null | undefined): ApplicationWorkScope {
  return featureId ? { featureId } : {};
}

function originScope(origin: AutomationOrigin): ApplicationWorkScope {
  return combineScopes(
    featureScope(origin.featureId),
    origin.sessionId ? { sessionId: origin.sessionId } : {},
  );
}

function requireSessionScope(
  deps: Pick<RouteOwnershipDeps, 'sessions'>,
  sessionId: string,
): ApplicationWorkScope {
  const session = deps.sessions.get(sessionId);
  if (!session) {
    throw new NotFoundError(`Unknown session: ${sessionId}`);
  }
  return combineScopes({ featureId: session.featureId }, { sessionId });
}

function requireTaskFeatureId(
  deps: Pick<RouteOwnershipDeps, 'taskLookup'>,
  taskId: string,
): string {
  const task = deps.taskLookup.get(taskId);
  if (!task) {
    throw new NotFoundError(`Unknown task: ${taskId}`);
  }
  return task.featureId;
}

function requireGroupFeatureId(
  deps: Pick<RouteOwnershipDeps, 'groupLookup'>,
  groupId: string,
): string {
  const group = deps.groupLookup.get(groupId);
  if (!group) {
    throw new NotFoundError(`Unknown group: ${groupId}`);
  }
  return group.featureId;
}

function requireAutomationScope(
  deps: Pick<RouteOwnershipDeps, 'automations'>,
  automationId: string,
): ApplicationWorkScope {
  return originScope(deps.automations.get(automationId).origin);
}

function requireSubagentScope(
  deps: Pick<RouteOwnershipDeps, 'subagents'>,
  subagentId: string,
): ApplicationWorkScope {
  return originScope(deps.subagents.get(subagentId).origin);
}

function scopeFromAttachment(
  deps: Pick<RouteOwnershipDeps, 'skills'>,
  attachmentId: string,
): ApplicationWorkScope {
  const attachment = deps.skills.getAttachment(attachmentId);
  if (!attachment) {
    throw new NotFoundError(`Unknown skill attachment: ${attachmentId}`);
  }
  return attachment.scope === 'feature'
    ? featureScope(attachment.targetId)
    : { sessionId: attachment.targetId };
}

function record(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

function stringField(
  body: unknown,
  key: string,
): string | null {
  const value = record(body)?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function skillTagScope(body: unknown): ApplicationWorkScope {
  const scope = stringField(body, 'scope');
  const targetId = stringField(body, 'targetId');
  if (!targetId) {
    return {};
  }
  return scope === 'feature'
    ? featureScope(targetId)
    : scope === 'session'
      ? { sessionId: targetId }
      : {};
}

function contextScope(request: HttpRequest): ApplicationWorkScope {
  return request.params.scope === 'feature'
    ? featureScope(stringField(request.body, 'scopeId'))
    : {};
}

function featureMoveScope(request: HttpRequest): ApplicationWorkScope {
  return combineScopes(
    featureScope(request.params.id),
    featureScope(stringField(request.body, 'targetParentFeatureId')),
  );
}

function repoPullScope(request: HttpRequest): ApplicationWorkScope {
  return featureScope(stringField(request.body, 'parentFeatureId'));
}

function treeMoveScope(
  deps: Pick<RouteOwnershipDeps, 'sessions' | 'groupLookup'>,
  request: HttpRequest,
): ApplicationWorkScope {
  const body = record(request.body);
  if (!body) {
    return {};
  }
  const type = body.type;
  const id = typeof body.id === 'string' ? body.id : null;
  const targetFeatureId =
    typeof body.targetFeatureId === 'string' ? body.targetFeatureId : null;
  if (!id) {
    return targetFeatureId ? featureScope(targetFeatureId) : {};
  }
  const source =
    type === 'session'
      ? requireSessionScope(deps, id)
      : type === 'group'
        ? featureScope(requireGroupFeatureId(deps, id))
        : {};
  return combineScopes(source, featureScope(targetFeatureId));
}

function automationCreateScope(request: HttpRequest): ApplicationWorkScope {
  return originScope(assertCreateAutomationInput(request.body).origin ?? {
    sessionId: null,
    featureId: null,
  });
}

function automationSubagentScope(
  deps: Pick<RouteOwnershipDeps, 'automations'>,
  request: HttpRequest,
): ApplicationWorkScope {
  return combineScopes(
    requireAutomationScope(deps, request.params.id),
    originScope(assertRegisterSubagentBody(request.body, request.params.id).origin),
  );
}

function mergeSignal(
  owned: AbortSignal,
  request: HttpRequest,
): AbortSignal {
  return request.signal ? AbortSignal.any([owned, request.signal]) : owned;
}

const FEATURE_ROUTE_SIGNATURES = [
  'post /features/:featureId/sessions',
  'post /features/:featureId/terminal-sessions',
  'post /features/:featureId/summary',
  'post /features/:featureId/import-session',
  'post /features/:featureId/tasks/generate',
  'post /features/:featureId/tasks',
  'post /features/:featureId/groups',
  'post /features/:featureId/pr-review/refresh',
  'post /features/:featureId/pr-review/pull-latest',
  'post /features/:featureId/pr-review/steps/:step/retry',
  'post /features/:featureId/pr-review/files/explain',
  'post /features/:featureId/pr-review/graph-chat',
  'post /features/:featureId/pr-review/approve',
  'post /features/:featureId/pr-review/export-description',
  'post /features/:featureId/pr-review/comments',
  'post /features/:featureId/pr-review/comments/:threadId/status',
  'post /features/:featureId/review-board/analyze',
  'post /features/:featureId/review-board/perspectives/:perspectiveId/analyze',
  'post /features/:featureId/review-board/chat',
] as const;

export function applyRouteOwnership(
  routes: readonly Route[],
  deps: RouteOwnershipDeps,
): Route[] {
  const featureScoped = new Set<string>(FEATURE_ROUTE_SIGNATURES);
  const ownership = new Map<string, Route['workScope']>([
    ['put /features/:id', (request) => featureScope(request.params.id)],
    ['delete /features/:id', (request) => featureScope(request.params.id)],
    ['post /features/:id/move', featureMoveScope],
    ['put /sessions/:id', (request) => requireSessionScope(deps, request.params.id)],
    ['delete /sessions/:id', (request) => requireSessionScope(deps, request.params.id)],
    ['post /features/:featureId/sessions/:sessionId/summary', (request) =>
      requireSessionScope(deps, request.params.sessionId)],
    ['post /skills/:id/attachments', (request) => skillTagScope(request.body)],
    ['delete /skills/attachments/:attachmentId', (request) =>
      scopeFromAttachment(deps, request.params.attachmentId)],
    ['put /tasks/:taskId', (request) =>
      featureScope(requireTaskFeatureId(deps, request.params.taskId))],
    ['delete /tasks/:taskId', (request) =>
      featureScope(requireTaskFeatureId(deps, request.params.taskId))],
    ['put /groups/:groupId', (request) =>
      featureScope(requireGroupFeatureId(deps, request.params.groupId))],
    ['delete /groups/:groupId', (request) =>
      featureScope(requireGroupFeatureId(deps, request.params.groupId))],
    ['post /tree/move', (request) => treeMoveScope(deps, request)],
    ['put /context/:scope', contextScope],
    ['post /context/:scope/remember', contextScope],
    ['post /automations', automationCreateScope],
    ['post /automations/:id/progress', (request) =>
      requireAutomationScope(deps, request.params.id)],
    ['post /automations/:id/planned-steps', (request) =>
      requireAutomationScope(deps, request.params.id)],
    ['post /automations/:id/subagents', (request) =>
      automationSubagentScope(deps, request)],
    ['post /automations/:id/pause', (request) =>
      requireAutomationScope(deps, request.params.id)],
    ['post /automations/:id/resume', (request) =>
      requireAutomationScope(deps, request.params.id)],
    ['post /automations/:id/cancel', (request) =>
      requireAutomationScope(deps, request.params.id)],
    ['post /automations/:id/run', (request) =>
      requireAutomationScope(deps, request.params.id)],
    ['post /automations/:id/interval', (request) =>
      requireAutomationScope(deps, request.params.id)],
    ['delete /automations/:id', (request) =>
      requireAutomationScope(deps, request.params.id)],
    ['post /subagents/:id/progress', (request) =>
      requireSubagentScope(deps, request.params.id)],
    ['post /subagents/:id/complete', (request) =>
      requireSubagentScope(deps, request.params.id)],
    ['post /subagents/:id/fail', (request) =>
      requireSubagentScope(deps, request.params.id)],
    ['post /repos/:id/pulls', repoPullScope],
  ]);

  return routes.map((route) => {
    const key = signature(route);
    const workScope = ownership.get(key)
      ?? (featureScoped.has(key)
        ? ((request: HttpRequest) => featureScope(request.params.featureId))
        : undefined);
    const workTrackScope =
      key === 'delete /features/:id' || key === 'delete /sessions/:id'
        ? (() => ({}))
        : route.workTrackScope;
    const workAllowBlockedScope =
      key === 'delete /features/:id' || key === 'delete /sessions/:id'
        ? true
        : route.workAllowBlockedScope;
    return workScope || workTrackScope || workAllowBlockedScope
      ? { ...route, workScope, workTrackScope, workAllowBlockedScope }
      : route;
  });
}

export function ownApplicationRoutes(
  routes: readonly Route[],
  owner: ApplicationRouteOwner,
): Route[] {
  return routes.map((route) => ({
    ...route,
    handler: async (request) => {
      const admissionScope = route.workScope ? await route.workScope(request) : {};
      const trackScope = route.workTrackScope ? await route.workTrackScope(request) : admissionScope;
      const ownership: ApplicationWorkOwnership = {
        trackScope,
        allowBlockedScope: route.workAllowBlockedScope === true,
      };
      return owner.own(
        (signal) => route.handler({ ...request, signal: mergeSignal(signal, request) }),
        admissionScope,
        ownership,
      );
    },
  }));
}

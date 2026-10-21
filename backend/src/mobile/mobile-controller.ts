import { z } from 'zod';
import type { Route } from '../api/http-contract.js';
import { ValidationError } from '../kernel/error-types.js';
import type { MobileService } from './mobile-service.js';

const uuid = z.string().uuid();
const create = z.object({ id: uuid, repoId: uuid, problem: z.string().trim().min(1).max(8000) }).strict();
const discussion = z.object({ id: uuid, text: z.string().trim().min(1).max(8000) }).strict();
const plan = z.object({ plan: z.string().min(1).max(200000) }).strict();
const implement = z.object({ planHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const publish = z.object({ approvalId: uuid }).strict();
const terminal = z.object({ confirmed: z.literal(true) }).strict();
const repository = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/),
  confirmed: z.literal(true),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError('Invalid mobile request.', result.error.flatten());
  return result.data;
}

export function createMobileRoutes(service: MobileService): Route[] {
  return [
    { method: 'get', path: '/bootstrap', handler: () => ({ status: 200, body: service.bootstrap() }) },
    { method: 'post', path: '/chats', handler: ({ body }) => ({ status: 202, body: service.create(parse(create, body)) }) },
    { method: 'get', path: '/chats/:id', handler: ({ params }) => ({ status: 200, body: service.get(parse(uuid, params.id)) }) },
    { method: 'post', path: '/chats/:id/messages', handler: ({ params, body }) =>
      ({ status: 202, body: service.discuss(parse(uuid, params.id), parse(discussion, body)) }) },
    { method: 'put', path: '/chats/:id/apply-plan', handler: ({ params, body }) =>
      ({ status: 200, body: service.applyPlan(parse(uuid, params.id), parse(plan, body).plan) }) },
    { method: 'post', path: '/chats/:id/implement', handler: ({ params, body }) =>
      ({ status: 202, body: service.implement(parse(uuid, params.id), parse(implement, body).planHash) }) },
    { method: 'post', path: '/chats/:id/publication-preview', handler: async ({ params, signal }) =>
      ({ status: 200, body: await service.preview(parse(uuid, params.id), signal) }) },
    { method: 'post', path: '/chats/:id/publish', handler: ({ params, body }) =>
      ({ status: 202, body: service.publish(parse(uuid, params.id), parse(publish, body).approvalId) }) },
    { method: 'post', path: '/chats/:id/cancel', handler: ({ params }) =>
      ({ status: 202, body: service.cancel(parse(uuid, params.id)) }) },
    { method: 'get', path: '/chats/:id/diff', handler: async ({ params, query }) =>
      ({ status: 200, body: await service.diff(parse(uuid, params.id), parse(z.string().min(1).max(1000), query.path)) }) },
    { method: 'post', path: '/chats/:id/terminal', handler: async ({ params, body }) =>
      ({ status: 200, body: await service.terminal(parse(uuid, params.id), parse(terminal, body).confirmed) }) },
    { method: 'post', path: '/chats/:id/terminal/close', handler: async ({ params }) =>
      ({ status: 200, body: await service.closeTerminal(parse(uuid, params.id)) }) },
    { method: 'post', path: '/chats/:id/retry-plan', handler: ({ params }) =>
      ({ status: 202, body: service.retryPlan(parse(uuid, params.id)) }) },
    { method: 'post', path: '/repositories', handler: async ({ body }) =>
      ({ status: 201, body: await service.importRepository(parse(repository, body).name) }) },
  ];
}

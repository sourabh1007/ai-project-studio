import { z } from 'zod';
import type { MetaOperationRepo } from '../meta/meta-operation-contract.js';
import type { MetaOperationsConfig } from '../meta/meta-operations-config.js';
import type { Route } from './http-contract.js';

export interface MetaOperationsControllerDeps {
  operations: Pick<MetaOperationRepo, 'listPage' | 'get'>;
  config: Pick<MetaOperationsConfig, 'defaultPageSize' | 'maxPageSize'>;
  microsoftSignedIn?: () => boolean;
}

export function createMetaOperationsRoutes(deps: MetaOperationsControllerDeps): Route[] {
  const identifier = z.string().min(1).max(512);
  const querySchema = z.object({
    runId: identifier.optional(),
    agentId: identifier.optional(),
    from: z.string().datetime().optional(), to: z.string().datetime().optional(),
    featureId: identifier.optional(), sessionId: identifier.optional(), automationId: identifier.optional(),
    after: identifier.optional(),
    limit: z.string().regex(/^[1-9]\d*$/).transform(Number)
      .pipe(z.number().int().min(1).max(deps.config.maxPageSize)).optional(),
  }).strict().refine((value) => value.from === undefined && value.to === undefined ||
    value.from !== undefined && value.to !== undefined && Date.parse(value.to) > Date.parse(value.from) &&
    Date.parse(value.to) - Date.parse(value.from) <= 366 * 86400000);
  return [
    {
      method: 'get', path: '/meta/operations',
      handler(req) {
        const parsed = querySchema.safeParse(req.query);
        if (!parsed.success) return { status: 400, body: { error: { kind: 'validation', message: 'Invalid meta operation query' } } };
        const { after, limit, ...filter } = parsed.data;
        if (filter.from !== undefined) {
          filter.from = new Date(filter.from).toISOString();
          filter.to = new Date(filter.to!).toISOString();
        }
        return { status: 200, body: deps.operations.listPage({
          ...filter, ...(deps.microsoftSignedIn?.() === false ? { excludeProviderId: 'agency' } : {}),
        }, after ?? null, limit ?? deps.config.defaultPageSize) };
      },
    },
    {
      method: 'get', path: '/meta/operations/:operationId',
      handler(req) {
        const parsed = identifier.safeParse(req.params.operationId);
        if (!parsed.success) return { status: 400, body: { error: { kind: 'validation', message: 'Invalid operation ID' } } };
        const operation = deps.operations.get(parsed.data);
        return operation && (operation.providerId !== 'agency' || deps.microsoftSignedIn?.() !== false)
          ? { status: 200, body: operation }
          : { status: 404, body: { error: { kind: 'not_found', message: 'Meta operation not found' } } };
      },
    },
  ];
}

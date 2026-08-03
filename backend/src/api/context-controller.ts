import { z } from 'zod';
import type { ContextService } from '../context-store/context-service.js';
import type { ContextScope } from '../context-store/context-contract.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

export interface ContextControllerDeps {
  context: Pick<ContextService, 'get' | 'setContent' | 'remember'>;
}

const scopeSchema = z.enum(['workspace', 'repo', 'feature']);

const setSchema = z.object({
  scopeId: z.string(),
  content: z.string(),
});

const rememberSchema = z.object({
  scopeId: z.string(),
  text: z.string().trim().min(1),
});

/** Routes for reading and curating the layered shared-context documents. */
export function createContextRoutes(deps: ContextControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/context/:scope',
      handler: (req) => {
        const scope = parseInput(scopeSchema, req.params.scope) as ContextScope;
        const scopeId = req.query.scopeId ?? '';
        const doc = deps.context.get(scope, scopeId);
        if (!doc) {
          return {
            status: 404,
            body: { error: { kind: 'not_found', message: 'No context yet' } },
          };
        }
        return { status: 200, body: doc };
      },
    },
    {
      method: 'put',
      path: '/context/:scope',
      handler: (req) => {
        const scope = parseInput(scopeSchema, req.params.scope) as ContextScope;
        const input = parseInput(setSchema, req.body);
        return {
          status: 200,
          body: deps.context.setContent({
            scope,
            scopeId: input.scopeId,
            content: input.content,
            updatedBy: 'manual',
          }),
        };
      },
    },
    {
      method: 'post',
      path: '/context/:scope/remember',
      handler: (req) => {
        const scope = parseInput(scopeSchema, req.params.scope) as ContextScope;
        const input = parseInput(rememberSchema, req.body);
        return {
          status: 200,
          body: deps.context.remember({
            scope,
            scopeId: input.scopeId,
            text: input.text,
          }),
        };
      },
    },
  ];
}

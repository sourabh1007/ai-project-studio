import { z } from 'zod';
import type { ProviderResolver } from '../provider/provider-resolver.js';
import type { SessionConfig } from '../session/config.js';
import type { SessionFactory } from '../session/session-factory.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';
import type { SessionBootstrap } from '../session-bootstrap/session-bootstrap.js';
import type { ProviderExecutionPolicy } from '../provider/active-provider.js';
import type { ClientOperations } from '../client-operations/client-operations-contract.js';

const createTerminalSessionSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  kind: z.enum(['dev', 'meta']).optional(),
  /**
   * An optional task prompt to preload onto the session. When set, it is
   * auto-sent into the interactive CLI the first time the terminal is opened
   * (see `terminal-manager`'s first-launch seeding), so a Planner-launched
   * session starts working on the task immediately instead of coming up blank.
   */
  prompt: z.string().min(1).optional(),
});

export interface TerminalControllerDeps {
  resolver: ProviderResolver;
  factory: SessionFactory;
  sessions: SessionRepo;
  config: SessionConfig;
  bootstrap: Pick<SessionBootstrap, 'assertFeatureReady'>;
  executionPolicy?: ProviderExecutionPolicy;
  operations: ClientOperations;
}

/**
 * Creates an interactive session *record* (status `created`). The PTY itself is
 * launched later when the renderer opens the terminal WebSocket, so this route
 * just resolves the provider/model and persists the session so it shows up in
 * the explorer immediately.
 */
export function createTerminalRoutes(deps: TerminalControllerDeps): Route[] {
  return [
    {
      method: 'post',
      path: '/features/:featureId/terminal-sessions',
      handler: async (req) => {
        const input = parseInput(createTerminalSessionSchema, req.body);
        const { featureId } = req.params;
        const key = deps.operations.keyFrom(req.headers);
        return deps.operations.run(
          { scope: `terminal-session.create:${featureId}`, key, fingerprint: input },
          async (commit) => {
            const permit = deps.executionPolicy?.acquire(input.providerId, {
              kind: 'session', id: `preparing:${featureId}`, label: 'Preparing an interactive session',
            });
            try {
              const kind = input.kind ?? deps.config.defaultKind;
              if (kind === 'dev') {
                await deps.bootstrap.assertFeatureReady(featureId);
              }
              const selection = await deps.resolver.resolve({
                providerId: permit?.providerId ?? input.providerId,
                model: input.model,
              });
              const session = deps.factory.build({
                featureId,
                provider: selection.provider.id,
                requestedModel: selection.model,
                kind,
                prompt: input.prompt ?? '',
              });
              // The session row and the success record commit together; the
              // response is the persisted row carrying the database-assigned ordinal.
              commit(() => {
                deps.sessions.save(session);
                return { status: 201, body: deps.sessions.get(session.id) ?? session };
              });
            } finally {
              permit?.release();
            }
          },
        );
      },
    },
  ];
}

import { z } from 'zod';
import type { ProviderResolver } from '../provider/provider-resolver.js';
import type { SessionConfig } from '../session/config.js';
import type { SessionFactory } from '../session/session-factory.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';
import type { SessionBootstrap } from '../session-bootstrap/session-bootstrap.js';

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
        const kind = input.kind ?? deps.config.defaultKind;
        if (kind === 'dev') {
          await deps.bootstrap.assertFeatureReady(req.params.featureId);
        }
        const selection = await deps.resolver.resolve({
          providerId: input.providerId,
          model: input.model,
        });
        const session = deps.factory.build({
          featureId: req.params.featureId,
          provider: selection.provider.id,
          requestedModel: selection.model,
          kind,
          prompt: input.prompt ?? '',
        });
        deps.sessions.save(session);
        // Return the persisted row, not the in-memory object: the creation
        // ordinal (`seq`) is assigned by the database on insert, so the UI needs
        // the re-read row to label the tab with the same "Session #N" the
        // explorer shows. Returning `session` here would omit `seq` and force
        // the UI onto a positional fallback, mismatching the explorer row.
        return { status: 201, body: deps.sessions.get(session.id) ?? session };
      },
    },
  ];
}

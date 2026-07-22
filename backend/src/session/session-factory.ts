import type { Clock } from '../kernel/clock.js';
import type { IdGenerator } from '../kernel/id-generator.js';
import type { SessionConfig } from './config.js';
import { buildUsageFilePath } from './session-paths.js';
import type { Session, SessionKind } from './session-contract.js';

export interface SessionFactoryDeps {
  ids: IdGenerator;
  clock: Clock;
  config: SessionConfig;
}

export interface BuildSessionInput {
  featureId: string;
  provider: string;
  requestedModel: string;
  kind: SessionKind;
  prompt: string;
}

export interface SessionFactory {
  build(input: BuildSessionInput): Session;
}

/** Creates fresh Session records in the 'created' state. */
export function createSessionFactory(
  deps: SessionFactoryDeps,
): SessionFactory {
  return {
    build(input) {
      const id = deps.ids.next();
      return {
        id,
        featureId: input.featureId,
        provider: input.provider,
        requestedModel: input.requestedModel,
        resolvedModel: null,
        status: 'created',
        kind: input.kind,
        prompt: input.prompt,
        usageFilePath: buildUsageFilePath(deps.config, id),
        createdAt: deps.clock.isoNow(),
        startedAt: null,
        endedAt: null,
        exitCode: null,
      };
    },
  };
}

import type { Clock } from '../kernel/clock.js';
import { NotFoundError } from '../kernel/error-types.js';
import type { EventBus } from '../kernel/event-bus.js';
import type { IdGenerator } from '../kernel/id-generator.js';
import type {
  AutomationOrigin,
  Subagent,
  SubagentRepo,
} from './automation-contract.js';
import { attributionFeatureId } from './check-runner.js';
import type { AiInvoker } from './automation-ports.js';

/** Events emitted when a tracked subagent changes, forwarded to the stream. */
export type SubagentEventMap = {
  'subagent.updated': Subagent;
};

export interface SpawnSubagentInput {
  task: string;
  prompt: string;
  origin: AutomationOrigin;
  automationId: string | null;
  cwd?: string;
  signal?: AbortSignal;
}

export interface RegisterSubagentInput {
  task: string;
  origin: AutomationOrigin;
  automationId: string | null;
}

/** A spawned subagent and a promise that resolves once its AI run settles. */
export interface SpawnedSubagent {
  subagent: Subagent;
  completion: Promise<void>;
}

export interface SubagentServiceDeps {
  repo: SubagentRepo;
  clock: Clock;
  ids: IdGenerator;
  bus: EventBus<SubagentEventMap>;
  ai: AiInvoker;
  timeoutMs: number;
}

export interface SubagentService {
  /** Runs an AI task in the background, tracking its progress and result. */
  spawn(input: SpawnSubagentInput): SpawnedSubagent;
  /** Records an externally-driven subagent (e.g. registered via MCP). */
  register(input: RegisterSubagentInput): Subagent;
  get(id: string): Subagent;
  list(): Subagent[];
  listByAutomation(automationId: string): Subagent[];
  updateProgress(id: string, progress: string): Subagent;
  complete(id: string, result: string): Subagent;
  fail(id: string, error: string): Subagent;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Subagent failed';
}

export function createSubagentService(
  deps: SubagentServiceDeps,
): SubagentService {
  const publish = (subagent: Subagent): Subagent => {
    const stamped: Subagent = { ...subagent, updatedAt: deps.clock.isoNow() };
    deps.repo.save(stamped);
    deps.bus.emit('subagent.updated', stamped);
    return stamped;
  };

  const require = (id: string): Subagent => {
    const subagent = deps.repo.get(id);
    if (!subagent) {
      throw new NotFoundError(`Subagent not found: ${id}`);
    }
    return subagent;
  };

  const maybe = (id: string): Subagent | null => deps.repo.get(id);

  return {
    spawn(input) {
      const now = deps.clock.isoNow();
      const subagent: Subagent = {
        id: deps.ids.next(),
        automationId: input.automationId,
        origin: input.origin,
        task: input.task,
        status: 'running',
        progress: null,
        result: null,
        sessionId: null,
        createdAt: now,
        updatedAt: now,
      };
      deps.repo.create(subagent);
      deps.bus.emit('subagent.updated', subagent);

      const failRun = (
        error: unknown,
        result?: Awaited<ReturnType<AiInvoker['run']>>,
      ): void => {
        try {
          const current = maybe(subagent.id);
          if (!current) {
            return;
          }
          publish({
            ...current,
            status: 'failed',
            sessionId: result?.sessionId ?? current.sessionId,
            result: result
              ? `${errorMessage(error)}\n\n${result.text}`
              : errorMessage(error),
          });
        } catch (persistenceError) {
          throw new AggregateError(
            [error, persistenceError],
            'Subagent failure could not be persisted or published',
          );
        }
      };

      const completion = deps.ai
        .run({
          automationId: input.automationId,
          originSessionId: input.origin.sessionId,
          featureId:
            input.origin.featureId ??
            attributionFeatureId({
              automationId: input.automationId ?? subagent.id,
              origin: input.origin,
            }),
          prompt: input.prompt,
          cwd: input.cwd,
          timeoutMs: deps.timeoutMs,
          scope: 'internal',
          label: 'Subagent task',
          signal: input.signal,
        })
        .then(
          (result) => {
            const current = maybe(subagent.id);
            if (!current) {
              return;
            }
            try {
              publish({
                ...current,
                status: 'done',
                result: result.text.trim(),
                sessionId: result.sessionId,
              });
            } catch (error) {
              failRun(error, result);
              throw error;
            }
          },
          (error: unknown) => failRun(error),
        );

      return { subagent, completion };
    },
    register(input) {
      const now = deps.clock.isoNow();
      const subagent: Subagent = {
        id: deps.ids.next(),
        automationId: input.automationId,
        origin: input.origin,
        task: input.task,
        status: 'queued',
        progress: null,
        result: null,
        sessionId: null,
        createdAt: now,
        updatedAt: now,
      };
      deps.repo.create(subagent);
      deps.bus.emit('subagent.updated', subagent);
      return subagent;
    },
    get: require,
    list() {
      return deps.repo.list();
    },
    listByAutomation(automationId) {
      return deps.repo.listByAutomation(automationId);
    },
    updateProgress(id, progress) {
      return publish({ ...require(id), status: 'running', progress });
    },
    complete(id, result) {
      return publish({ ...require(id), status: 'done', result });
    },
    fail(id, error) {
      return publish({ ...require(id), status: 'failed', result: error });
    },
  };
}

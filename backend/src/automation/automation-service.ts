import type { Clock } from '../kernel/clock.js';
import { ConflictError, NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { EventBus } from '../kernel/event-bus.js';
import type { IdGenerator } from '../kernel/id-generator.js';
import type {
  ActionSpec,
  Automation,
  AutomationMode,
  AutomationOrigin,
  AutomationRepo,
  AutomationRun,
  CheckSpec,
  ConditionSpec,
  PlannedStep,
} from './automation-contract.js';

/** Events emitted by the automation subsystem, forwarded to the SSE stream. */
export type AutomationEventMap = {
  'automation.updated': Automation;
  'automation.removed': { id: string };
};

export interface CreateAutomationInput {
  name: string;
  mode: AutomationMode;
  origin?: AutomationOrigin;
  check: CheckSpec;
  condition: ConditionSpec;
  action: ActionSpec;
  intervalMs?: number;
  maxRuns?: number | null;
  plannedSteps?: PlannedStep[];
}

export interface AutomationServiceDeps {
  repo: AutomationRepo;
  clock: Clock;
  ids: IdGenerator;
  bus: EventBus<AutomationEventMap>;
  config: {
    defaultIntervalMs: number;
    minIntervalMs: number;
    maxActiveAutomations: number;
  };
}

export interface AutomationService {
  create(input: CreateAutomationInput): Automation;
  get(id: string): Automation;
  list(): Automation[];
  listRuns(id: string): AutomationRun[];
  /** Persists an updated automation (stamps updatedAt) and emits an event. */
  save(automation: Automation): Automation;
  pause(id: string): Automation;
  resume(id: string): Automation;
  cancel(id: string): Automation;
  runNow(id: string): Automation;
  remove(id: string): void;
  updateProgress(id: string, progress: string): Automation;
  setPlannedSteps(id: string, steps: PlannedStep[]): Automation;
  /**
   * Changes a monitor's poll interval. The requested value is clamped to the
   * configured floor. Reschedules the next tick when the monitor is active;
   * leaves the (null) next-run untouched while paused/awaiting sign-in.
   */
  updateInterval(id: string, intervalMs: number): Automation;
}

const TERMINAL: ReadonlySet<Automation['status']> = new Set([
  'completed',
  'cancelled',
  'failed',
]);

export function createAutomationService(
  deps: AutomationServiceDeps,
): AutomationService {
  const publish = (automation: Automation): Automation => {
    const stamped: Automation = {
      ...automation,
      updatedAt: deps.clock.isoNow(),
    };
    deps.repo.save(stamped);
    deps.bus.emit('automation.updated', stamped);
    return stamped;
  };

  const require = (id: string): Automation => {
    const automation = deps.repo.get(id);
    if (!automation) {
      throw new NotFoundError(`Automation not found: ${id}`);
    }
    return automation;
  };

  const activeCount = (): number =>
    deps.repo.list().filter((a) => a.status === 'active').length;

  return {
    create(input) {
      const name = input.name.trim();
      if (name === '') {
        throw new ValidationError('Automation name is required');
      }
      if (activeCount() >= deps.config.maxActiveAutomations) {
        throw new ConflictError(
          `Too many active automations (max ${deps.config.maxActiveAutomations})`,
        );
      }
      const intervalMs = Math.max(
        deps.config.minIntervalMs,
        input.intervalMs ?? deps.config.defaultIntervalMs,
      );
      const now = deps.clock.isoNow();
      const automation: Automation = {
        id: deps.ids.next(),
        name,
        mode: input.mode,
        status: 'active',
        origin: input.origin ?? { sessionId: null, featureId: null },
        check: input.check,
        condition: input.condition,
        action: input.action,
        intervalMs,
        maxRuns: input.maxRuns ?? null,
        runCount: 0,
        progress: null,
        plannedSteps: input.plannedSteps ?? [],
        lastOccurrenceKey: null,
        createdAt: now,
        updatedAt: now,
        lastCheckedAt: null,
        nextRunAt: new Date(deps.clock.now().getTime() + intervalMs).toISOString(),
        failure: null,
      };
      deps.repo.create(automation);
      deps.bus.emit('automation.updated', automation);
      return automation;
    },
    get: require,
    list() {
      return deps.repo.list();
    },
    listRuns(id) {
      require(id);
      return deps.repo.listRuns(id);
    },
    save: publish,
    pause(id) {
      const automation = require(id);
      if (automation.status !== 'active') {
        throw new ConflictError(`Automation is not active: ${id}`);
      }
      return publish({ ...automation, status: 'paused', nextRunAt: null });
    },
    resume(id) {
      const automation = require(id);
      if (
        automation.status !== 'paused' &&
        automation.status !== 'needs-auth'
      ) {
        throw new ConflictError(`Automation is not paused: ${id}`);
      }
      return publish({
        ...automation,
        status: 'active',
        failure: null,
        nextRunAt: new Date(
          deps.clock.now().getTime() + automation.intervalMs,
        ).toISOString(),
      });
    },
    cancel(id) {
      const automation = require(id);
      if (TERMINAL.has(automation.status)) {
        throw new ConflictError(`Automation is already finished: ${id}`);
      }
      return publish({ ...automation, status: 'cancelled', nextRunAt: null });
    },
    runNow(id) {
      const automation = require(id);
      if (TERMINAL.has(automation.status)) {
        throw new ConflictError(`Automation is already finished: ${id}`);
      }
      return publish({
        ...automation,
        status: 'active',
        nextRunAt: deps.clock.isoNow(),
      });
    },
    remove(id) {
      require(id);
      deps.repo.delete(id);
      deps.bus.emit('automation.removed', { id });
    },
    updateProgress(id, progress) {
      const automation = require(id);
      return publish({ ...automation, progress });
    },
    setPlannedSteps(id, steps) {
      const automation = require(id);
      return publish({ ...automation, plannedSteps: steps });
    },
    updateInterval(id, intervalMs) {
      const automation = require(id);
      if (TERMINAL.has(automation.status)) {
        throw new ConflictError(`Automation is already finished: ${id}`);
      }
      const clamped = Math.max(deps.config.minIntervalMs, Math.round(intervalMs));
      const nextRunAt =
        automation.status === 'active'
          ? new Date(deps.clock.now().getTime() + clamped).toISOString()
          : automation.nextRunAt;
      return publish({ ...automation, intervalMs: clamped, nextRunAt });
    },
  };
}

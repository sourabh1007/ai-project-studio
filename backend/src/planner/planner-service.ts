import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { Clock } from '../kernel/clock.js';
import type { IdGenerator } from '../kernel/id-generator.js';
import type { PlannerConfig } from './config.js';
import type {
  CreatePlannerTaskInput,
  PlannerLaunchKind,
  PlannerPriority,
  PlannerTask,
  PlannerTaskKind,
  PlannerTaskStatus,
  UpdatePlannerTaskInput,
} from './planner-contract.js';
import type { PlannerRepo } from './planner-repo-port.js';

export interface PlannerServiceDeps {
  repo: PlannerRepo;
  ids: IdGenerator;
  clock: Clock;
  config: PlannerConfig;
}

export interface PlannerService {
  list(): PlannerTask[];
  create(input: CreatePlannerTaskInput): PlannerTask;
  update(id: string, patch: UpdatePlannerTaskInput): PlannerTask;
  remove(id: string): void;
}

const PRIORITIES: readonly PlannerPriority[] = ['p0', 'p1', 'p2', 'p3'];
const KINDS: readonly PlannerTaskKind[] = ['task', 'pr'];
const STATUSES: readonly PlannerTaskStatus[] = ['open', 'done'];
const LAUNCH_KINDS: readonly PlannerLaunchKind[] = ['session', 'agent', 'review'];
/** Matches a strict `YYYY-MM-DD` calendar day. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Application service for the standalone Planner checklist. */
export function createPlannerService(deps: PlannerServiceDeps): PlannerService {
  const requireTask = (id: string): PlannerTask => {
    const task = deps.repo.get(id);
    if (!task) {
      throw new NotFoundError(`Unknown planner task: ${id}`);
    }
    return task;
  };

  const validateTitle = (title: string): string => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new ValidationError('Task title must not be empty');
    }
    if (trimmed.length > deps.config.maxTitleLength) {
      throw new ValidationError(
        `Task title exceeds ${deps.config.maxTitleLength} characters`,
      );
    }
    return trimmed;
  };

  const validateNotes = (notes: string): string => {
    if (notes.length > deps.config.maxNotesLength) {
      throw new ValidationError(
        `Task notes exceed ${deps.config.maxNotesLength} characters`,
      );
    }
    return notes;
  };

  const validatePrUrl = (prUrl: string): string => {
    const trimmed = prUrl.trim();
    if (trimmed.length > deps.config.maxPrUrlLength) {
      throw new ValidationError(
        `Pull request URL exceeds ${deps.config.maxPrUrlLength} characters`,
      );
    }
    return trimmed;
  };

  const validateDate = (date: string): string => {
    if (!DATE_PATTERN.test(date)) {
      throw new ValidationError('Task date must be in YYYY-MM-DD format');
    }
    return date;
  };

  /** Validates an optional backlog date: `null` stays null, else a strict day. */
  const validateOptionalDate = (date: string | null): string | null => {
    if (date === null) {
      return null;
    }
    return validateDate(date);
  };

  const validatePriority = (priority: PlannerPriority): PlannerPriority => {
    if (!PRIORITIES.includes(priority)) {
      throw new ValidationError(`Unknown priority: ${priority}`);
    }
    return priority;
  };

  const validateKind = (kind: PlannerTaskKind): PlannerTaskKind => {
    if (!KINDS.includes(kind)) {
      throw new ValidationError(`Unknown task kind: ${kind}`);
    }
    return kind;
  };

  const validateStatus = (status: PlannerTaskStatus): PlannerTaskStatus => {
    if (!STATUSES.includes(status)) {
      throw new ValidationError(`Unknown task status: ${status}`);
    }
    return status;
  };

  const validateLaunchKind = (
    kind: PlannerLaunchKind | null,
  ): PlannerLaunchKind | null => {
    if (kind !== null && !LAUNCH_KINDS.includes(kind)) {
      throw new ValidationError(`Unknown launch kind: ${kind}`);
    }
    return kind;
  };

  /** Trims an optional reference, collapsing blanks to `null` and capping length. */
  const normalizeRef = (
    value: string | null,
    max: number,
    label: string,
  ): string | null => {
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.length > max) {
      throw new ValidationError(`${label} exceeds ${max} characters`);
    }
    return trimmed;
  };

  return {
    list() {
      return deps.repo.list();
    },
    create(input) {
      const now = deps.clock.isoNow();
      const kind = validateKind(input.kind ?? 'task');
      const prUrl = validatePrUrl(input.prUrl ?? '');
      const task: PlannerTask = {
        id: deps.ids.next(),
        title: validateTitle(input.title),
        notes: validateNotes(input.notes?.trim() ?? ''),
        priority: validatePriority(input.priority ?? deps.config.defaultPriority),
        status: 'open',
        kind,
        prUrl,
        date: validateDate(input.date ?? now.slice(0, 10)),
        repoId: normalizeRef(
          input.repoId ?? null,
          deps.config.maxPrUrlLength,
          'Repository id',
        ),
        launchKind: null,
        featureId: null,
        sessionId: null,
        launchLabel: null,
        backloggedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      deps.repo.create(task);
      return task;
    },
    update(id, patch) {
      const existing = requireTask(id);
      const next: PlannerTask = {
        ...existing,
        updatedAt: deps.clock.isoNow(),
      };
      if (patch.title !== undefined) {
        next.title = validateTitle(patch.title);
      }
      if (patch.notes !== undefined) {
        next.notes = validateNotes(patch.notes.trim());
      }
      if (patch.priority !== undefined) {
        next.priority = validatePriority(patch.priority);
      }
      if (patch.kind !== undefined) {
        next.kind = validateKind(patch.kind);
      }
      if (patch.prUrl !== undefined) {
        next.prUrl = validatePrUrl(patch.prUrl);
      }
      if (patch.date !== undefined) {
        next.date = validateDate(patch.date);
      }
      if (patch.status !== undefined) {
        next.status = validateStatus(patch.status);
      }
      if (patch.repoId !== undefined) {
        next.repoId = normalizeRef(
          patch.repoId,
          deps.config.maxPrUrlLength,
          'Repository id',
        );
      }
      if (patch.launchKind !== undefined) {
        next.launchKind = validateLaunchKind(patch.launchKind);
      }
      if (patch.featureId !== undefined) {
        next.featureId = normalizeRef(
          patch.featureId,
          deps.config.maxPrUrlLength,
          'Feature id',
        );
      }
      if (patch.sessionId !== undefined) {
        next.sessionId = normalizeRef(
          patch.sessionId,
          deps.config.maxPrUrlLength,
          'Session id',
        );
      }
      if (patch.launchLabel !== undefined) {
        next.launchLabel = normalizeRef(
          patch.launchLabel,
          deps.config.maxTitleLength,
          'Launch label',
        );
      }
      if (patch.backloggedAt !== undefined) {
        next.backloggedAt = validateOptionalDate(patch.backloggedAt);
      }
      deps.repo.update(next);
      return next;
    },
    remove(id) {
      requireTask(id);
      deps.repo.delete(id);
    },
  };
}

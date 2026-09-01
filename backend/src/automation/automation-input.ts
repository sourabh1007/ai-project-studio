import { ValidationError } from '../kernel/error-types.js';
import type {
  ActionSpec,
  AutomationOrigin,
  CheckSpec,
  ConditionSpec,
  PlannedStep,
} from './automation-contract.js';
import type { CreateAutomationInput } from './automation-service.js';
import type { RegisterSubagentInput } from './subagent-service.js';

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asString(value, label);
}

function assertCheck(value: unknown): CheckSpec {
  const check = asObject(value, 'check');
  switch (check.type) {
    case 'shell':
      return {
        type: 'shell',
        command: asString(check.command, 'check.command'),
        cwd: optionalString(check.cwd, 'check.cwd'),
      };
    case 'http':
      return {
        type: 'http',
        url: asString(check.url, 'check.url'),
        method: check.method === 'POST' ? 'POST' : 'GET',
      };
    case 'ai':
      return {
        type: 'ai',
        prompt: asString(check.prompt, 'check.prompt'),
        cwd: optionalString(check.cwd, 'check.cwd'),
      };
    case 'ci-pipeline':
      return {
        type: 'ci-pipeline',
        provider: check.provider === 'azure' ? 'azure' : 'github',
        repo: asString(check.repo, 'check.repo'),
        ref: optionalString(check.ref, 'check.ref'),
        pipeline: optionalString(check.pipeline, 'check.pipeline'),
      };
    default:
      throw new ValidationError(
        `Unknown check type: ${String(check.type)}. Valid check types are: ` +
          `shell (command), http (url[, method]), ai (prompt), ` +
          `ci-pipeline (provider 'github'|'azure', repo[, ref, pipeline]).`,
      );
  }
}

function assertCondition(value: unknown): ConditionSpec {
  const condition = asObject(value, 'condition');
  switch (condition.type) {
    case 'always':
      return { type: 'always' };
    case 'exit-code': {
      const equals = condition.equals;
      if (typeof equals !== 'number') {
        throw new ValidationError('condition.equals must be a number');
      }
      return { type: 'exit-code', equals };
    }
    case 'status-equals':
      return {
        type: 'status-equals',
        value: asString(condition.value, 'condition.value'),
      };
    case 'conclusion-equals':
      return {
        type: 'conclusion-equals',
        value: asString(condition.value, 'condition.value'),
      };
    case 'text-contains':
      return {
        type: 'text-contains',
        value: asString(condition.value, 'condition.value'),
      };
    case 'ai-verdict':
      return { type: 'ai-verdict' };
    default:
      throw new ValidationError(
        `Unknown condition type: ${String(condition.type)}. Valid condition ` +
          `types are: always, exit-code (equals: number), status-equals ` +
          `(value), conclusion-equals (value), text-contains (value), ` +
          `ai-verdict.`,
      );
  }
}

function assertAction(value: unknown): ActionSpec {
  const action = asObject(value, 'action');
  switch (action.type) {
    case 'metasession':
      return {
        type: 'metasession',
        prompt: asString(action.prompt, 'action.prompt'),
        cwd: optionalString(action.cwd, 'action.cwd'),
      };
    case 'subagent':
      return {
        type: 'subagent',
        task: asString(action.task, 'action.task'),
        prompt: asString(action.prompt, 'action.prompt'),
        cwd: optionalString(action.cwd, 'action.cwd'),
      };
    case 'report':
      return {
        type: 'report',
        prompt: asString(action.prompt, 'action.prompt'),
        cwd: optionalString(action.cwd, 'action.cwd'),
      };
    case 'command':
      return {
        type: 'command',
        command: asString(action.command, 'action.command'),
        cwd: optionalString(action.cwd, 'action.cwd'),
      };
    default:
      throw new ValidationError(
        `Unknown action type: ${String(action.type)}. Valid action types ` +
          `are: metasession (prompt), subagent (task, prompt), report ` +
          `(prompt), command (command).`,
      );
  }
}

function assertMode(value: unknown): 'short' | 'long' {
  if (value === 'short' || value === 'long') {
    return value;
  }
  throw new ValidationError(`Unknown automation mode: ${String(value)}`);
}

function optionalInterval(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError('intervalMs must be a positive number');
  }
  return value;
}

function optionalMaxRuns(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return value as null | undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError('maxRuns must be a positive integer');
  }
  return value;
}

function originField(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : asString(value, label);
}

function assertOrigin(value: unknown): AutomationOrigin {
  const origin = asObject(value, 'origin');
  return {
    sessionId: originField(origin.sessionId, 'origin.sessionId'),
    featureId: originField(origin.featureId, 'origin.featureId'),
  };
}

function optionalOrigin(
  value: unknown,
): CreateAutomationInput['origin'] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertOrigin(value);
}

function assertStepStatus(value: unknown): PlannedStep['status'] {
  if (
    value === 'pending' ||
    value === 'active' ||
    value === 'done' ||
    value === 'skipped'
  ) {
    return value;
  }
  throw new ValidationError(`Unknown planned step status: ${String(value)}`);
}

function assertStepDetail(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ValidationError('step.detail must be a string or null');
  }
  return value;
}

function assertPlannedStep(value: unknown): PlannedStep {
  const step = asObject(value, 'step');
  return {
    id: asString(step.id, 'step.id'),
    label: asString(step.label, 'step.label'),
    status: assertStepStatus(step.status),
    detail: assertStepDetail(step.detail),
  };
}

function optionalPlannedSteps(value: unknown): PlannedStep[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ValidationError('plannedSteps must be an array');
  }
  return value.map(assertPlannedStep);
}

function bodyString(body: unknown, field: string): string {
  const input = asObject(body, 'body');
  return asString(input[field], field);
}

/**
 * Validates and normalizes an untrusted `POST /automations` body into a
 * {@link CreateAutomationInput}. Rejects malformed specs with a
 * {@link ValidationError} so the API never persists an unrunnable monitor.
 */
export function assertCreateAutomationInput(
  body: unknown,
): CreateAutomationInput {
  const input = asObject(body, 'body');
  return {
    name: asString(input.name, 'name'),
    mode: assertMode(input.mode),
    origin: optionalOrigin(input.origin),
    check: assertCheck(input.check),
    condition: assertCondition(input.condition),
    action: assertAction(input.action),
    intervalMs: optionalInterval(input.intervalMs),
    maxRuns: optionalMaxRuns(input.maxRuns),
    plannedSteps: optionalPlannedSteps(input.plannedSteps),
  };
}

export function assertProgressBody(body: unknown): string {
  return bodyString(body, 'progress');
}

export function assertResultBody(body: unknown): string {
  return bodyString(body, 'result');
}

export function assertErrorBody(body: unknown): string {
  return bodyString(body, 'error');
}

export function assertPlannedStepsBody(body: unknown): PlannedStep[] {
  const input = asObject(body, 'body');
  if (!Array.isArray(input.steps)) {
    throw new ValidationError('steps must be an array');
  }
  return input.steps.map(assertPlannedStep);
}

export function assertIntervalBody(body: unknown): number {
  const input = asObject(body, 'body');
  const value = input.intervalMs;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError('intervalMs must be a positive number');
  }
  return value;
}

export function assertRegisterSubagentBody(
  body: unknown,
  automationId: string,
): RegisterSubagentInput {
  const input = asObject(body, 'body');
  return {
    task: asString(input.task, 'task'),
    origin: assertOrigin(input.origin),
    automationId,
  };
}

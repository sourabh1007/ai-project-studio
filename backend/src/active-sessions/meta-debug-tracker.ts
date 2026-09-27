import type { MetaOperation, MetaOperationRepo } from '../meta/meta-operation-contract.js';
import type { MetaRunner } from '../meta/meta-runner.js';
import type { ActiveSessionsConfig } from './config.js';
import { redactDebugText } from './debug-redaction.js';

export interface DebugOperation {
  operationId: string;
  featureId: string;
  automationId: string | null;
  originSessionId: string | null;
  sessionId: string | null;
  sessionIds: string[];
  label: string | null;
  purpose: string | null;
  providerId: string | null;
  requestedModel: string | null;
  state: MetaOperation['state'];
  transport: MetaOperation['transport'];
  output: string;
  error: string | null;
  activity: string[];
  truncated: boolean;
}

export interface MetaDebugTracker {
  observe(operation: MetaOperation): void;
  activity(operationId: string, text: string): void;
  get(operationId: string): DebugOperation | undefined;
  bySession(sessionId: string): DebugOperation | undefined;
  forget(filter: (operation: DebugOperation) => boolean): void;
}

export function createMetaDebugTracker(config: ActiveSessionsConfig): MetaDebugTracker {
  const operations = new Map<string, DebugOperation>();
  const sessionOperations = new Map<string, string>();
  const forget = (filter: (operation: DebugOperation) => boolean) => {
    for (const [id, operation] of operations) {
      if (!filter(operation)) continue;
      operations.delete(id);
      for (const sessionId of operation.sessionIds) {
        if (sessionOperations.get(sessionId) === id) sessionOperations.delete(sessionId);
      }
    }
  };
  return {
    observe(operation) {
      const previous = operations.get(operation.operationId);
      const output = redactDebugText(operation.resultText ?? '');
      const safe: DebugOperation = {
        operationId: operation.operationId, featureId: operation.featureId, automationId: operation.automationId,
        originSessionId: operation.originSessionId,
        sessionId: operation.sessionId, sessionIds: operation.sessionIds,
        label: operation.label === null ? null : redactDebugText(operation.label).slice(0, 240),
        purpose: operation.purpose === null ? null : redactDebugText(operation.purpose).slice(0, 120),
        providerId: operation.providerId, requestedModel: operation.requestedModel,
        state: operation.state, transport: operation.transport,
        output: output.slice(-config.maxTextCharacters),
        error: operation.errorMessage === null ? null : redactDebugText(operation.errorMessage).slice(0, 500),
        activity: previous?.activity ?? [],
        truncated: (previous?.truncated ?? false) || output.length > config.maxTextCharacters,
      };
      operations.delete(operation.operationId);
      operations.set(operation.operationId, safe);
      for (const sessionId of operation.sessionIds) sessionOperations.set(sessionId, operation.operationId);
      if (operations.size > config.maxOperations) {
        const oldest = operations.keys().next().value as string;
        forget((item) => item.operationId === oldest);
      }
    },
    activity(operationId, text) {
      const operation = operations.get(operationId);
      if (!operation) return;
      // Tool arguments can contain prompts, shell commands and authentication.
      const withoutArguments = text.startsWith('🔧') ? text.split(' · ')[0] : text;
      const safe = redactDebugText(withoutArguments).slice(0, 500);
      if (!safe) return;
      operation.activity.push(safe);
      if (operation.activity.length > config.maxActivityLines) {
        operation.activity.shift();
        operation.truncated = true;
      }
    },
    get: (id) => operations.get(id),
    bySession: (id) => {
      const operationId = sessionOperations.get(id);
      return operationId === undefined ? undefined : operations.get(operationId);
    },
    forget,
  };
}

/** Observe existing durable writes; no historical scans or extra provider work. */
export function observeMetaOperations<T extends MetaOperationRepo>(base: T, tracker: MetaDebugTracker): T {
  return {
    ...base,
    get: base.get.bind(base),
    listPage: base.listPage.bind(base),
    listUnfinishedPage: base.listUnfinishedPage.bind(base),
    create(operation) { base.create(operation); tracker.observe(operation); },
    update(operation) {
      const saved = base.update(operation);
      if (saved) tracker.observe(operation);
      return saved;
    },
    complete(operation, usage) {
      const saved = base.complete(operation, usage);
      if (saved) tracker.observe(operation);
      return saved;
    },
    deleteByFeature(id) { base.deleteByFeature(id); tracker.forget((operation) => operation.featureId === id); },
    deleteBySession(id) {
      base.deleteBySession(id);
      tracker.forget((operation) => operation.originSessionId === id || operation.sessionId === id || operation.sessionIds.includes(id));
    },
    deleteByAutomation(id) { base.deleteByAutomation(id); tracker.forget((operation) => operation.automationId === id); },
  };
}

/** Taps the same bounded activity callbacks already used by operation pages. */
export function observeMetaRunner(base: MetaRunner, tracker: MetaDebugTracker): MetaRunner {
  const runDetailed: MetaRunner['runDetailed'] = (request) => base.runDetailed({
    ...request,
    onActivity(text) {
      if (request.operationId) tracker.activity(request.operationId, text);
      request.onActivity?.(text);
    },
  });
  return { runDetailed, run: async (request) => (await runDetailed(request)).text };
}

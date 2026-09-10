import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createActionRunner } from '../automation/action-runner.js';
import type {
  Automation,
  AutomationRepo,
  AutomationRun,
  CheckRunner,
  SubagentRepo,
} from '../automation/automation-contract.js';
import type { AutomationEventMap } from '../automation/automation-service.js';
import { createAutomationScheduler, type ManagedAutomationScheduler } from '../automation/automation-scheduler.js';
import { createAutomationService } from '../automation/automation-service.js';
import { createCheckRunner } from '../automation/check-runner.js';
import { createSubagentService, type SubagentEventMap } from '../automation/subagent-service.js';
import type { AiInvoker } from '../automation/automation-ports.js';
import { createClock, type Clock } from '../kernel/clock.js';
import { createEventBus } from '../kernel/event-bus.js';
import { createIdGenerator } from '../kernel/id-generator.js';
import { createMetaOperationOwnership } from '../meta/meta-operation-ownership.js';
import type { MetaRequest, MetaRunner } from '../meta/meta-runner.js';
import { createRecordingMetaRunner } from '../meta/recording-meta-runner.js';
import { createDatabase } from '../persistence/db/connection.js';
import { createAutomationRepo } from '../persistence/automation-repo.js';
import { createMetaOperationRepo } from '../persistence/meta-operation-repo.js';
import { createSubagentRepo } from '../persistence/subagent-repo.js';

const startedAt = Date.parse('2026-09-10T06:30:00.000Z');

function ids(prefix: string) {
  let sequence = 0;
  return createIdGenerator(() => `${prefix}-${++sequence}`);
}

interface Harness {
  db: DatabaseSync;
  automationRepo: AutomationRepo;
  subagentRepo: SubagentRepo;
  metaOperations: ReturnType<typeof createMetaOperationRepo>;
  automationBus: ReturnType<typeof createEventBus<AutomationEventMap>>;
  automationUpdates: Automation[];
  removed: string[];
  subagentUpdates: Array<{ id: string; status: string; result: string | null }>;
  subagents: ReturnType<typeof createSubagentService>;
  service: ReturnType<typeof createAutomationService>;
  scheduler: ManagedAutomationScheduler;
}

function createHarness(databasePath: string, clock: Clock): Harness {
  const db = createDatabase({ databasePath });
  const automationRepo = createAutomationRepo(db);
  const subagentRepo = createSubagentRepo(db);
  const metaOperations = createMetaOperationRepo(db);
  const automationBus = createEventBus<AutomationEventMap>();
  const subagentBus = createEventBus<SubagentEventMap>();
  const automationUpdates: Automation[] = [];
  const removed: string[] = [];
  const subagentUpdates: Array<{
    id: string;
    status: string;
    result: string | null;
  }> = [];
  automationBus.on('automation.updated', (automation) => {
    automationUpdates.push(automation);
  });
  automationBus.on('automation.removed', ({ id }) => {
    removed.push(id);
  });
  subagentBus.on('subagent.updated', (subagent) => {
    subagentUpdates.push({
      id: subagent.id,
      status: subagent.status,
      result: subagent.result,
    });
  });

  let metaSession = 0;
  const deterministicMetaRun = async (request: MetaRequest) => {
    metaSession += 1;
    return {
      text: request.prompt.startsWith('report')
        ? 'report-result'
        : 'subagent-result',
      sessionId: `meta-session-${metaSession}`,
      transport: 'session' as const,
      providerId: 'fake-provider',
      requestedModel: 'fake-model',
      resolvedModel: 'fake-model',
    };
  };
  const baseMetaRunner: MetaRunner = {
    run: async (request) => (await deterministicMetaRun(request)).text,
    runDetailed: deterministicMetaRun,
  };
  const recording = createRecordingMetaRunner({
    base: baseMetaRunner,
    operations: metaOperations,
    ownership: createMetaOperationOwnership(),
    clock,
    newOperationId: ids('operation').next,
    resolveIdentity: () => ({
      providerId: 'fake-provider',
      requestedModel: 'fake-model',
    }),
  });
  const ai: AiInvoker = {
    async run(input) {
      const result = await recording.runDetailed({
        ...input,
        automationId: input.automationId ?? undefined,
        originSessionId: input.originSessionId ?? undefined,
      });
      return {
        text: result.text,
        sessionId: result.sessionId,
        operationId: result.operationId,
      };
    },
  };
  const shell = {
    async exec() {
      return { code: 0, stdout: 'ready', stderr: '' };
    },
  };
  const checks: CheckRunner = createCheckRunner({
    shell,
    http: {
      async fetch() {
        return { status: 200, body: 'ready' };
      },
    },
    ai,
    ci: {
      async latestRun() {
        return { id: 'pipeline-1', status: 'completed', conclusion: 'success' };
      },
    },
    timeoutMs: 1_000,
  });
  const subagents = createSubagentService({
    repo: subagentRepo,
    clock,
    ids: ids('subagent'),
    bus: subagentBus,
    ai,
    timeoutMs: 1_000,
  });
  const actions = createActionRunner({
    ai,
    shell,
    subagents,
    timeoutMs: 1_000,
  });
  let scheduler!: ManagedAutomationScheduler;
  scheduler = createAutomationScheduler({
    repo: automationRepo,
    checks,
    actions,
    clock,
    ids: ids('run'),
    bus: automationBus,
    config: { minIntervalMs: 100, maxConcurrentChecks: 2 },
  });
  const service = createAutomationService({
    repo: automationRepo,
    subagents: subagentRepo,
    ownedArtifacts: metaOperations,
    quiesce: async (automationId) => {
      await scheduler.quiesce(automationId, 1_000);
    },
    clock,
    ids: ids('automation'),
    bus: automationBus,
    config: {
      defaultIntervalMs: 1_000,
      minIntervalMs: 100,
      maxActiveAutomations: 10,
    },
  });

  return {
    db,
    automationRepo,
    subagentRepo,
    metaOperations,
    automationBus,
    automationUpdates,
    removed,
    subagentUpdates,
    subagents,
    service,
    scheduler,
  };
}

describe('automation backend integration', () => {
  let db: DatabaseSync | null = null;
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    db?.close();
    db = null;
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists scheduled checks, report and subagent actions across lifecycle commands', async () => {
    let now = startedAt;
    const clock = createClock(() => now);
    const directory = mkdtempSync(join(tmpdir(), 'automation-integration-'));
    temporaryDirectories.push(directory);
    const harness = createHarness(join(directory, 'studio.db'), clock);
    db = harness.db;

    const reportAutomation = harness.service.create({
      name: 'Release monitor',
      mode: 'long',
      check: { type: 'shell', command: 'release-ready' },
      condition: { type: 'text-contains', value: 'ready' },
      action: { type: 'report', prompt: 'report release readiness' },
      intervalMs: 1_000,
      origin: { sessionId: 'origin-session', featureId: 'feature-1' },
    });
    now = Date.parse(reportAutomation.nextRunAt!);
    await harness.scheduler.tick();

    const firstReportRun = harness.service.listRuns(reportAutomation.id)[0]!;
    expect(firstReportRun).toMatchObject({
      source: 'scheduled',
      phase: 'finished',
      triggered: true,
      status: 'ok',
      report: 'report-result',
      sessionId: 'meta-session-1',
    });
    const reportOperations = harness.metaOperations.listPage(
      { automationId: reportAutomation.id },
      null,
      10,
    );
    expect(reportOperations.items).toHaveLength(1);
    expect(reportOperations.items[0]).toMatchObject({
      operationId: 'operation-1',
      hasResult: true,
    });
    expect(harness.metaOperations.get('operation-1')?.resultText).toBe(
      'report-result',
    );

    expect(harness.service.pause(reportAutomation.id).nextRunAt).toBeNull();
    expect(
      harness.service.updateInterval(reportAutomation.id, 2_500),
    ).toMatchObject({ status: 'paused', intervalMs: 2_500, nextRunAt: null });
    const resumed = harness.service.resume(reportAutomation.id);
    expect(resumed).toMatchObject({ status: 'active', intervalMs: 2_500 });
    expect(resumed.nextRunAt).toBe(
      new Date(now + 2_500).toISOString(),
    );
    expect(
      harness.service.updateInterval(reportAutomation.id, 3_000).nextRunAt,
    ).toBe(new Date(now + 3_000).toISOString());

    await harness.scheduler.runNow(reportAutomation.id);
    const reportRuns = harness.service.listRuns(reportAutomation.id);
    expect(reportRuns).toHaveLength(2);
    expect(reportRuns[1]).toMatchObject({
      source: 'manual',
      phase: 'finished',
      status: 'ok',
      report: 'report-result',
    });

    const subagentAutomation = harness.service.create({
      name: 'Triage monitor',
      mode: 'short',
      check: { type: 'shell', command: 'triage-ready' },
      condition: { type: 'exit-code', equals: 0 },
      action: {
        type: 'subagent',
        task: 'triage release',
        prompt: 'subagent triage release',
      },
    });
    await harness.scheduler.runNow(subagentAutomation.id);
    expect(await harness.scheduler.waitForIdle(1_000)).toBe(true);

    expect(harness.service.get(subagentAutomation.id)).toMatchObject({
      status: 'completed',
      runCount: 1,
      nextRunAt: null,
    });
    expect(harness.service.listRuns(subagentAutomation.id)[0]).toMatchObject({
      phase: 'finished',
      status: 'ok',
      detail: 'Subagent started: triage release',
    });
    expect(harness.subagents.listByAutomation(subagentAutomation.id)).toMatchObject([
      {
        status: 'done',
        result: 'subagent-result',
        sessionId: 'meta-session-3',
      },
    ]);
    expect(harness.subagentUpdates.map(({ status }) => status)).toEqual([
      'running',
      'done',
    ]);
    expect(
      harness.metaOperations.listPage(
        { automationId: subagentAutomation.id },
        null,
        10,
      ).items,
    ).toMatchObject([{ operationId: 'operation-3', hasResult: true }]);
    expect(
      harness.automationUpdates.some(
        (automation) =>
          automation.id === reportAutomation.id &&
          automation.status === 'active',
      ),
    ).toBe(true);

    await harness.service.remove(subagentAutomation.id);
    expect(harness.subagentRepo.listByAutomation(subagentAutomation.id)).toEqual(
      [],
    );
    expect(harness.removed).toContain(subagentAutomation.id);
    await harness.service.remove(reportAutomation.id);
    expect(harness.automationRepo.get(reportAutomation.id)).toBeNull();
    expect(harness.automationRepo.listRuns(reportAutomation.id)).toEqual([]);
    expect(
      harness.metaOperations.listPage(
        { automationId: reportAutomation.id },
        null,
        10,
      ).items,
    ).toEqual([]);
    expect(harness.removed).toEqual([
      subagentAutomation.id,
      reportAutomation.id,
    ]);
  });

  it('recreates file-backed services and recovers an interrupted persisted run', () => {
    let now = startedAt;
    const clock = createClock(() => now);
    const directory = mkdtempSync(join(tmpdir(), 'automation-recovery-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'studio.db');
    const initial = createHarness(databasePath, clock);
    db = initial.db;
    const automation = initial.service.create({
      name: 'Restart monitor',
      mode: 'long',
      check: { type: 'shell', command: 'restart-check' },
      condition: { type: 'always' },
      action: { type: 'command', command: 'restart-action' },
      intervalMs: 1_000,
    });
    const openRun: AutomationRun = {
      id: 'run-before-restart',
      automationId: automation.id,
      source: 'scheduled',
      phase: 'checking',
      scheduledForAt: automation.nextRunAt,
      occurrenceKey: null,
      dedupeKey: `scheduled:${automation.id}:${automation.nextRunAt}`,
      startedAt: clock.isoNow(),
      dispatchedAt: clock.isoNow(),
      endedAt: null,
      triggered: false,
      status: 'skipped',
      detail: 'Checking now',
      sessionId: null,
      report: null,
      acknowledgedRunIds: null,
      acknowledgedSnapshotRunIds: null,
      resolvedByRunId: null,
    };
    initial.automationRepo.appendRun(openRun);
    initial.automationRepo.save({ ...automation, progress: 'Checking now' });
    initial.scheduler.shutdown();
    db.close();
    db = null;

    const recovered = createHarness(databasePath, clock);
    db = recovered.db;
    recovered.scheduler.resume();

    expect(recovered.automationRepo.getRun(openRun.id)).toMatchObject({
      phase: 'interrupted',
      status: 'skipped',
      detail: 'Previous backend stopped before the check completed',
    });
    expect(recovered.service.get(automation.id)).toMatchObject({
      status: 'active',
      progress: 'Previous backend stopped before the check completed',
      nextRunAt: new Date(now + 1_000).toISOString(),
    });
    expect(recovered.automationUpdates).toMatchObject([
      {
        id: automation.id,
        progress: 'Previous backend stopped before the check completed',
      },
    ]);
  });
});

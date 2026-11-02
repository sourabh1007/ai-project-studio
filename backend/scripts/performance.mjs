import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAggregateRoutes } from '../dist/api/aggregate-controller.js';
import { mountRoutes } from '../dist/api/express-adapter.js';
import { createTextAttachmentBody } from '../dist/api/text-attachments-body.js';
import { createTextAttachmentRoutes } from '../dist/api/text-attachments-controller.js';
import { createLivePromptFsReader } from '../dist/copilot-history/copilot-live-prompt-fs-adapter.js';
import { createBackgroundWorkRunner } from '../dist/kernel/background-work-runner.js';
import { loggingDefaults } from '../dist/logging/config.js';
import { createQueuedFileLogging } from '../dist/logging/queued-file-logging.js';
import { spawnLogWriterWorker } from '../dist/logging/log-writer-worker-entry.js';
import { createDatabase } from '../dist/persistence/db/connection.js';
import { createSessionRepo } from '../dist/persistence/session-repo.js';
import { createUsageRepo } from '../dist/persistence/usage-repo.js';
import { spawnUsageSummaryWorker } from '../dist/usage-summary/usage-summary-worker-adapter.js';
import { textAttachmentsDefaults } from '../dist/text-attachments/config.js';
import { createTextAttachments } from '../dist/text-attachments/text-attachments-service.js';
import { createTextAttachmentStorage } from '../dist/text-attachments/text-attachments-fs-adapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STAMP = '2026-01-01T00:00:00.000Z';
const WORKLOAD = Object.freeze({
  features: 300, sessionsPerFeature: 8, turnsPerSession: 8,
  historyMiB: 8, rounds: 3, summaryConcurrency: 8, historyConcurrency: 4, logRecords: 3000,
  textPasteBytes: 4 * 1024 * 1024,
});

export function percentile(samples, fraction) {
  assert(samples.length > 0, 'A percentile needs measured samples');
  assert(fraction >= 0 && fraction <= 1, 'Invalid percentile');
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function budgetFailures(metrics, budgets) {
  return Object.entries(budgets).flatMap(([name, limit]) => {
    assert(Number.isFinite(limit) && limit > 0, `Invalid budget: ${name}`);
    const observed = metrics[name];
    if (!Number.isFinite(observed)) return [`${name}: no finite measurement`];
    return observed > limit ? [`${name}: ${observed.toFixed(2)} exceeds ${limit}`] : [];
  });
}

export function parseOptions(args) {
  const options = { baseline: false, output: resolve('coverage', 'performance', 'results.json') };
  for (const arg of args) {
    if (arg === '--baseline') options.baseline = true;
    else if (arg.startsWith('--output=') && arg.length > 9) options.output = resolve(arg.slice(9));
    else throw new Error(`Unknown performance option: ${arg}`);
  }
  return options;
}

export function compareLogFiles(a, b) {
  const order = (name) => {
    const match = /^perf-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/.exec(name);
    assert(match, `Unexpected log file: ${name}`);
    // Numbered rotations precede the current, unnumbered file for each day.
    return { day: match[1], rotation: match[2] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[2]) };
  };
  const left = order(a);
  const right = order(b);
  return left.day.localeCompare(right.day) || left.rotation - right.rotation;
}

function usage(sessionId, featureId, turnIndex, inputTokens = 10) {
  return {
    sessionId, featureId, turnIndex, kind: 'dev', provider: 'fixture',
    requestedModel: 'auto', resolvedModel: 'fixture', operation: 'chat',
    inputTokens, outputTokens: 2, reasoningOutputTokens: 1,
    cost: 1, credits: 1, nanoAiu: 100,
    serviceRequestId: `${sessionId}:${turnIndex}`, startedAt: STAMP, endedAt: STAMP,
  };
}

function seed(db) {
  const feature = db.prepare(`INSERT INTO features
    (id, name, description, created_at, parent_feature_id) VALUES (?, ?, '', ?, ?)`);
  const group = db.prepare(`INSERT INTO feature_groups
    (id, feature_id, parent_group_id, kind, name, created_at) VALUES (?, ?, NULL, 'subcategory', 'Fixture', ?)`);
  const sessions = createSessionRepo(db);
  const rows = [];
  db.exec('BEGIN');
  try {
    for (let f = 0; f < WORKLOAD.features; f += 1) {
      const featureId = `f${f}`;
      feature.run(featureId, featureId, STAMP, f === 0 ? null : 'f0');
      group.run(`g${f}`, featureId, STAMP);
      for (let s = 0; s < WORKLOAD.sessionsPerFeature; s += 1) {
        const id = `${featureId}-s${s}`;
        sessions.save({
          id, featureId, name: null, provider: 'fixture', requestedModel: 'auto',
          resolvedModel: null, status: 'completed', kind: 'dev', scope: 'feature',
          groupId: `g${f}`, prompt: 'Performance fixture', usageFilePath: `fixture-${id}`,
          createdAt: STAMP, startedAt: STAMP, endedAt: STAMP, exitCode: 0,
        });
        for (let turn = 0; turn < WORKLOAD.turnsPerSession; turn += 1) {
          rows.push(usage(id, featureId, turn));
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  createUsageRepo(db).saveAll(rows);
  return rows.length * 10;
}

async function seedHistory(root) {
  const event = (type, data) => JSON.stringify({ type, data, timestamp: STAMP }) + '\n';
  const filler = event('tool.execution_complete', { output: 'x'.repeat(16_384) });
  const body = event('user.message', { content: 'Latest fixture prompt', messageId: 'm1' }) +
    event('assistant.message', { content: 'Latest fixture response', originatingMessageId: 'm1' }) +
    filler.repeat(Math.ceil(WORKLOAD.historyMiB * 1024 * 1024 / filler.length));
  await mkdir(join(root, 'history'), { recursive: true });
  await writeFile(join(root, 'history', 'events.jsonl'), body);
  return Buffer.byteLength(body);
}

function summarize(samples) {
  return {
    count: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: Math.max(...samples),
  };
}

export async function runPerformance(options) {
  const report = {
    schemaVersion: 1, mode: options.baseline ? 'baseline' : 'gate',
    environment: {
      node: process.version, platform: process.platform, arch: process.arch,
      cpus: cpus().length, commit: process.env.GITHUB_SHA ?? null,
    },
    workload: WORKLOAD, metrics: {}, checks: [], failures: [],
  };
  const root = await mkdtemp(join(tmpdir(), 'studio-perf-'));
  let db;
  let server;
  let summaryRunner;
  let history;
  let fileLogging;
  let faultLogging;
  let sampler;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  try {
    assert.equal(typeof globalThis.gc, 'function', 'Run the performance harness with node --expose-gc');
    const databasePath = join(root, 'workspace.db');
    db = createDatabase({ databasePath });
    const expectedTokens = seed(db);
    report.historyBytes = await seedHistory(root);
    const config = { maxWorkers: 2, maxQueued: 6, timeoutMs: 15_000, workerMemoryMb: 128 };
    summaryRunner = createBackgroundWorkRunner({
      config, spawn: (input, progress) => spawnUsageSummaryWorker(input, progress, config.workerMemoryMb),
    });
    history = createLivePromptFsReader({
      sessionStateDir: root, eventsFile: 'events.jsonl', tailBytes: 512 * 1024,
      maxScanBytes: 16 * 1024 * 1024, worker: config,
    });
    const logOptions = {
      directory: join(root, 'logs'), filePrefix: 'perf', maxFileBytes: 128 * 1024,
      retainedFileCount: 8, maxRecordBytes: loggingDefaults.maxRecordBytes,
    };
    const logEvents = [];
    fileLogging = createQueuedFileLogging({
      config: loggingDefaults,
      spawnWriter: () => spawnLogWriterWorker(logOptions, { closeGraceMs: 1000 }),
      onEvent: (event) => { if (logEvents.length < 10) logEvents.push(event); },
    });
    const summary = (signal) => summaryRunner.run({ databasePath, rollupKinds: ['dev', 'meta'] }, { signal });
    const route = createAggregateRoutes({
      analytics: {
        forFeature: () => { throw new Error('Unconfigured fixture route'); },
        workspaceTotals: () => { throw new Error('Unconfigured fixture route'); },
        workspaceStats: () => { throw new Error('Unconfigured fixture route'); },
      },
      summary,
    }).find((candidate) => candidate.path === '/usage/summary');
    assert(route);
    const reportTextFailure = (failure) => report.failures.push(`Text attachment failure: ${JSON.stringify(failure)}`);
    const textAttachments = createTextAttachments({
      sessions: createSessionRepo(db),
      storage: createTextAttachmentStorage(join(root, 'text-attachments'), textAttachmentsDefaults, reportTextFailure),
      config: textAttachmentsDefaults,
      reportFailure: reportTextFailure,
    });
    const app = express();
    app.get('/health', (_request, response) => response.end('ok'));
    app.post('/sessions/:sessionId/text-attachments', createTextAttachmentBody(textAttachmentsDefaults.fileBytes));
    mountRoutes(app, [route, ...createTextAttachmentRoutes(textAttachments)]);
    server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path) => {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000) });
      if (response.status !== 200) {
        assert.fail(`${path}: HTTP ${response.status}: ${await response.text()}`);
      }
      return path === '/health' ? response.text() : response.json();
    };
    const check = (condition, name) => {
      assert(condition, name);
      report.checks.push(name);
    };
    const started = performance.now();
    const first = await request('/usage/summary');
    report.metrics.firstSummaryMs = performance.now() - started;
    check(first.features.f0.totals.inputTokens === expectedTokens, 'Initial hierarchy accounts for every seeded turn');
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const idle = [];
    for (let i = 0; i < 24; i += 1) {
      const before = performance.now();
      await request('/health');
      idle.push(performance.now() - before);
    }

    const health = [];
    const summaries = [];
    const scans = [];
    let activeProbes = 0;
    let probeFailure;
    let completedDuringWork = 0;
    let workActive = false;
    const peak = { summaryActive: 0, summaryQueued: 0, historyActive: 0, historyQueued: 0, rssBytes: 0 };
    const sample = () => {
      const a = summaryRunner.stats();
      const b = history.stats();
      peak.summaryActive = Math.max(peak.summaryActive, a.active);
      peak.summaryQueued = Math.max(peak.summaryQueued, a.queued);
      peak.historyActive = Math.max(peak.historyActive, b.active);
      peak.historyQueued = Math.max(peak.historyQueued, b.queued);
      peak.rssBytes = Math.max(peak.rssBytes, process.memoryUsage().rss);
    };
    const probe = async () => {
      if (activeProbes) return;
      activeProbes += 1;
      const before = performance.now();
      try {
        await request('/health');
        health.push(performance.now() - before);
        if (workActive) completedDuringWork += 1;
      } catch (error) {
        probeFailure = error;
      } finally {
        activeProbes -= 1;
      }
    };
    loop.enable();
    sampler = setInterval(() => { sample(); void probe(); }, 20);
    await new Promise((done) => setTimeout(done, 25));
    const mixedStart = performance.now();
    const logStarted = performance.now();
    for (let i = 0; i < WORKLOAD.logRecords; i += 1) {
      fileLogging.sink({ level: 'info', message: 'Fixture log', data: { index: i, apiKey: 'fixture-sensitive-log-value' } });
    }
    report.metrics.logEnqueueMs = performance.now() - logStarted;
    const logFlush = fileLogging.flush(15_000).then((flushed) => {
      if (!flushed) report.failures.push('Log flush did not confirm persistence of every accepted record');
      report.metrics.logFlushMs = performance.now() - logStarted;
    }).catch((error) => {
      report.failures.push(error.stack ?? String(error));
    });
    for (let round = 0; round < WORKLOAD.rounds; round += 1) {
      workActive = true;
      const jobs = [
        ...Array.from({ length: WORKLOAD.summaryConcurrency }, async () => {
          const before = performance.now();
          const value = await request('/usage/summary');
          assert.equal(value.features.f0.totals.inputTokens, expectedTokens);
          summaries.push(performance.now() - before);
        }),
        ...Array.from({ length: WORKLOAD.historyConcurrency }, async () => {
          const before = performance.now();
          const value = await history.latest('history');
          assert.equal(value?.text, 'Latest fixture prompt');
          assert.equal(value?.response, 'Latest fixture response');
          scans.push(performance.now() - before);
        }),
      ];
      await Promise.all(jobs);
      workActive = false;
      sample();
    }
    await logFlush;
    report.metrics.mixedTotalMs = performance.now() - mixedStart;
    clearInterval(sampler);
    sampler = undefined;
    while (activeProbes) await new Promise((done) => setTimeout(done, 5));
    if (probeFailure) throw probeFailure;
    loop.disable();
    check(completedDuringWork >= WORKLOAD.rounds, 'Unrelated HTTP requests complete while real workers are running');
    check(peak.summaryActive <= config.maxWorkers && peak.historyActive <= config.maxWorkers, 'Worker concurrency stays bounded');
    check(peak.summaryQueued <= config.maxQueued && peak.historyQueued <= config.maxQueued, 'Queue depth stays bounded');
    check(summaries.length === WORKLOAD.rounds * WORKLOAD.summaryConcurrency, 'Every concurrent summary completed without data loss');
    check(scans.length === WORKLOAD.rounds * WORKLOAD.historyConcurrency, 'Every bounded large-log scan returns the current prompt and response');
    report.latencyMs = { idleHealth: summarize(idle), loadedHealth: summarize(health), summary: summarize(summaries), history: summarize(scans) };
    report.peak = peak;
    report.logging = { ...fileLogging.stats(), events: logEvents };
    report.metrics.loadedHealthP95Ms = report.latencyMs.loadedHealth.p95;
    report.metrics.summaryP95Ms = report.latencyMs.summary.p95;
    report.metrics.historyP95Ms = report.latencyMs.history.p95;
    report.metrics.eventLoopP99Ms = loop.percentile(99) / 1e6;
    report.metrics.operationsPerSecond = (summaries.length + scans.length) / (report.metrics.mixedTotalMs / 1000);
    globalThis.gc?.();
    report.metrics.retainedHeapGrowthMiB = Math.max(0, process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

    createUsageRepo(db).saveAll([usage('f0-s0', 'f0', WORKLOAD.turnsPerSession, 17)]);
    check((await summary()).features.f0.totals.inputTokens === expectedTokens + 17, 'Next summary observes newly committed usage');
    db.prepare("UPDATE features SET parent_feature_id = NULL WHERE id = 'f1'").run();
    const moved = await summary();
    check(moved.features.f0.totals.inputTokens === expectedTokens + 17 - WORKLOAD.sessionsPerFeature * WORKLOAD.turnsPerSession * 10,
      'Hierarchy move invalidates attribution without losing child usage');
    check(moved.features.f1.totals.inputTokens === WORKLOAD.sessionsPerFeature * WORKLOAD.turnsPerSession * 10,
      'Moved feature retains all usage');
    const controller = new AbortController();
    const cancelled = history.latest('history', controller.signal);
    controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    check((await history.latest('history'))?.text === 'Latest fixture prompt', 'Pool recovers after active cancellation');
    const batch = Array.from({ length: config.maxWorkers + config.maxQueued }, () => summary());
    await assert.rejects(summary(), /queue is full/);
    await Promise.all(batch);
    check(true, 'Overload is rejected explicitly instead of growing the queue');
    await assert.rejects(summaryRunner.run({ databasePath: join(root, 'missing.db'), rollupKinds: ['dev'] }), /Usage summary failed/);
    check((await summary()).features.f1.totals.inputTokens > 0, 'Pool recovers after native worker failure');
    const logFiles = (await readdir(logOptions.directory)).sort(compareLogFiles);
    const logBodies = await Promise.all(logFiles.map((name) => readFile(join(logOptions.directory, name), 'utf8')));
    const logLines = logBodies.flatMap((body) => body.trim().split('\n'));
    const indexes = logLines.map((line) => JSON.parse(line).data.index);
    report.logging.records = {
      count: indexes.length, firstMismatch: indexes.findIndex((index, position) => index !== position),
      firstRecord: JSON.parse(logLines[0]),
      files: logFiles.map((name, index) => {
        const lines = logBodies[index].trim().split('\n');
        return {
          name, bytes: Buffer.byteLength(logBodies[index]), records: lines.length,
          firstIndex: JSON.parse(lines[0]).data.index, lastIndex: JSON.parse(lines.at(-1)).data.index,
        };
      }),
    };
    check(indexes.length === WORKLOAD.logRecords && indexes.every((index, position) => index === position),
      'Real log writer persists every burst record exactly once and in order');
    check(logBodies.every((body) => !body.includes('fixture-sensitive-log-value')), 'Native log writer preserves redaction');
    check(logFiles.length > 1 && logFiles.length <= logOptions.retainedFileCount &&
      logBodies.every((body) => Buffer.byteLength(body) <= logOptions.maxFileBytes),
    'Native log rotation respects file-size and retention bounds');
    const blockedDirectory = join(root, 'blocked-log-directory');
    await writeFile(blockedDirectory, 'Not a directory');
    faultLogging = createQueuedFileLogging({
      config: { ...loggingDefaults, maxWriterRestarts: 0 },
      spawnWriter: () => spawnLogWriterWorker(
        { ...logOptions, directory: blockedDirectory }, { closeGraceMs: 1000 },
      ),
    });
    faultLogging.sink({ level: 'error', message: 'Expected fixture disk failure' });
    const faultFlushed = await faultLogging.flush(5000);
    const faultClosed = await faultLogging.close(5000);
    report.loggingFault = { ...faultLogging.stats(), flushed: faultFlushed, closed: faultClosed };
    check(!faultFlushed && faultClosed && report.loggingFault.state === 'closed' &&
      report.loggingFault.persistenceConfirmed === false &&
      report.loggingFault.written === 0 && report.loggingFault.unconfirmed === 1,
    'Native disk failure reports unconfirmed persistence while confirming worker exit');
    const pastedBytes = Buffer.from('\ufeff' + '\u{1f600}'.repeat((WORKLOAD.textPasteBytes - 4) / 4) + 'x');
    assert.equal(pastedBytes.length, WORKLOAD.textPasteBytes);
    const pasteHealth = [];
    let pasteFinished = false;
    let pasteProbeFailure;
    let healthyDuringPaste = 0;
    const pasteProbe = (async () => {
      try {
        while (!pasteFinished || pasteHealth.length < 8) {
          const before = performance.now();
          await request('/health');
          pasteHealth.push(performance.now() - before);
          if (!pasteFinished) healthyDuringPaste += 1;
          await new Promise((done) => setTimeout(done, 2));
        }
      } catch (error) {
        pasteProbeFailure = error;
      }
    })();
    let offset = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (offset >= pastedBytes.length) {
          controller.close();
          return;
        }
        await new Promise((done) => setTimeout(done, 2));
        const end = Math.min(offset + 256 * 1024, pastedBytes.length);
        controller.enqueue(pastedBytes.subarray(offset, end));
        offset = end;
      },
    });
    loop.reset();
    loop.enable();
    const pasteStarted = performance.now();
    let savedPaste;
    try {
      const saved = await fetch(`${base}/sessions/f0-s0/text-attachments`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body, duplex: 'half', signal: AbortSignal.timeout(15_000),
      });
      assert.equal(saved.status, 201);
      savedPaste = await saved.json();
      report.metrics.textPasteMs = performance.now() - pasteStarted;
    } finally {
      pasteFinished = true;
      await pasteProbe;
      loop.disable();
    }
    if (pasteProbeFailure) throw pasteProbeFailure;
    report.metrics.textPasteHealthP95Ms = percentile(pasteHealth, 0.95);
    report.metrics.textPasteEventLoopP99Ms = loop.percentile(99) / 1e6;
    report.textPaste = { bytes: savedPaste.bytes, healthyDuringPaste, healthSamples: pasteHealth.length };
    check(savedPaste.sessionId === 'f0-s0' && savedPaste.bytes === pastedBytes.length &&
      (await readFile(savedPaste.path)).equals(pastedBytes),
    'A real 4 MiB UTF-8 paste persists byte-for-byte through the production HTTP and filesystem adapters');
    check(healthyDuringPaste > 0, 'Unrelated HTTP requests remain responsive during a real large-text paste');
    if (!options.baseline) {
      const budgets = JSON.parse(await readFile(join(HERE, 'performance-budgets.json'), 'utf8'));
      assert.deepEqual(Object.keys(budgets).sort(), [
        'firstSummaryMs', 'mixedTotalMs', 'loadedHealthP95Ms', 'summaryP95Ms',
        'historyP95Ms', 'eventLoopP99Ms', 'retainedHeapGrowthMiB',
        'logEnqueueMs', 'logFlushMs',
        'textPasteMs', 'textPasteHealthP95Ms', 'textPasteEventLoopP99Ms',
      ].sort(), 'Every performance metric must have an explicit budget');
      report.budgets = budgets;
      report.failures.push(...budgetFailures(report.metrics, budgets));
    }
  } catch (error) {
    report.failures.push(error.stack ?? String(error));
  } finally {
    if (sampler) clearInterval(sampler);
    loop.disable();
    if (fileLogging && !await fileLogging.close(15_000)) report.failures.push('Log writer physical exit or persistence could not be confirmed');
    if (fileLogging) report.logging = { ...report.logging, ...fileLogging.stats() };
    if (faultLogging) await faultLogging.close(5000);
    await Promise.all([summaryRunner?.close(), history?.close()]);
    if (server) {
      server.closeAllConnections();
      await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
    }
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
  report.verdict = report.failures.length ? 'fail' : options.baseline ? 'baseline-only' : 'pass';
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runPerformance(parseOptions(process.argv.slice(2)));
  console.log(JSON.stringify({ verdict: report.verdict, metrics: report.metrics, checks: report.checks.length, failures: report.failures }, null, 2));
  if (report.failures.length) process.exitCode = 1;
}

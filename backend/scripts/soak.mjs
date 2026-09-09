/**
 * Sustained-load soak for the backend.
 *
 * This exists because the unit and coverage gates prove logic, not behaviour
 * under sustained real load — and the defects that made 0.11.x feel unstable
 * (request timeouts, "Service unavailable", metasession state that stopped
 * matching reality, and provider processes that accumulated until the machine
 * starved) only appear over time with real processes involved.
 *
 * What it drives is deliberately the exact flow that exposed those defects:
 * repeatedly growing and shrinking a warm metasession pool, which spawns and
 * retires real provider CLI processes, while concurrently reading the endpoints
 * the Settings page uses. Anything cheaper would not reproduce the reports.
 *
 * Safety: the soak never touches the developer's real workspace. It runs the
 * backend against a throwaway database, usage directory and port, and it only
 * counts processes it can prove started after its own baseline snapshot.
 *
 * Usage:
 *   node backend/scripts/soak.mjs [--minutes=10] [--pool-max=4] [--verbose]
 *
 * Exits non-zero with a written verdict when a budget is violated.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const ENTRY = path.join(BACKEND, 'dist', 'main.js');

/** Executables a leaked AI session would be running under. */
const PROVIDER_PROCESS_NAMES = ['copilot', 'agency', 'claude', 'gemini', 'codex', 'node'];

function parseArgs(argv) {
  const options = { minutes: 10, poolMax: 4, verbose: false };
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`Unrecognised argument: ${arg}`);
    const [, name, value] = match;
    if (name === 'minutes') options.minutes = Number(value);
    else if (name === 'pool-max') options.poolMax = Number(value);
    else if (name === 'verbose') options.verbose = true;
    else throw new Error(`Unrecognised option: --${name}`);
  }
  if (!Number.isFinite(options.minutes) || options.minutes <= 0) {
    throw new Error('--minutes must be a positive number');
  }
  if (!Number.isInteger(options.poolMax) || options.poolMax < 1) {
    throw new Error('--pool-max must be a positive integer');
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Every running process as `pid -> { name, ppid }`.
 *
 * Leaked sessions are frequently re-parented once their spawner dies, so the
 * parent link cannot be trusted to find them. Instead the soak diffs whole
 * snapshots and treats any provider-shaped PID that appears after the baseline
 * and outlives shutdown as leaked, which holds regardless of re-parenting.
 */
async function processSnapshot() {
  const processes = new Map();
  if (process.platform === 'win32') {
    const script =
      'Get-CimInstance Win32_Process | ForEach-Object { ' +
      '"{0}`t{1}`t{2}" -f $_.ProcessId, $_.ParentProcessId, $_.Name }';
    const out = await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ]);
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid, name] = line.split('\t');
      if (!pid || !name) continue;
      processes.set(Number(pid), {
        name: name.replace(/\.exe$/i, '').toLowerCase(),
        ppid: Number(ppid),
      });
    }
    return processes;
  }
  const out = await run('ps', ['-axo', 'pid=,ppid=,comm=']);
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    processes.set(Number(match[1]), {
      name: path.basename(match[3].trim()).toLowerCase(),
      ppid: Number(match[2]),
    });
  }
  return processes;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

/** Provider-shaped PIDs present now that were absent at baseline. */
function newProviderPids(baseline, current) {
  const found = [];
  for (const [pid, info] of current) {
    if (baseline.has(pid)) continue;
    if (!PROVIDER_PROCESS_NAMES.includes(info.name)) continue;
    found.push({ pid, ...info });
  }
  return found;
}

class Metrics {
  constructor() {
    this.latencies = [];
    this.failures = [];
    this.requests = 0;
    this.samples = [];
  }

  record(ms) {
    this.requests += 1;
    this.latencies.push(ms);
  }

  fail(label, detail) {
    this.requests += 1;
    this.failures.push({ label, detail, at: new Date().toISOString() });
  }

  percentile(fraction) {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
    return sorted[index];
  }
}

/** A single request with a hard deadline, so a hang is recorded, not awaited. */
async function timedRequest(url, options, timeoutMs, metrics, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    const elapsed = Date.now() - started;
    if (!response.ok) {
      metrics.fail(label, `HTTP ${response.status} after ${elapsed}ms: ${body.slice(0, 200)}`);
      return null;
    }
    metrics.record(elapsed);
    return body ? JSON.parse(body) : null;
  } catch (error) {
    const elapsed = Date.now() - started;
    const reason = controller.signal.aborted
      ? `timed out after ${elapsed}ms`
      : `${error.message} after ${elapsed}ms`;
    metrics.fail(label, reason);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(base, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(500);
  }
  throw new Error(`Backend never became healthy: ${lastError}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(ENTRY)) {
    throw new Error(`Backend is not built (${ENTRY} missing). Run: npm run build`);
  }

  const root = await mkdtemp(path.join(tmpdir(), 'studio-soak-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  const metrics = new Metrics();
  await mkdir(path.join(root, 'usage'), { recursive: true });

  console.log(`Soak: ${options.minutes} min, pool 1..${options.poolMax}, port ${port}`);
  console.log(`Isolated data root: ${root}`);

  const baseline = await processSnapshot();
  console.log(`Baseline: ${baseline.size} processes running.`);

  const backend = spawn(process.execPath, [ENTRY], {
    cwd: BACKEND,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CW__api__port: String(port),
      CW__api__host: '127.0.0.1',
      CW__api__basePath: '/api',
      CW__persistence__databasePath: path.join(root, 'workspace.db'),
      CW__session__usageDir: path.join(root, 'usage'),
      CW_LOG_LEVEL: options.verbose ? 'debug' : 'warn',
      CW_WORKSPACE_CWD: root,
    },
  });

  let backendLog = '';
  const capture = (chunk) => {
    backendLog = (backendLog + chunk.toString()).slice(-65536);
    if (options.verbose) process.stdout.write(chunk);
  };
  backend.stdout.on('data', capture);
  backend.stderr.on('data', capture);

  let verdict = { ok: false, reasons: ['soak did not complete'] };
  try {
    await waitForHealth(base, 120000);
    console.log('Backend healthy. Starting sustained load.\n');

    const endAt = Date.now() + options.minutes * 60000;
    let stop = false;

    // Readers: the endpoints the Settings page depends on. These are what the
    // user saw time out and report incomplete state.
    const reader = async () => {
      while (!stop && Date.now() < endAt) {
        await timedRequest(`${base}/meta/pools`, {}, 15000, metrics, 'GET /meta/pools');
        await timedRequest(`${base}/meta/operations`, {}, 15000, metrics, 'GET /meta/operations');
        await timedRequest(`${base}/health`, {}, 5000, metrics, 'GET /health');
        await sleep(250);
      }
    };

    // Churn: grow and shrink the warm pool, spawning and retiring real
    // provider processes — the flow that produced the leak reports.
    const churn = async () => {
      let size = 1;
      let rising = true;
      while (!stop && Date.now() < endAt) {
        await timedRequest(
          `${base}/meta/pools/resize`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ purpose: 'general', size }),
          },
          30000,
          metrics,
          'POST /meta/pools/resize',
        );
        if (rising) {
          size += 1;
          if (size >= options.poolMax) rising = false;
        } else {
          size -= 1;
          if (size <= 1) rising = true;
        }
        await sleep(4000);
      }
    };

    // Sampler: process growth and backend memory over time.
    const sampler = async () => {
      while (!stop && Date.now() < endAt) {
        const snapshot = await processSnapshot();
        const spawned = newProviderPids(baseline, snapshot);
        const sample = {
          at: Date.now(),
          providerProcesses: spawned.length,
          totalProcesses: snapshot.size,
        };
        metrics.samples.push(sample);
        const remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000));
        console.log(
          `[${remaining.toString().padStart(4)}s left] ` +
          `provider procs: ${String(sample.providerProcesses).padStart(3)} | ` +
          `requests: ${String(metrics.requests).padStart(5)} | ` +
          `failures: ${metrics.failures.length}`,
        );
        await sleep(10000);
      }
    };

    await Promise.all([reader(), reader(), churn(), sampler()]);
    stop = true;

    // Cooldown: drain to the smallest pool and let retirement complete, so the
    // final count reflects steady state rather than work still in flight.
    console.log('\nDraining pool and cooling down...');
    await timedRequest(
      `${base}/meta/pools/resize`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'general', size: 1 }),
      },
      30000,
      metrics,
      'POST /meta/pools/resize (drain)',
    );
    await sleep(15000);

    const afterDrain = newProviderPids(baseline, await processSnapshot());
    console.log(`Provider processes after drain: ${afterDrain.length}`);

    verdict = await shutdownAndJudge(backend, baseline, metrics, afterDrain, options);
  } finally {
    if (backend.exitCode === null) {
      backend.kill();
      await Promise.race([once(backend, 'close'), sleep(10000)]);
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  report(metrics, verdict, backendLog);
  process.exitCode = verdict.ok ? 0 : 1;
}

/**
 * Shut the backend down and judge the run. Survivors are measured *after*
 * shutdown because a leaked session is precisely one that outlives the backend
 * that owned it.
 */
async function shutdownAndJudge(backend, baseline, metrics, afterDrain, options) {
  console.log('Stopping backend and checking for survivors...');
  backend.kill();
  await Promise.race([once(backend, 'close'), sleep(20000)]);
  await sleep(5000);

  const survivors = newProviderPids(baseline, await processSnapshot())
    // The soak's own shell helpers are short-lived `node`/`powershell` children;
    // only processes that outlive the backend matter here.
    .filter((entry) => entry.pid !== process.pid);

  const reasons = [];
  if (metrics.failures.length > 0) {
    reasons.push(`${metrics.failures.length} request failures/timeouts`);
  }
  if (survivors.length > 0) {
    reasons.push(
      `${survivors.length} provider processes survived backend shutdown: ` +
      survivors.map((s) => `${s.name}(${s.pid})`).join(', '),
    );
  }
  const peak = metrics.samples.reduce((max, s) => Math.max(max, s.providerProcesses), 0);
  return { ok: reasons.length === 0, reasons, survivors, afterDrain: afterDrain.length, peak, options };
}

function report(metrics, verdict, backendLog) {
  console.log('\n================ SOAK REPORT ================');
  console.log(`Requests:        ${metrics.requests}`);
  console.log(`Failures:        ${metrics.failures.length}`);
  console.log(`Latency p50:     ${metrics.percentile(0.5)}ms`);
  console.log(`Latency p95:     ${metrics.percentile(0.95)}ms`);
  console.log(`Latency p99:     ${metrics.percentile(0.99)}ms`);
  console.log(`Latency max:     ${Math.max(0, ...metrics.latencies)}ms`);
  console.log(`Peak provider processes: ${verdict.peak ?? 'n/a'}`);
  console.log(`After drain:             ${verdict.afterDrain ?? 'n/a'}`);
  console.log(`Survived shutdown:       ${verdict.survivors?.length ?? 'n/a'}`);

  if (metrics.failures.length > 0) {
    console.log('\nFirst failures:');
    for (const failure of metrics.failures.slice(0, 15)) {
      console.log(`  - ${failure.label}: ${failure.detail}`);
    }
  }

  if (!verdict.ok) {
    console.log('\nVERDICT: FAIL');
    for (const reason of verdict.reasons) console.log(`  - ${reason}`);
    if (backendLog.trim()) {
      console.log('\nBackend log tail:');
      console.log(backendLog.split(/\r?\n/).slice(-40).join('\n'));
    }
  } else {
    console.log('\nVERDICT: PASS');
  }
  console.log('=============================================');
}

main().catch((error) => {
  console.error(`\nSoak harness error: ${error.stack || error.message}`);
  process.exitCode = 1;
});

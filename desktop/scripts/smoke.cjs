'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseArgs } = require('node:util');
const { execFileSync } = require('node:child_process');
const {
  hashFile, loopbackUrl, boundedInteger, createFixture,
  waitFor, inspectPackage, killTree, Cdp, launchOwned,
} = require('./smoke-helpers.cjs');

const repo = path.resolve(__dirname, '..', '..');

async function main() {
  const { values } = parseArgs({ options: {
    exe: { type: 'string' }, out: { type: 'string' },
    'timeout-ms': { type: 'string', default: '30000' },
    'ready-delay-ms': { type: 'string', default: '0' },
    seed: { type: 'string', default: '0' },
    'baseline-clipboard': { type: 'boolean', default: false },
    clipboard: { type: 'boolean', default: false },
  } });
  const timeout = boundedInteger(values['timeout-ms'], 1000, 60000, 'timeout');
  const fixture = createFixture(values.out || path.join(repo, 'desktop', 'test-results'), {
    readyDelayMs: boundedInteger(values['ready-delay-ms'], 0, 5000, 'ready delay'),
    seed: values.seed,
  });
  const manifestPath = path.join(fixture.root, 'manifest.json');
  const manifest = {
    schemaVersion: 1,
    test: values['baseline-clipboard'] ? 'C1-component-boundary'
      : values.clipboard ? 'packaged-clipboard-ipc' : 'packaged-shell-synthetic-startup',
    startedAt: new Date().toISOString(),
    status: 'failed',
    source: {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
      dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
      lockSha256: await hashFile(path.join(repo, 'package-lock.json')),
      harnessSha256: await hashFile(__filename),
      helpersSha256: await hashFile(path.join(__dirname, 'smoke-helpers.cjs')),
      nativeLauncherSha256: await hashFile(path.join(__dirname, 'owned-process.ps1')),
    },
    runtime: {
      platform: process.platform, arch: process.arch, os: os.release(), node: process.version,
      nodeSha256: await hashFile(process.execPath),
    },
    configuration: { ...fixture.config, token: undefined, timeoutMs: timeout, backend: 'synthetic-only', providers: 'none', updater: 'stub' },
    scopeExceptions: [
      'Not production backend/UI readiness, native clipboard/keyboard/focus, PTY/ACP, migration, crash, or soak qualification.',
      values.clipboard
        ? 'Opt-in real OS clipboard IPC only; no native key injection, production UI or physical paste qualification. Clipboard formats restored best effort; use only an idle dedicated desktop.'
        : 'No real AI, provider installation, update feed, clipboard read/write, or native key injection is exercised.',
      'Package/source compatibility is checked before launch; historical packages without isolation are unsupported.',
    ],
    artifacts: ['manifest.json'],
    cleanup: 'not-started',
  };
  let child;
  let cdp;
  let browser;
  let endpoint;
  let spawnError;
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Smoke interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const started = Date.now();
  const deadline = setTimeout(() => controller.abort(new Error('Smoke deadline exceeded')), timeout);
  try {
    if (values['baseline-clipboard']) {
      const guard = require('../ipc-input.cjs');
      manifest.source.guardSha256 = await hashFile(path.join(repo, 'desktop', 'ipc-input.cjs'));
      manifest.observations = [32768, 32769].map((length) => ({
        length, accepted: guard.isClipboardText('x'.repeat(length)),
      }));
      if (manifest.observations.some((item) => !item.accepted)) {
        throw new Error('C1 source boundary reproduction: expected clipboard text rejected (not a native trial)');
      }
      manifest.status = 'passed';
      return;
    }
    const executable = path.resolve(values.exe || process.env.CW_TEST_EXE ||
      path.join(repo, 'desktop', 'release', 'win-unpacked', 'AI Project Studio.exe'));
    try {
      manifest.package = { executable: path.basename(executable) };
      if (fs.existsSync(executable)) manifest.package.executableSha256 = await hashFile(executable);
      const archive = process.platform === 'darwin'
        ? path.resolve(path.dirname(executable), '..', 'Resources', 'app.asar')
        : path.join(path.dirname(executable), 'resources', 'app.asar');
      if (fs.existsSync(archive)) manifest.package.archiveSha256 = await hashFile(archive);
      const inspected = inspectPackage(executable, repo);
      manifest.package.sourceHashes = inspected.sourceHashes;
      manifest.package.metadata = inspected.metadata;
      manifest.package.manifestSha256 = inspected.manifestSha256;
    } catch (error) {
      manifest.status = 'unsupported';
      throw error;
    }
    controller.signal.throwIfAborted();
    child = launchOwned(executable, [
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${path.join(fixture.root, 'profile')}`,
      '--no-first-run', '--disable-background-networking',
    ], fixture);
    manifest.pids = child.smokeJob ? { supervisor: child.pid } : { desktop: child.pid };
    let stdoutTail = '';
    child.stdout.on('data', (chunk) => {
      stdoutTail = (stdoutTail + chunk.toString()).slice(-1024);
      const match = stdoutTail.match(/SMOKE_PID=(\d+)/);
      if (match) manifest.pids.desktop = Number(match[1]);
    });
    child.once('error', (error) => { spawnError = error; });
    let stderrTail = '';
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-16384);
      const match = stderrTail.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-zA-Z0-9-]+)/);
      if (match) endpoint = loopbackUrl(match[1], ['ws:']).href;
    });
    const checkAlive = () => {
      controller.signal.throwIfAborted();
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Desktop exited before readiness');
    };
    await waitFor(() => { checkAlive(); return endpoint; }, timeout, { signal: controller.signal });
    browser = await Cdp.connect(endpoint);
    manifest.runtime.browser = await browser.call('Browser.getVersion');
    const target = await waitFor(async () => {
      checkAlive();
      const { targetInfos } = await browser.call('Target.getTargets');
      return targetInfos.find((item) => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(item.url));
    }, timeout, { signal: controller.signal });
    const api = loopbackUrl(target.url);
    const devtools = new URL(endpoint);
    const targets = await fetch(`http://127.0.0.1:${devtools.port}/json/list`, {
      signal: AbortSignal.timeout(5000), redirect: 'error',
    }).then((res) => { if (!res.ok) throw new Error('CDP target lookup failed'); return res.json(); });
    const page = targets.find((item) => item.id === target.targetId);
    if (!page) throw new Error('Owned renderer target missing');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    const expected = JSON.stringify(fixture.token);
    await waitFor(async () => {
      checkAlive();
      const result = await cdp.call('Runtime.evaluate', {
        expression: `document.readyState === 'complete' && document.body.dataset.fixture === ${expected} && typeof window.desktop?.getVersion === 'function'`,
        returnByValue: true,
      });
      return result.result.value === true;
    }, timeout, { signal: controller.signal });
    const version = await cdp.call('Runtime.evaluate', {
      expression: 'window.desktop.getVersion()', awaitPromise: true, returnByValue: true,
    });
    if (version.exceptionDetails || typeof version.result.value !== 'string' || !version.result.value) {
      throw new Error('Packaged preload IPC did not return a version');
    }
    const backend = JSON.parse(fs.readFileSync(path.join(fixture.root, 'backend.json'), 'utf8'));
    if (backend.token !== fixture.token || backend.port !== Number(api.port)) {
      throw new Error('Renderer/backend fixture identity mismatch');
    }
    manifest.pids.backend = backend.pid;
    manifest.ports = { backend: backend.port, cdp: Number(devtools.port) };
    manifest.runtime.appVersion = version.result.value;
    manifest.observations = { fixtureDocumentReady: true, preloadVersionAcknowledged: true };
    if (values.clipboard) {
      const probe = await cdp.call('Runtime.evaluate', {
        expression: 'window.desktop.runClipboardSmoke()', awaitPromise: true, returnByValue: true,
      }, 20000);
      if (probe.exceptionDetails || !probe.result.value) throw new Error('Clipboard probe returned no acknowledgement');
      manifest.clipboard = probe.result.value;
      if (manifest.clipboard.status !== 'passed') {
        manifest.status = manifest.clipboard.status === 'unsupported' ? 'unsupported' : 'failed';
        throw new Error('Clipboard IPC qualification did not pass; inspect outcome/restoration metadata');
      }
    }
    controller.signal.throwIfAborted();
    manifest.status = 'passed';
  } catch (error) {
    manifest.error = error.message;
  } finally {
    clearTimeout(deadline);
    cdp?.close();
    browser?.close();
    try {
      await killTree(child);
      manifest.cleanup = 'passed';
    } catch (error) {
      manifest.cleanup = 'failed';
      manifest.cleanupError = error.message;
      manifest.status = 'failed';
    }
    manifest.elapsedMs = Date.now() - started;
    manifest.finishedAt = new Date().toISOString();
    // Retain only synthetic metadata, never raw renderer/desktop output or profile data.
    try {
      for (const entry of fs.readdirSync(fixture.root)) {
        if (entry !== 'manifest.json') fs.rmSync(path.join(fixture.root, entry), {
          recursive: true, force: true, maxRetries: 5, retryDelay: 200,
        });
      }
    } catch (error) {
      manifest.cleanup = 'failed';
      manifest.cleanupError = `Synthetic profile removal failed (${error.code || 'unknown'})`;
      manifest.status = 'failed';
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    console.log(`${manifest.status}: ${manifest.test}\nManifest: ${manifestPath}`);
    if (manifest.error) console.log(manifest.error);
    process.exitCode = manifest.status === 'passed' ? 0 : manifest.status === 'unsupported' ? 2 : 1;
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  sha256, hashFile, loopbackUrl, boundedInteger, createFixture, isolatedEnv,
  waitFor, inspectPackage, killTree, Cdp, launchOwned, quoteWindowsArg, resolvePowerShell,
} = require('../scripts/smoke-helpers.cjs');
const { configure } = require('../regression-isolation.cjs');

const repo = path.resolve(__dirname, '..', '..');
function fixture(t, options) {
  const result = createFixture(path.join(repo, 'desktop', 'test-results'), options);
  t.after(() => fs.rmSync(result.root, { recursive: true, force: true }));
  return result;
}

function nativeFixture(t, args, executable = process.execPath) {
  const f = fixture(t);
  const child = launchOwned(executable, args, f);
  t.after(() => killTree(child));
  let stdout = '';
  let stderr = '';
  let error;
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-16384); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-16384); });
  child.once('error', (cause) => { error = cause; });
  const diagnostics = () => `node=${process.version}, controller=${child.pid}, ` +
    `host=${child.smokeControllerHost || 'native'}, ` +
    `exit=${child.exitCode}, signal=${child.signalCode}, error=${error?.message || 'none'}\n` +
    `stdout: ${stdout}\nstderr: ${stderr}`;
  const wait = (probe, timeoutMs) => waitFor(() => {
    if (error || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Native launcher exited before readiness: ${diagnostics()}`);
    }
    return probe();
  }, timeoutMs, { diagnostics });
  return {
    f, child, diagnostics,
    wait,
    waitForController: () => process.platform === 'win32'
      // Only gates the controller's one-time C# compile. A loaded CI runner can
      // take far longer than the launcher behaviour this test actually asserts,
      // so keep it generous — the strict assertions live in `wait` below.
      ? wait(() => stderr.includes('SMOKE_CONTROLLER=launching'), 180000)
      : Promise.resolve(),
  };
}

test('loopback endpoints reject remote hosts, credentials, redirects and non-websocket schemes', () => {
  assert.equal(loopbackUrl('http://127.0.0.1:1234/').port, '1234');
  assert.equal(loopbackUrl('ws://127.0.0.1:1234/a', ['ws:']).pathname, '/a');
  for (const url of ['http://localhost:1234', 'http://example.com:1234',
    'http://user@127.0.0.1:1234', 'http://127.0.0.1', 'file:///a', 'http://127.0.0.1:1234/#x']) {
    assert.throws(() => loopbackUrl(url));
  }
});

test('numeric bounds reject unbounded fixture timing', () => {
  assert.equal(boundedInteger('5000', 0, 5000, 'delay'), 5000);
  for (const value of ['oops', -1, 5001, 1.1, Infinity]) {
    assert.throws(() => boundedInteger(value, 0, 5000, 'delay'));
  }
});

test('Windows command-line quoting preserves whitespace, quotes and trailing backslashes', () => {
  assert.equal(quoteWindowsArg(''), '""');
  assert.equal(quoteWindowsArg('a b'), '"a b"');
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArg('C:\\a b\\'), '"C:\\a b\\\\"');
});

test('native controller prefers an absolute PowerShell 7 host without relying on fixture PATH', () => {
  const env = { ProgramFiles: 'program-files', SystemRoot: 'windows', PATH: 'untrusted-shims' };
  const modern = path.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  assert.equal(resolvePowerShell(env, (candidate) => {
    assert.equal(candidate, modern);
    return true;
  }), modern);
  assert.equal(resolvePowerShell(env, () => false),
    path.join('windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.equal(resolvePowerShell({ SYSTEMROOT: 'alternate-windows' }, () => false),
    path.join('alternate-windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
});

test('fixture env does not inherit provider credentials, PATH, config, or Node injection', (t) => {
  const f = fixture(t);
  const env = isolatedEnv(f, {
    GITHUB_TOKEN: 'never-forward', CW__provider__cliCommand: 'real-cli', NODE_OPTIONS: '--require evil',
    PATH: 'user-shims', CW_UPDATE_SIM: '1', CW_DESKTOP_DEV: '1', HOME: 'live-home',
    APPDATA: 'live-data', SystemRoot: process.env.SystemRoot || 'C:\\Windows',
  });
  for (const key of ['GITHUB_TOKEN', 'CW__provider__cliCommand', 'NODE_OPTIONS', 'CW_UPDATE_SIM', 'CW_DESKTOP_DEV']) {
    assert.equal(env[key], undefined);
  }
  assert.notEqual(env.PATH, 'user-shims');
  assert.equal(env.HOME, path.join(f.root, 'home'));
  assert.equal(env.APPDATA, path.join(f.root, 'appdata'));
  assert.equal(env.CW_NODE_BIN, process.execPath);
});

test('ordinary desktop launches are unchanged and do not read test fixtures', () => {
  assert.equal(configure({}, {}, 'unused'), null);
});

test('isolation selects a matching synthetic backend before profile access and stubs updates', (t) => {
  const f = fixture(t);
  const paths = {};
  const result = configure({ setPath: (key, value) => { paths[key] = value; }, quit() {} },
    isolatedEnv(f), path.join(f.root, 'work'));
  assert.equal(paths.userData, path.join(f.root, 'profile'));
  assert.equal(paths.sessionData, paths.userData);
  assert.equal(result.backendEntry, path.join(f.root, 'regression-backend.cjs'));
  assert.equal(result.updater.getState().canAutoInstall, false);
  result.updater.init();
  result.updater.installNow();
});

test('isolation fails closed for mismatched profile, cwd, token, source or injected launch', (t) => {
  const f = fixture(t);
  const env = isolatedEnv(f);
  const cwd = path.join(f.root, 'work');
  const app = { setPath() { throw new Error('must not configure paths'); } };
  for (const patch of [
    { HOME: 'live-profile' }, { CW_DESKTOP_SMOKE_TOKEN: 'wrong' }, { CW_NODE_BIN: 'node' },
    { CW_DESKTOP_DEV: '1' }, { NODE_OPTIONS: '--require evil' }, { ELECTRON_RUN_AS_NODE: '1' },
  ]) assert.throws(() => configure(app, { ...env, ...patch }, cwd), /Invalid|Unsafe/);
  assert.throws(() => configure(app, env, repo), /Invalid/);
  fs.appendFileSync(path.join(f.root, 'regression-backend.cjs'), '\n// mismatch');
  assert.throws(() => configure(app, env, cwd), /does not match/);
});

test('polling succeeds, times out, aborts and propagates fixture failures', async () => {
  let count = 0;
  assert.equal(await waitFor(() => ++count === 3 && 'ready', 500, { intervalMs: 1 }), 'ready');
  await assert.rejects(waitFor(() => false, 5, { intervalMs: 1 }), /Timed out/);
  await assert.rejects(waitFor(() => new Promise(() => {}), 5), /Timed out/);
  for (const probe of [() => false, () => new Promise(() => {})]) {
    await assert.rejects(waitFor(probe, 5, {
      intervalMs: 1, diagnostics: () => 'controller still compiling; stderr tail',
    }), /Timed out.*controller still compiling; stderr tail/);
  }
  await assert.rejects(waitFor(() => { throw new Error('fixture exited'); }, 500), /fixture exited/);
  await assert.rejects(waitFor(() => false, 500, { signal: AbortSignal.abort() }), /abort/i);
});

test('file hashing is streaming and reproducible', async (t) => {
  const f = fixture(t);
  assert.equal(await hashFile(path.join(f.root, 'fixture.json')),
    sha256(fs.readFileSync(path.join(f.root, 'fixture.json'))));
  await assert.rejects(hashFile(path.join(f.root, 'missing')));
});

test('package preflight refuses legacy/stale packages before execution', async (t) => {
  const f = fixture(t);
  const executable = path.join(f.root, 'smoke.exe');
  assert.throws(() => inspectPackage(executable, repo), /not found/);
  fs.writeFileSync(executable, '');
  assert.throws(() => inspectPackage(executable, repo), /app.asar/);
  const resources = process.platform === 'darwin'
    ? path.resolve(f.root, '..', 'Resources') : path.join(f.root, 'resources');
  // Use a self-contained .app layout on macOS so all output stays in the fixture.
  const exe = process.platform === 'darwin' ? path.join(f.root, 'Contents', 'MacOS', 'app') : executable;
  const resourceDir = process.platform === 'darwin' ? path.join(f.root, 'Contents', 'Resources') : resources;
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  fs.mkdirSync(resourceDir, { recursive: true });
  const input = path.join(f.root, 'archive-input');
  fs.mkdirSync(input);
  const asar = require('@electron/asar');
  for (const file of ['main.cjs', 'regression-isolation.cjs', 'regression-backend.cjs',
    'preload.cjs', 'ipc-input.cjs', 'clipboard.cjs', 'regression-clipboard.cjs',
    'backend-control.cjs', 'backend-identity.cjs', 'owned-attachments.cjs',
    'update-manager.cjs', 'package.json']) {
    fs.copyFileSync(path.join(repo, 'desktop', file), path.join(input, file));
  }
  const archive = path.join(resourceDir, 'app.asar');
  await asar.createPackage(input, archive);
  assert.ok(inspectPackage(exe, repo).sourceHashes['main.cjs']);
  asar.uncache(archive);
  const metadata = JSON.parse(fs.readFileSync(path.join(input, 'package.json'), 'utf8'));
  delete metadata.scripts;
  delete metadata.devDependencies;
  fs.writeFileSync(path.join(input, 'package.json'), JSON.stringify(metadata));
  await asar.createPackage(input, archive);
  assert.equal(inspectPackage(exe, repo).metadata.version, metadata.version);
  asar.uncache(archive);
  for (const module of ['backend-control.cjs', 'backend-identity.cjs', 'owned-attachments.cjs']) {
    fs.appendFileSync(path.join(input, module), '\n// stale');
    await asar.createPackage(input, archive);
    assert.throws(() => inspectPackage(exe, repo), new RegExp(`mismatch: ${module}`));
    asar.uncache(archive);
    fs.copyFileSync(path.join(repo, 'desktop', module), path.join(input, module));
  }
  fs.appendFileSync(path.join(input, 'main.cjs'), '\n// stale');
  await asar.createPackage(input, archive);
  assert.throws(() => inspectPackage(exe, repo), /mismatch/);
  asar.uncache(archive);
  fs.rmSync(path.join(input, 'regression-isolation.cjs'));
  fs.copyFileSync(path.join(repo, 'desktop', 'main.cjs'), path.join(input, 'main.cjs'));
  await asar.createPackage(input, archive);
  assert.throws(() => inspectPackage(exe, repo), /lacks safe smoke capability/);
  asar.uncache(archive);
});

test('packaging includes the shutdown owner and clipboard attachment implementation', () => {
  const config = fs.readFileSync(path.join(repo, 'desktop', 'electron-builder.yml'), 'utf8');
  const files = /^files:\r?\n((?:[ \t]+-[^\n]*\n)+)/m.exec(config)?.[1];
  assert.ok(files, 'Missing explicit desktop package files');
  for (const file of ['backend-control.cjs', 'backend-identity.cjs', 'owned-attachments.cjs']) {
    assert.match(files, new RegExp(`^  - ${file.replaceAll('.', '\\.')}\\r?$`, 'm'));
  }
});

test('delayed backend fixture uses a dynamic loopback port and cleans up its owned child', async (t) => {
  const f = fixture(t, { readyDelayMs: 80 });
  const env = { ...isolatedEnv(f), CW__api__port: '0' };
  const child = spawn(process.execPath, [path.join(f.root, 'regression-backend.cjs')], {
    cwd: path.join(f.root, 'work'), env, stdio: 'ignore', detached: process.platform !== 'win32',
  });
  t.after(() => killTree(child));
  assert.equal(fs.existsSync(path.join(f.root, 'backend.json')), false);
  const record = await waitFor(() => {
    const file = path.join(f.root, 'backend.json');
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8'));
  }, 5000);
  assert.equal(record.pid, child.pid);
  assert.equal(record.token, f.token);
  const response = await fetch(`http://127.0.0.1:${record.port}/`, { signal: AbortSignal.timeout(2000) });
  assert.match(await response.text(), new RegExp(f.token));
  assert.deepEqual(await fetch(`http://127.0.0.1:${record.port}/api/providers`,
    { signal: AbortSignal.timeout(2000) }).then((res) => res.json()), []);
  await killTree(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

for (const via of ['http', 'ipc']) test(`synthetic backend acknowledges shutdown via ${via} before normal exit`, async (t) => {
  const f = fixture(t, { readyDelayMs: 0 });
  const nonce = 'owned-smoke-generation';
  const child = spawn(process.execPath, [path.join(f.root, 'regression-backend.cjs')], {
    cwd: path.join(f.root, 'work'),
    env: { ...isolatedEnv(f), CW__api__port: '0', CW_DESKTOP_SHUTDOWN_NONCE: nonce },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    detached: process.platform !== 'win32',
  });
  t.after(() => killTree(child));
  const events = [];
  child.on('message', (message) => events.push(message));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    events.push({ code, signal });
    resolve();
  }));
  const record = await waitFor(() => {
    const file = path.join(f.root, 'backend.json');
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8'));
  }, 5000);
  if (via === 'http') {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/shutdown`, {
      method: 'POST', signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'shutting-down' });
  } else {
    child.send({ type: 'shutdown-request', nonce: 'wrong-generation' });
    const response = await fetch(`http://127.0.0.1:${record.port}/api/providers`, {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 200);
    await response.text();
    child.send({ type: 'shutdown-request', nonce });
  }
  await Promise.race([
    exited,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic backend failed to exit')), 5000);
      timer.unref();
      exited.then(() => clearTimeout(timer));
    }),
  ]);
  assert.deepEqual(events, [
    { type: 'shutdown-complete', nonce },
    { code: 0, signal: null },
  ]);
});

test('CDP correlates replies, rejects protocol errors, times out and drains on disconnect', async () => {
  class Socket extends EventEmitter {
    send(raw) { this.sent = JSON.parse(raw); }
    terminate() { this.emit('close'); }
  }
  const socket = new Socket();
  const cdp = new Cdp(socket);
  const first = cdp.call('test.first');
  const firstId = socket.sent.id;
  const second = cdp.call('test.second');
  socket.emit('message', JSON.stringify({ id: socket.sent.id, result: { value: 2 } }));
  socket.emit('message', JSON.stringify({ method: 'event' }));
  socket.emit('message', 'not json');
  socket.emit('message', JSON.stringify({ id: firstId, result: { value: 1 } }));
  assert.deepEqual(await first, { value: 1 });
  assert.deepEqual(await second, { value: 2 });
  const error = cdp.call('test.error');
  socket.emit('message', JSON.stringify({ id: socket.sent.id, error: { message: 'protocol rejected' } }));
  await assert.rejects(error, /protocol rejected/);
  await assert.rejects(cdp.call('test.timeout', {}, 5), /CDP timeout/);
  const closed = cdp.call('test.close');
  cdp.close();
  await assert.rejects(closed, /disconnected/);
  assert.equal(cdp.pending.size, 0);
  socket.send = () => { throw new Error('send failed'); };
  await assert.rejects(cdp.call('test.send'), /send failed/);
  assert.equal(cdp.pending.size, 0);
});

test('CDP connects to a real ephemeral loopback websocket', async (t) => {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const { id } = JSON.parse(raw);
    socket.send(JSON.stringify({ id, result: { protocolVersion: 'fixture' } }));
  }));
  const cdp = await Cdp.connect(`ws://127.0.0.1:${server.address().port}/devtools/browser/fixture`);
  t.after(() => cdp.close());
  assert.equal((await cdp.call('Browser.getVersion')).protocolVersion, 'fixture');
  await assert.rejects(Cdp.connect('ws://example.com:1234'), /loopback/);
});

test('owned native launcher forwards stderr and cleans up descendant processes on controller EOF', async (t) => {
  const argumentsToPreserve = ['space here', 'quote"here', 'trailing\\'];
  const { f, child, wait, waitForController, diagnostics } = nativeFixture(t,
    [path.join(__dirname, 'fixtures', 'owned-child.cjs'), ...argumentsToPreserve]);
  await waitForController();
  const record = await wait(() => {
    const file = path.join(f.root, 'owned.json');
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8'));
  }, 15000);
  assert.deepEqual(record.arguments, argumentsToPreserve);
  await wait(() => diagnostics().includes('synthetic stderr forwarded'), 3000);
  if (process.platform === 'win32') {
    child.stdin.end();
    await waitFor(() => child.exitCode !== null, 8000, { diagnostics });
  } else {
    await killTree(child);
  }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await waitFor(() => !alive(record.parent) && !alive(record.descendant), 5000);
});

test('owned native launcher reports early executable failure and cleans up its descendants', async (t) => {
  const { f, child, wait, waitForController } = nativeFixture(t,
    [path.join(__dirname, 'fixtures', 'owned-child.cjs'), '--exit-parent']);
  await waitForController();
  await assert.rejects(wait(() => false, 15000),
    /Native launcher exited before readiness:[\s\S]*exit=42[\s\S]*synthetic stderr forwarded/);
  assert.equal(child.exitCode, 42);
  const record = JSON.parse(fs.readFileSync(path.join(f.root, 'owned.json'), 'utf8'));
  if (process.platform !== 'win32') await killTree(child);
  await waitFor(() => {
    try { process.kill(record.descendant, 0); return false; } catch { return true; }
  }, 5000);
});

test('owned native launcher exposes process creation errors before readiness', async (t) => {
  const { wait, waitForController } = nativeFixture(t, [], `${process.execPath}.missing`);
  await waitForController();
  await assert.rejects(wait(() => false, 15000),
    /Native launcher exited before readiness:[\s\S]*(CreateProcess failed \(Win32 2\)|ENOENT)/);
});

test('release packaging/publication requires build and coverage for the exact triggering SHA', () => {
  const workflow = require('js-yaml').load(fs.readFileSync(path.join(repo, '.github', 'workflows', 'release.yml'), 'utf8'));
  assert.equal(workflow.jobs.build.needs, 'verify');
  for (const job of [workflow.jobs.verify, workflow.jobs.build]) {
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ github.sha }}');
  }
  const commands = workflow.jobs.verify.steps.map((step) => step.run);
  for (const required of ['npm run build', 'npm run test:desktop:harness',
    'npm run test:coverage --workspace backend', 'npm run test:coverage --workspace ui']) {
    assert.ok(commands.includes(required), `Missing release prerequisite: ${required}`);
  }
});

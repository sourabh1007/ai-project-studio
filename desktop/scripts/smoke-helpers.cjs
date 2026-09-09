'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { PROTOCOL } = require('../regression-isolation.cjs');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk))
    .on('end', () => resolve(hash.digest('hex')));
});

function loopbackUrl(value, protocols = ['http:']) {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || url.hostname !== '127.0.0.1' ||
      !url.port || url.username || url.password || url.hash) {
    throw new Error('Expected an explicit IPv4 loopback endpoint');
  }
  return url;
}

function boundedInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Invalid ${name}`);
  }
  return number;
}

function createFixture(output, { readyDelayMs = 0, seed = '0' } = {}) {
  boundedInteger(readyDelayMs, 0, 5000, 'ready delay');
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(path.resolve(output), 'smoke-'));
  const token = crypto.randomBytes(16).toString('hex');
  for (const dir of ['home', 'appdata', 'localappdata', 'config', 'data', 'cache', 'profile', 'work', 'scratch']) {
    fs.mkdirSync(path.join(root, dir));
  }
  const config = { protocol: PROTOCOL, token, readyDelayMs, seed: String(seed) };
  fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify(config));
  for (const file of ['regression-backend.cjs', 'regression-isolation.cjs', 'backend-identity.cjs']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
  }
  return { root, token, config };
}

function isolatedEnv(fixture, parent = process.env) {
  // Allow-list, not {...process.env}: excludes credentials, provider config,
  // NODE_OPTIONS, Electron overrides, and user PATH shims.
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'DISPLAY', 'WAYLAND_DISPLAY']) {
    const actual = Object.keys(parent).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (actual) env[key] = parent[actual];
  }
  const system = parent.SystemRoot || parent.SYSTEMROOT || 'C:\\Windows';
  env.PATH = process.platform === 'win32' ? path.join(system, 'System32') : '/usr/bin:/bin';
  for (const [key, dir] of Object.entries({
    HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata',
    XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache',
    TMP: 'scratch', TEMP: 'scratch', TMPDIR: 'scratch',
  })) env[key] = path.join(fixture.root, dir);
  return {
    ...env,
    CW_NODE_BIN: process.execPath,
    CW_DESKTOP_SMOKE_ROOT: fixture.root,
    CW_DESKTOP_SMOKE_TOKEN: fixture.token,
    CW_STARTUP_TIMEOUT_MS: '15000',
  };
}

function quoteWindowsArg(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

function resolvePowerShell(env = process.env, exists = fs.existsSync) {
  const modern = path.join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  // PowerShell 7 compiles the job controller in-process instead of launching
  // the legacy .NET Framework compiler inside the isolated fixture environment.
  if (exists(modern)) return modern;
  return path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function launchOwned(executable, args, fixture) {
  const cwd = path.join(fixture.root, 'work');
  const env = isolatedEnv(fixture);
  if (process.platform !== 'win32') {
    return spawn(executable, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  const launchFile = path.join(fixture.root, 'launch.json');
  fs.writeFileSync(launchFile, JSON.stringify({
    executable, cwd, commandLine: [executable, ...args].map(quoteWindowsArg).join(' '),
  }));
  const powershell = resolvePowerShell();
  const child = spawn(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'owned-process.ps1'), '-LaunchFile', launchFile,
  ], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.smokeJob = true;
  child.smokeControllerHost = powershell;
  return child;
}

async function waitFor(probe, timeoutMs, { intervalMs = 50, signal, diagnostics } = {}) {
  const deadline = Date.now() + timeoutMs;
  const timeoutError = () => new Error('Timed out waiting for fixture readiness' +
    (diagnostics ? `: ${diagnostics()}` : ''));
  do {
    signal?.throwIfAborted();
    let timer;
    let abort;
    const result = await Promise.race([
      Promise.resolve().then(probe),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()),
          Math.max(0, deadline - Date.now()));
        abort = () => reject(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
      }),
    ]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
    if (result) return result;
    if (Date.now() >= deadline) throw timeoutError();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (true);
}

function inspectPackage(executable, repo) {
  if (!fs.existsSync(executable)) throw new Error('Packaged executable not found');
  const resources = process.platform === 'darwin'
    ? path.resolve(path.dirname(executable), '..', 'Resources')
    : path.join(path.dirname(executable), 'resources');
  const archive = path.join(resources, 'app.asar');
  if (!fs.existsSync(archive)) throw new Error('Expected an unpacked installed package with app.asar');
  const asar = require('@electron/asar');
  const files = ['main.cjs', 'regression-isolation.cjs', 'regression-backend.cjs',
    'preload.cjs', 'ipc-input.cjs', 'clipboard.cjs', 'regression-clipboard.cjs',
    'backend-control.cjs', 'backend-identity.cjs', 'owned-attachments.cjs',
    'update-manager.cjs'];
  const sourceHashes = {};
  for (const file of files) {
    const expected = sha256(fs.readFileSync(path.join(repo, 'desktop', file)));
    let actual;
    try { actual = sha256(asar.extractFile(archive, file)); } catch {
      throw new Error(`Package lacks safe smoke capability: ${file}; rebuild before launching`);
    }
    if (actual !== expected) throw new Error(`Package/source mismatch: ${file}; rebuild before launching`);
    sourceHashes[file] = actual;
  }
  // electron-builder strips scripts/devDependencies from the application
  // manifest. Compare launch identity, not byte formatting or dev-only fields.
  const packageBytes = asar.extractFile(archive, 'package.json');
  const metadata = JSON.parse(packageBytes.toString());
  const expectedMetadata = JSON.parse(fs.readFileSync(path.join(repo, 'desktop', 'package.json'), 'utf8'));
  for (const key of ['name', 'version', 'main']) {
    if (metadata[key] !== expectedMetadata[key]) throw new Error(`Package identity mismatch: ${key}`);
  }
  return { archive, sourceHashes, metadata: {
    name: metadata.name, version: metadata.version, main: metadata.main,
  }, manifestSha256: sha256(packageBytes) };
}

async function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.smokeJob) {
      child.stdin.end();
      try {
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 8000);
        return;
      } catch {
        // Terminating the job owner still closes its OS handle and all members.
        child.kill();
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000);
        return;
      }
    }
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { killer.kill(); reject(new Error('Process tree cleanup timed out')); }, 5000);
      killer.once('error', (error) => { clearTimeout(timer); reject(error); });
      killer.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000);
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const rejectAll = () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('CDP disconnected'));
      }
      this.pending.clear();
    };
    socket.on('close', rejectAll);
    socket.on('error', rejectAll);
  }
  static async connect(endpoint) {
    loopbackUrl(endpoint, ['ws:']);
    const WebSocket = require('ws');
    const socket = new WebSocket(endpoint, { handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new Cdp(socket);
  }
  call(method, params = {}, timeoutMs = 5000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  close() { this.socket.terminate(); }
}

module.exports = {
  sha256, hashFile, loopbackUrl, boundedInteger, createFixture, isolatedEnv,
  waitFor, inspectPackage, killTree, Cdp, quoteWindowsArg, launchOwned, resolvePowerShell,
};

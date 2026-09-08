'use strict';

function normalizeBasePath(basePath) {
  if (typeof basePath !== 'string' || basePath.length === 0) {
    return '/api';
  }
  return basePath.startsWith('/') ? basePath : `/${basePath}`;
}

function backendShutdownUrl({ host, port, basePath }) {
  const url = new URL(`http://${host}:${port}`);
  url.pathname = `${normalizeBasePath(basePath).replace(/\/$/, '')}/shutdown`;
  return url.toString();
}

async function requestBackendShutdown({
  host,
  port,
  basePath,
  fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
}) {
  if (typeof fetchImpl !== 'function') {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(backendShutdownUrl({ host, port, basePath }), {
      method: 'POST',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function requestBackendShutdownIpc(child, nonce, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof child?.send !== 'function' || child.connected === false ||
        typeof nonce !== 'string' || nonce.length === 0) {
      reject(new Error('Backend shutdown IPC channel is unavailable'));
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error('Backend shutdown IPC send did not complete in time'));
    }, timeoutMs);
    try {
      // false means backpressure, not failure or delivery. Neither the return
      // value nor this callback proves backend cleanup or process termination.
      child.send({ type: 'shutdown-request', nonce }, (error) => {
        finish(error ? new Error('Backend shutdown IPC send failed') : null);
      });
    } catch {
      finish(new Error('Backend shutdown IPC send failed'));
    }
  });
}

function waitForChildExit(child, timeoutMs) {
  if (!child) {
    return Promise.resolve(true);
  }
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve(child.exitCode === 0 && child.signalCode == null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
      resolve(value);
    };
    const onExit = (code, signal) => finish(code === 0 && signal == null);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    child.once('close', onExit);
  });
}

module.exports = {
  backendShutdownUrl,
  requestBackendShutdown,
  requestBackendShutdownIpc,
  waitForChildExit,
};

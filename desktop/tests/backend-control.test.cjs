'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  backendShutdownUrl,
  requestBackendShutdown,
  requestBackendShutdownIpc,
  waitForChildExit,
} = require('../backend-control.cjs');

test('backendShutdownUrl normalizes the API base path', () => {
  assert.equal(
    backendShutdownUrl({ host: '127.0.0.1', port: 4319, basePath: '/api' }),
    'http://127.0.0.1:4319/api/shutdown',
  );
  assert.equal(
    backendShutdownUrl({ host: '127.0.0.1', port: 4319, basePath: 'v1' }),
    'http://127.0.0.1:4319/v1/shutdown',
  );
});

test('requestBackendShutdown POSTs to the backend and treats failures as best effort', async () => {
  const calls = [];
  assert.equal(
    await requestBackendShutdown({
      host: '127.0.0.1',
      port: 4319,
      basePath: '/api',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true };
      },
    }),
    true,
  );
  assert.equal(calls[0].url, 'http://127.0.0.1:4319/api/shutdown');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.signal.aborted, false);
  assert.equal(
    await requestBackendShutdown({
      host: '127.0.0.1',
      port: 4319,
      basePath: '/api',
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
    false,
  );
});

test('waitForChildExit resolves true on exit and false on timeout', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const done = waitForChildExit(child, 100);
  child.emit('exit', 0);
  assert.equal(await done, true);

  const stuck = new EventEmitter();
  stuck.exitCode = null;
  stuck.signalCode = null;
  assert.equal(await waitForChildExit(stuck, 1), false);
  assert.equal(stuck.listenerCount('exit'), 0);
  assert.equal(stuck.listenerCount('close'), 0);
});

test('waitForChildExit never treats missing exit fields or a successful kill request as confirmation', async () => {
  const child = new EventEmitter();
  child.killed = true;
  assert.equal(await waitForChildExit(child, 1), false);
  child.exitCode = 0;
  assert.equal(await waitForChildExit(child, 1), true);
  const signalled = new EventEmitter();
  signalled.signalCode = 'SIGTERM';
  assert.equal(await waitForChildExit(signalled, 1), false);
});

test('IPC shutdown request uses the nonce and awaits callback despite a false send return', async () => {
  let complete;
  const messages = [];
  const child = {
    connected: true,
    send(message, callback) { messages.push(message); complete = callback; return false; },
  };
  let settled = false;
  const request = requestBackendShutdownIpc(child, 'fixture-generation').then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(messages, [{ type: 'shutdown-request', nonce: 'fixture-generation' }]);
  complete(null);
  await request;
  assert.equal(settled, true);
});

test('IPC shutdown request rejects callback errors and thrown sends without leaking details', async () => {
  for (const send of [
    (_message, callback) => { callback(new Error('private-path')); return true; },
    () => { throw new Error('private-path'); },
  ]) {
    await assert.rejects(requestBackendShutdownIpc({ send }, 'fixture-generation'), {
      message: 'Backend shutdown IPC send failed',
    });
  }
});

test('IPC send timeout is not delivery and never resends or accepts a late callback', async () => {
  let complete;
  let calls = 0;
  const child = { send(_message, callback) { calls++; complete = callback; return true; } };
  await assert.rejects(requestBackendShutdownIpc(child, 'fixture-generation', { timeoutMs: 1 }), /did not complete/);
  complete(null);
  assert.equal(calls, 1);
});

test('IPC request rejects missing channels or nonces without sending', async () => {
  for (const child of [null, {}, { connected: false, send: () => assert.fail('disconnected') }]) {
    await assert.rejects(requestBackendShutdownIpc(child, 'fixture-generation'), /unavailable/);
  }
  await assert.rejects(requestBackendShutdownIpc({ send: () => assert.fail('no nonce') }, ''), /unavailable/);
});

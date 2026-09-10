'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'preload.cjs'),
  'utf8',
);

function loadPreload() {
  const calls = [];
  const ipcRenderer = new EventEmitter();
  ipcRenderer.send = (...args) => calls.push({ kind: 'send', args });
  ipcRenderer.invoke = async (...args) => {
    calls.push({ kind: 'invoke', args });
    return { channel: args[0], payload: args[1] };
  };
  let exposed;
  vm.runInNewContext(source, {
    URL,
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(name, api) {
            assert.equal(name, 'desktop');
            exposed = api;
          },
        },
        ipcRenderer,
      };
    },
  });
  assert.ok(exposed);
  return { bridge: exposed, calls, ipcRenderer };
}

test('real preload composes retained-image, diagnostics, clipboard, restart, and update journeys', async () => {
  const { bridge, calls, ipcRenderer } = loadPreload();

  assert.deepEqual(
    await bridge.attachments.list(),
    { channel: 'attachments:list', payload: undefined },
  );
  assert.deepEqual(
    await bridge.attachments.remove({ ids: ['opaque-image-id'] }),
    { channel: 'attachments:remove', payload: { ids: ['opaque-image-id'] } },
  );
  assert.deepEqual(
    await bridge.backendDiagnostics(),
    { channel: 'diagnostics:backend', payload: undefined },
  );
  assert.deepEqual(
    await bridge.relaunch(),
    { channel: 'app:relaunch', payload: undefined },
  );
  assert.deepEqual(
    await bridge.readImage({ sessionId: 'session-1' }),
    { channel: 'clipboard:readImage', payload: { sessionId: 'session-1' } },
  );
  assert.deepEqual(
    await bridge.copyText('diagnostics report'),
    { channel: 'clipboard:write', payload: 'diagnostics report' },
  );

  assert.deepEqual(
    await bridge.updates.getState(),
    { channel: 'update:getState', payload: undefined },
  );
  assert.deepEqual(
    await bridge.updates.check(),
    { channel: 'update:check', payload: undefined },
  );
  assert.deepEqual(
    await bridge.updates.download(),
    { channel: 'update:download', payload: undefined },
  );
  assert.deepEqual(
    await bridge.updates.install(),
    { channel: 'update:install', payload: undefined },
  );

  const unavailable = [];
  const stopListening = bridge.onBackendUnavailable((payload) => unavailable.push(payload));
  const updateEvents = [];
  const stopUpdates = bridge.updates.onEvent((type, payload) => {
    updateEvents.push({ type, payload });
  });
  ipcRenderer.emit('backend:unavailable', {}, { reason: 'restart budget exhausted' });
  ipcRenderer.emit('update:event', {}, { status: 'downloaded' });
  ipcRenderer.emit('update:before-quit', {}, { pending: true });
  assert.deepEqual(unavailable, [{ reason: 'restart budget exhausted' }]);
  assert.deepEqual(updateEvents, [
    { type: 'event', payload: { status: 'downloaded' } },
    { type: 'before-quit', payload: { pending: true } },
  ]);
  stopListening();
  stopUpdates();
  ipcRenderer.emit('backend:unavailable', {}, { reason: 'ignored' });
  ipcRenderer.emit('update:event', {}, { status: 'ignored' });
  assert.deepEqual(unavailable, [{ reason: 'restart budget exhausted' }]);
  assert.equal(updateEvents.length, 2);

  assert.deepEqual(
    calls.map(({ kind, args }) => [kind, ...args]),
    [
      ['invoke', 'attachments:list'],
      ['invoke', 'attachments:remove', { ids: ['opaque-image-id'] }],
      ['invoke', 'diagnostics:backend'],
      ['invoke', 'app:relaunch'],
      ['invoke', 'clipboard:readImage', { sessionId: 'session-1' }],
      ['invoke', 'clipboard:write', 'diagnostics report'],
      ['invoke', 'update:getState'],
      ['invoke', 'update:check'],
      ['invoke', 'update:download'],
      ['invoke', 'update:install'],
    ],
  );
});

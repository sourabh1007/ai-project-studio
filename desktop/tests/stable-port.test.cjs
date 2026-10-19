'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createStablePort,
  isValidPort,
  findFreePort,
  isPortAvailable,
} = require('../stable-port.cjs');

/** An in-memory fs shim recording the last written port file. */
function fakeIo(initial) {
  const files = new Map();
  if (initial !== undefined) {
    files.set('port.json', initial);
  }
  return {
    files,
    readFileSync: (p) => {
      if (!files.has(p)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(p);
    },
    mkdirSync: () => {},
    writeFileSync: (p, data) => files.set(p, data),
  };
}

test('isValidPort accepts in-range integers only', () => {
  assert.equal(isValidPort(1), true);
  assert.equal(isValidPort(65535), true);
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort(65536), false);
  assert.equal(isValidPort(3000.5), false);
  assert.equal(isValidPort('3000'), false);
});

test('reuses the remembered port when it is still free', async () => {
  const io = fakeIo(JSON.stringify({ port: 4321 }));
  const resolver = createStablePort({
    host: '127.0.0.1',
    portFile: 'port.json',
    io,
    available: async (_host, port) => port === 4321,
    freePort: async () => 9999,
  });
  assert.equal(await resolver.resolve(), 4321);
  // The unchanged port is not rewritten.
  assert.equal(io.files.get('port.json'), JSON.stringify({ port: 4321 }));
});

test('falls back to a fresh free port when the remembered one is taken', async () => {
  const io = fakeIo(JSON.stringify({ port: 4321 }));
  const resolver = createStablePort({
    host: '127.0.0.1',
    portFile: 'port.json',
    io,
    available: async () => false,
    freePort: async () => 5555,
  });
  assert.equal(await resolver.resolve(), 5555);
  assert.equal(io.files.get('port.json'), JSON.stringify({ port: 5555 }));
});

test('picks and persists a free port on first launch (no file yet)', async () => {
  const io = fakeIo();
  const resolver = createStablePort({
    host: '127.0.0.1',
    portFile: 'port.json',
    io,
    available: async () => true,
    freePort: async () => 6060,
  });
  assert.equal(await resolver.resolve(), 6060);
  assert.equal(io.files.get('port.json'), JSON.stringify({ port: 6060 }));
});

test('ignores a corrupt or out-of-range remembered port', async () => {
  for (const bad of ['not json', JSON.stringify({ port: 0 }), JSON.stringify({})]) {
    const io = fakeIo(bad);
    const resolver = createStablePort({
      host: '127.0.0.1',
      portFile: 'port.json',
      io,
      available: async () => {
        throw new Error('availability must not be probed for an invalid port');
      },
      freePort: async () => 7070,
    });
    assert.equal(await resolver.resolve(), 7070);
  }
});

test('never throws when persisting the port fails', async () => {
  const io = fakeIo();
  io.writeFileSync = () => {
    throw new Error('disk full');
  };
  const resolver = createStablePort({
    host: '127.0.0.1',
    portFile: 'port.json',
    io,
    available: async () => true,
    freePort: async () => 8080,
  });
  assert.equal(await resolver.resolve(), 8080);
});

test('real free-port probe yields an available port', async () => {
  const port = await findFreePort('127.0.0.1');
  assert.equal(isValidPort(port), true);
  assert.equal(await isPortAvailable('127.0.0.1', port), true);
});

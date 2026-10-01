'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { provisionDependencies, prependToPath } = require('../dependency-provision.cjs');

function fakeNode(nodeBin) {
  return () => ({ ensureNode: async () => nodeBin });
}

function fakeTool(results) {
  return (spec) => ({ ensure: async () => {
    const outcome = results[spec.id];
    if (outcome instanceof Error) throw outcome;
    return outcome ?? null;
  } });
}

test('provisions Node and collects bin dirs for Node plus resolvable tools', async () => {
  const events = [];
  const result = await provisionDependencies({
    platform: 'win32', arch: 'x64', env: {}, runtimeDir: 'C:\\data\\runtime', pathImpl: path.win32,
    makeNodeProvisioner: fakeNode('C:\\data\\runtime\\node-v24.20.0\\node.exe'),
    makeToolProvisioner: fakeTool({
      git: { binary: 'C:\\data\\runtime\\git-v2.56.0\\cmd\\git.exe', binDir: 'C:\\data\\runtime\\git-v2.56.0\\cmd' },
      gh: { binary: 'gh', binDir: null }, // system gh — nothing to add
    }),
    onProgress: (e) => events.push(e),
  });
  assert.equal(result.nodeBin, 'C:\\data\\runtime\\node-v24.20.0\\node.exe');
  assert.deepEqual(result.binDirs, [
    'C:\\data\\runtime\\node-v24.20.0',
    'C:\\data\\runtime\\git-v2.56.0\\cmd',
  ]);
  assert.ok(events.some((e) => e.tool === 'node'));
  assert.ok(events.some((e) => e.tool === 'git'));
  assert.ok(events.some((e) => e.tool === 'gh'));
});

test('a failing best-effort tool never blocks startup', async () => {
  const logs = [];
  const result = await provisionDependencies({
    platform: 'darwin', arch: 'arm64', env: {}, runtimeDir: '/data/runtime', pathImpl: path.posix,
    makeNodeProvisioner: fakeNode('/data/runtime/node-v24.20.0/bin/node'),
    makeToolProvisioner: fakeTool({ git: null, gh: new Error('network down') }),
    log: (m) => logs.push(m),
  });
  assert.equal(result.nodeBin, '/data/runtime/node-v24.20.0/bin/node');
  assert.deepEqual(result.binDirs, ['/data/runtime/node-v24.20.0/bin']);
  assert.ok(logs.some((m) => /GitHub CLI provisioning failed/.test(m)));
});

test('a system Node (bare command) contributes no bin dir', async () => {
  const result = await provisionDependencies({
    platform: 'linux', arch: 'x64', env: {}, runtimeDir: '/data/runtime', pathImpl: path.posix,
    makeNodeProvisioner: fakeNode('node'),
    makeToolProvisioner: fakeTool({ git: null, gh: null }),
  });
  assert.deepEqual(result.binDirs, []);
});

test('prependToPath adds new dirs in front, de-duped and case-insensitive on reuse', () => {
  const combined = prependToPath(
    ['C:\\new\\bin', 'C:\\existing\\bin'],
    'C:\\Existing\\bin;C:\\windows\\system32',
    'win32',
  );
  assert.equal(combined, 'C:\\new\\bin;C:\\Existing\\bin;C:\\windows\\system32');
});

test('prependToPath uses the posix delimiter off Windows', () => {
  assert.equal(
    prependToPath(['/opt/a/bin', '/opt/b/bin'], '/usr/bin:/bin', 'linux'),
    '/opt/a/bin:/opt/b/bin:/usr/bin:/bin',
  );
});

test('prependToPath tolerates an empty current PATH', () => {
  assert.equal(prependToPath([path.join('x', 'bin')], undefined, 'linux'), path.join('x', 'bin'));
});

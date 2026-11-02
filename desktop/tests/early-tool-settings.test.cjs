'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { readEarlyToolSettings } = require('../early-tool-settings.cjs');

function files(values) {
  return { readFileSync(file) {
    const namespace = path.basename(file, '.json');
    if (!(namespace in values)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return JSON.stringify({ namespace, data: values[namespace] });
  } };
}
test('reads the backend module records before provisioning without a competing desktop Git setting', () => {
  const env = { PATH: 'base' };
  const result = readEarlyToolSettings('data', env, files({
    git: { executable: 'C:\\my git\\git.exe' }, githubCli: { executable: 'C:\\my gh\\gh.exe' },
    desktopRuntime: { nodeExecutable: 'C:\\node\\node.exe' },
  }));
  assert.equal(result.env.CW_GIT_BIN, 'C:\\my git\\git.exe');
  assert.equal(result.env.CW_GH_BIN, 'C:\\my gh\\gh.exe');
  assert.equal(result.env.CW_NODE_BIN, 'C:\\node\\node.exe');
  assert.equal(result.nodeOverride, '');
  assert.deepEqual(env, { PATH: 'base' });
});
test('legacy environment overrides retain precedence; namespaced env beats persisted settings', () => {
  const noRead = { readFileSync() { throw new Error('must not read lower precedence'); } };
  const env = { CW_GIT_BIN: 'g', CW_GH_BIN: 'h', CW_NODE_BIN: 'n' };
  assert.deepEqual(readEarlyToolSettings('data', env, noRead).env, env);
  assert.equal(readEarlyToolSettings('data', { CW__git__executable: 'g', CW__githubCli__executable: 'h', CW__desktopRuntime__nodeExecutable: 'n' }, noRead).env.CW_NODE_BIN, 'n');
});
test('missing/default records preserve automatic managed provisioning', () => {
  assert.deepEqual(readEarlyToolSettings('data', {}, files({})), { nodeOverride: '', env: {} });
  assert.deepEqual(readEarlyToolSettings('data', {}, files({ git: { executable: 'git' }, githubCli: { executable: 'gh' }, desktopRuntime: { nodeExecutable: '' } })).env, {});
});
test('malformed or unreadable records fail clearly instead of discarding a saved override', () => {
  for (const fs of [
    { readFileSync() { return 'bad'; } },
    files({ desktopRuntime: { nodeExecutable: 'bad\npath' } }),
    { readFileSync() { throw new Error('denied'); } },
    files({ desktopRuntime: { nodeExecutable: null } }),
  ]) assert.throws(() => readEarlyToolSettings('data', {}, fs), /Could not read/);
});
test('empty and unrelated override patches preserve module defaults before provisioning', () => {
  for (const data of [{}, { unrelated: 'ignored' }]) {
    assert.deepEqual(readEarlyToolSettings('data', {}, files({
      git: data, githubCli: data, desktopRuntime: data,
    })), { nodeOverride: '', env: {} });
  }
  const result = readEarlyToolSettings('data', {}, files({
    git: { unrelated: true, executable: 'custom-git' },
    githubCli: { unrelated: true },
    desktopRuntime: {},
  }));
  assert.equal(result.env.CW_GIT_BIN, 'custom-git');
  assert.equal(result.env.CW_GH_BIN, undefined);
  assert.equal(result.env.CW_NODE_BIN, undefined);
});
test('present executable overrides still reject wrong types and control characters', () => {
  for (const [namespace, key] of [['git', 'executable'], ['githubCli', 'executable'], ['desktopRuntime', 'nodeExecutable']]) {
    for (const value of [null, false, 42, [], {}, 'bad\npath', '\0']) {
      assert.throws(() => readEarlyToolSettings('data', {}, files({
        [namespace]: { [key]: value },
      })), new RegExp(`Could not read ${namespace} executable settings`));
    }
  }
});
test('a relaunched desktop does not turn its managed runtime into a user override', () => {
  const env = { CW_NODE_BIN: 'old-managed-node', CW_NODE_BIN_OVERRIDE: '' };
  assert.equal(readEarlyToolSettings('data', env, files({ desktopRuntime: { nodeExecutable: 'new-selected-node' } })).env.CW_NODE_BIN, 'new-selected-node');
  assert.equal(readEarlyToolSettings('data', env, files({})).env.CW_NODE_BIN, undefined);
  assert.equal(readEarlyToolSettings('data', { ...env, CW_NODE_BIN_OVERRIDE: 'original-override' }, files({})).nodeOverride, 'original-override');
  assert.equal(env.CW_NODE_BIN, 'old-managed-node');
  const first = readEarlyToolSettings('data', {}, files({ desktopRuntime: { nodeExecutable: 'saved-A' } }));
  const relaunched = { CW_NODE_BIN: 'saved-A', CW_NODE_BIN_OVERRIDE: first.nodeOverride };
  assert.equal(readEarlyToolSettings('data', relaunched, files({ desktopRuntime: { nodeExecutable: 'saved-B' } })).env.CW_NODE_BIN, 'saved-B');
});

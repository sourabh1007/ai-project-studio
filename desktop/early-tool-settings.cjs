'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Reads the same per-module records edited by the backend, before provisioning. */
function readEarlyToolSettings(dataDir, env = process.env, fsImpl = fs) {
  function value(namespace, key) {
    try {
      const record = JSON.parse(fsImpl.readFileSync(path.join(dataDir, 'config-overrides', `${namespace}.json`), 'utf8'));
      if (record.namespace !== namespace || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) {
        throw new Error('Invalid executable override');
      }
      const result = record.data[key];
      if (result === undefined) return '';
      if (typeof result !== 'string' || /[\u0000-\u001f]/.test(result)) {
        throw new Error('Invalid executable override');
      }
      return result.trim();
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw new Error(`Could not read ${namespace} executable settings`, { cause: error });
    }
  }
  // Relaunch inherits the resolved runtime, not a new user override.
  const inheritedNode = env.CW_NODE_BIN_OVERRIDE ?? env.CW_NODE_BIN;
  const node = inheritedNode || env.CW__desktopRuntime__nodeExecutable || value('desktopRuntime', 'nodeExecutable');
  const git = env.CW_GIT_BIN || env.CW__git__executable || value('git', 'executable');
  const gh = env.CW_GH_BIN || env.CW__githubCli__executable || value('githubCli', 'executable');
  const provisioningEnv = { ...env };
  if (!inheritedNode) delete provisioningEnv.CW_NODE_BIN;
  return {
    nodeOverride: inheritedNode || '',
    env: {
      ...provisioningEnv,
      ...(node ? { CW_NODE_BIN: node } : {}),
      ...(git && git !== 'git' ? { CW_GIT_BIN: git } : {}),
      ...(gh && gh !== 'gh' ? { CW_GH_BIN: gh } : {}),
    },
  };
}

module.exports = { readEarlyToolSettings };

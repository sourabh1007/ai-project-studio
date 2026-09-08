'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL = 'desktop-smoke-v1';

/** An explicit test-only launch, never a configuration of a user's workspace. */
function configure(app, env = process.env, cwd = process.cwd()) {
  if (!env.CW_DESKTOP_SMOKE_ROOT) return null;
  const root = path.resolve(env.CW_DESKTOP_SMOKE_ROOT);
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
  if (marker.protocol !== PROTOCOL || marker.token !== env.CW_DESKTOP_SMOKE_TOKEN ||
      !/^[a-f0-9]{32}$/.test(marker.token) ||
      path.resolve(cwd) !== path.join(root, 'work') ||
      !path.isAbsolute(env.CW_NODE_BIN || '') ||
      env.CW_DESKTOP_DEV || env.NODE_OPTIONS || env.ELECTRON_RUN_AS_NODE) {
    throw new Error('Invalid isolated desktop smoke launch');
  }
  for (const [key, relative] of Object.entries({
    HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata',
    XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data',
  })) {
    if (env[key] !== path.join(root, relative)) throw new Error(`Unsafe smoke ${key}`);
  }
  const profile = path.join(root, 'profile');
  for (const file of ['regression-backend.cjs', 'regression-isolation.cjs']) {
    if (!fs.readFileSync(path.join(root, file)).equals(fs.readFileSync(path.join(__dirname, file)))) {
      throw new Error('Synthetic backend does not match packaged fixture');
    }
  }
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  // A crashed test controller cannot leave a desktop fixture running indefinitely.
  const watchdog = setTimeout(() => app.quit(), 90_000);
  watchdog.unref();
  return {
    root,
    backendEntry: path.join(root, 'regression-backend.cjs'),
    updater: Object.freeze({
      init() {},
      getState: () => ({ status: 'idle', canAutoInstall: false }),
      checkForUpdates: async () => null,
      downloadUpdate: async () => null,
      installNow() {},
    }),
  };
}

module.exports = { PROTOCOL, configure };

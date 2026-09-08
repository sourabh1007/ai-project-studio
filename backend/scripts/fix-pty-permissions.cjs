'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fixPtyPermissions({ platform = process.platform, arch = process.arch, packageDir } = {}) {
  if (platform !== 'darwin') return;
  const root = packageDir ?? path.dirname(require.resolve('node-pty/package.json'));
  const directories = ['build/Release', 'build/Debug', `prebuilds/darwin-${arch}`];
  let helpers = 0;
  for (const directory of directories) {
    const helper = path.join(root, directory, 'spawn-helper');
    const stat = fs.lstatSync(helper, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile()) throw new Error(`node-pty spawn helper is not a regular file: ${helper}`);
    // node-pty 1.1.0 publishes macOS helpers as 0644, which makes posix_spawnp fail.
    fs.chmodSync(helper, (stat.mode & 0o777) | 0o111);
    helpers++;
  }
  if (helpers === 0) throw new Error('No macOS node-pty spawn helper was installed.');
}

module.exports = { fixPtyPermissions };
if (require.main === module) fixPtyPermissions();

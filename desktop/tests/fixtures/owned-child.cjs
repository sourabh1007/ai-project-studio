'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

if (!process.env.CW_DESKTOP_SMOKE_ROOT) throw new Error('Synthetic profile required');
if (process.argv.includes('--leaf')) {
  setTimeout(() => {}, 60_000);
} else {
  const child = spawn(process.execPath, [__filename, '--leaf'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(process.env.CW_DESKTOP_SMOKE_ROOT, 'owned.json'), JSON.stringify({
    parent: process.pid, descendant: child.pid, arguments: process.argv.slice(2),
  }));
  process.stderr.write('synthetic stderr forwarded\n');
  if (process.argv.includes('--exit-parent')) {
    child.unref();
    process.exitCode = 42;
  } else {
    setTimeout(() => {}, 60_000);
  }
}

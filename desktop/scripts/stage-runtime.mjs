// Stages the built backend and UI into desktop/build/ so electron-builder can
// ship them as extraResources. The backend runs as a spawned Node process (it
// relies on the `node:sqlite` builtin, unavailable in Electron's bundled Node),
// so its compiled output and package manifest are copied here; production
// dependencies are installed from the unchanged workspace lockfile via npm ci.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = dirname(here);

export function stageRuntime(rootDir, buildDir) {
  const rootManifest = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const lockBytes = readFileSync(join(rootDir, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) {
    throw new Error('Packaging requires the committed npm v3 workspace lockfile.');
  }
  const workspaces = rootManifest.workspaces;
  if (!Array.isArray(workspaces) || !workspaces.includes('backend')) {
    throw new Error('Packaging requires an explicit backend workspace.');
  }
  const manifests = workspaces.map((workspace) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(workspace) || !lock.packages[workspace]) {
      throw new Error(`Unsupported or unlocked packaging workspace: ${workspace}`);
    }
    return [workspace, readFileSync(join(rootDir, workspace, 'package.json'))];
  });
  const ptyInstallScript = readFileSync(join(rootDir, 'backend', 'scripts', 'fix-pty-permissions.cjs'));

  rmSync(buildDir, { recursive: true, force: true });
  const runtimeDir = join(buildDir, 'backend');
  mkdirSync(runtimeDir, { recursive: true });
  // Keep npm's original workspace layout and lock graph. Compiled backend code
  // retains its existing dist/main.js location and ESM semantics.
  writeFileSync(join(runtimeDir, 'package.json'), `${JSON.stringify({ ...rootManifest, type: 'module' }, null, 2)}\n`);
  writeFileSync(join(runtimeDir, 'package-lock.json'), lockBytes);
  for (const [workspace, manifest] of manifests) {
    mkdirSync(join(runtimeDir, workspace), { recursive: true });
    writeFileSync(join(runtimeDir, workspace, 'package.json'), manifest);
  }
  mkdirSync(join(runtimeDir, 'backend', 'scripts'), { recursive: true });
  writeFileSync(join(runtimeDir, 'backend', 'scripts', 'fix-pty-permissions.cjs'), ptyInstallScript);
  cpSync(join(rootDir, 'backend', 'dist'), join(runtimeDir, 'dist'), { recursive: true });
  cpSync(join(rootDir, 'ui', 'dist'), join(buildDir, 'ui'), { recursive: true });

  mkdirSync(join(buildDir, 'docs'), { recursive: true });
  cpSync(join(rootDir, 'docs'), join(buildDir, 'docs'), { recursive: true });
  cpSync(join(rootDir, 'README.md'), join(buildDir, 'docs', 'README.md'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const buildDir = join(desktopDir, 'build');
  stageRuntime(dirname(desktopDir), buildDir);
  console.log(`Staged backend + UI runtime into ${buildDir}`);
}

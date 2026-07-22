// Stages the built backend and UI into desktop/build/ so electron-builder can
// ship them as extraResources. The backend runs as a spawned Node process (it
// relies on the `node:sqlite` builtin, unavailable in Electron's bundled Node),
// so its compiled output and package manifest are copied here; production
// dependencies are installed by the release workflow via `npm install`.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = dirname(here);
const rootDir = dirname(desktopDir);
const buildDir = join(desktopDir, 'build');

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(join(buildDir, 'backend'), { recursive: true });

cpSync(join(rootDir, 'backend', 'dist'), join(buildDir, 'backend', 'dist'), {
  recursive: true,
});
cpSync(
  join(rootDir, 'backend', 'package.json'),
  join(buildDir, 'backend', 'package.json'),
);
cpSync(join(rootDir, 'ui', 'dist'), join(buildDir, 'ui', 'dist'), {
  recursive: true,
});

// eslint-disable-next-line no-console
console.log(`Staged backend + UI runtime into ${buildDir}`);

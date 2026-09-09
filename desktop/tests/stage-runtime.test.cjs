const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, contents) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof contents === 'string' ? contents : JSON.stringify(contents));
  };
  const manifest = { name: 'fixture', version: '1.0.0', private: true, workspaces: ['backend', 'ui', 'desktop'] };
  write('package.json', manifest);
  const lock = { name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': manifest } };
  for (const workspace of manifest.workspaces) {
    const entry = { name: `@fixture/${workspace}`, version: '1.0.0' };
    write(path.join(workspace, 'package.json'), entry);
    lock.packages[workspace] = entry;
    lock.packages[`node_modules/@fixture/${workspace}`] = { resolved: workspace, link: true };
  }
  write('package-lock.json', lock);
  write(path.join('backend', 'dist', 'main.js'), 'export const ready = true;\n');
  write(path.join('backend', 'scripts', 'fix-pty-permissions.cjs'), 'module.exports = {};\n');
  write(path.join('ui', 'dist', 'index.html'), '<html>fixture</html>');
  write(path.join('docs', 'guide.md'), 'fixture docs');
  write('README.md', 'fixture readme');
  const { stageRuntime } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'stage-runtime.mjs')));
  const build = path.join(root, 'staged');
  return { root, build, write, manifest, lock, stage: () => stageRuntime(root, build) };
}

test('staging preserves the exact lock graph and all workspace manifests with runnable ESM output', async (t) => {
  const f = await fixture(t);
  f.stage();
  const runtime = path.join(f.build, 'backend');
  assert.deepEqual(fs.readFileSync(path.join(runtime, 'package-lock.json')), fs.readFileSync(path.join(f.root, 'package-lock.json')));
  for (const workspace of f.manifest.workspaces) {
    assert.deepEqual(fs.readFileSync(path.join(runtime, workspace, 'package.json')), fs.readFileSync(path.join(f.root, workspace, 'package.json')));
  }
  assert.deepEqual(
    fs.readFileSync(path.join(runtime, 'backend', 'scripts', 'fix-pty-permissions.cjs')),
    fs.readFileSync(path.join(f.root, 'backend', 'scripts', 'fix-pty-permissions.cjs')),
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'))), { ...f.manifest, type: 'module' });
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', "import { ready } from './dist/main.js'; if (!ready) process.exit(1)"], { cwd: runtime, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(path.join(f.build, 'ui', 'index.html'), 'utf8'), '<html>fixture</html>');
  assert.equal(fs.readFileSync(path.join(f.build, 'docs', 'README.md'), 'utf8'), 'fixture readme');
});

test('invalid or missing lock graph fails before removing existing staged artifacts', async (t) => {
  for (const invalid of ['old-lock', 'missing-workspace', 'unsafe-workspace', 'no-backend', 'missing-lock', 'missing-install-script']) {
    await t.test(invalid, async (t) => {
      const f = await fixture(t);
      f.stage();
      if (invalid === 'old-lock') f.lock.lockfileVersion = 2;
      if (invalid === 'missing-workspace') delete f.lock.packages.ui;
      if (invalid === 'unsafe-workspace') f.manifest.workspaces.push('../outside');
      if (invalid === 'no-backend') f.manifest.workspaces = ['ui'];
      f.write('package-lock.json', f.lock);
      f.write('package.json', f.manifest);
      if (invalid === 'missing-lock') fs.rmSync(path.join(f.root, 'package-lock.json'));
      if (invalid === 'missing-install-script') fs.rmSync(path.join(f.root, 'backend', 'scripts', 'fix-pty-permissions.cjs'));
      assert.throws(f.stage);
      assert.equal(fs.readFileSync(path.join(f.build, 'backend', 'dist', 'main.js'), 'utf8'), 'export const ready = true;\n');
    });

  }
});

test('release installs only the backend production workspace using the frozen lockfile', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /working-directory: desktop\/build\/backend\s+run: npm ci --omit=dev --workspace backend --include-workspace-root=false/);
  assert.doesNotMatch(workflow, /npm install --omit=dev/);
});

// Regression for the published v0.11.0 defect: electron-builder's extraResources
// copy filter unconditionally drops a directory literally named "node_modules"
// sitting at the *root* of a `from` path (app-builder-lib's createFilter treats
// it as an app-level node_modules it manages separately, not a payload to ship
// verbatim). `npm ci --workspace backend --include-workspace-root=false` hoists
// the backend's production dependencies to build/backend/node_modules, so an
// extraResources entry with `from: build/backend` silently shipped a backend
// with zero dependencies — it started, then crashed with ERR_MODULE_NOT_FOUND
// for every real import (express, zod, ws, ...). Prove the fix using
// electron-builder's actual filter, not a re-implementation of its logic.
test('the packaged extraResources mapping does not drop the backend production node_modules', async (t) => {
  const f = await fixture(t);
  f.stage();
  // Simulate what `npm ci --workspace backend --include-workspace-root=false`
  // does from desktop/build/backend: it hoists production dependencies to a
  // node_modules directory at that same root, alongside the staged manifests
  // and dist/ output stageRuntime() already wrote there.
  f.write(path.join('staged', 'backend', 'node_modules', 'express', 'package.json'), '{"name":"express"}');

  const { createFilter } = require(path.join(__dirname, '..', '..', 'node_modules', 'app-builder-lib', 'out', 'util', 'filter.js'));
  const { Minimatch } = require(path.join(__dirname, '..', '..', 'node_modules', 'minimatch'));
  const allPattern = [new Minimatch('**/*', { dot: true })];
  const survives = (src, file) => createFilter(src, allPattern, null)(file, { isDirectory: () => fs.statSync(file).isDirectory() });
  const nodeModulesDir = path.join(f.build, 'backend', 'node_modules');

  // electron-builder's copier calls the filter on each directory as it walks
  // the tree; a directory rejected here is never descended into, regardless
  // of whether the files inside it would individually match. Sanity check:
  // the pre-fix mapping (`from: build/backend, to: backend`) reproduces the
  // published defect — node_modules sits directly under the `from` root,
  // which electron-builder's filter always drops.
  assert.equal(survives(path.join(f.build, 'backend'), nodeModulesDir), false,
    'the pre-fix from:build/backend mapping must reproduce the dropped-dependency defect');

  // The fixed mapping (`from: build, to: .`) copies node_modules nested one
  // level deeper (backend/node_modules relative to `from`), which the filter
  // does not match.
  assert.equal(survives(f.build, nodeModulesDir), true,
    'the fixed from:build mapping must ship backend/node_modules');

  const builder = require('js-yaml').load(fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8'));
  assert.deepEqual(builder.extraResources, [{ from: 'build', to: '.' }]);
});

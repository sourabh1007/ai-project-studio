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
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'))), { ...f.manifest, type: 'module' });
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', "import { ready } from './dist/main.js'; if (!ready) process.exit(1)"], { cwd: runtime, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(path.join(f.build, 'ui', 'index.html'), 'utf8'), '<html>fixture</html>');
  assert.equal(fs.readFileSync(path.join(f.build, 'docs', 'README.md'), 'utf8'), 'fixture readme');
});

test('invalid or missing lock graph fails before removing existing staged artifacts', async (t) => {
  for (const invalid of ['old-lock', 'missing-workspace', 'unsafe-workspace', 'no-backend', 'missing-lock']) {
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

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { writeCandidateManifest } = require('../scripts/release-candidate.cjs');
const { resolvePowerShell } = require('../scripts/smoke-helpers.cjs');

function fixture(t, platform = 'win32') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-candidate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const releaseDir = path.join(root, 'desktop', 'release');
  const stagedDir = path.join(root, 'desktop', 'build', 'backend');
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(stagedDir, { recursive: true });
  const lock = '{"lockfileVersion":3,"packages":{}}\n';
  fs.writeFileSync(path.join(root, 'package-lock.json'), lock);
  fs.writeFileSync(path.join(stagedDir, 'package-lock.json'), lock);
  fs.writeFileSync(path.join(root, 'desktop', 'package.json'), '{"version":"1.2.3"}');
  const installer = platform === 'win32' ? 'candidate.exe' : 'candidate.dmg';
  fs.writeFileSync(path.join(releaseDir, installer), 'installer fixture');
  fs.writeFileSync(path.join(releaseDir, 'latest.yml'), 'feed fixture');
  fs.writeFileSync(path.join(releaseDir, 'ignored.log'), 'not a release artifact');
  const options = { root, platform, sourceSha: 'a'.repeat(40), runId: '123', runAttempt: '2' };
  return { root, releaseDir, stagedDir, installer, options };
}

for (const platform of ['win32', 'darwin']) {
  test(`records exact ${platform} bytes without claiming release or signature qualification`, async (t) => {
    const f = fixture(t, platform);
    const { output, manifest } = await writeCandidateManifest(f.options);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), manifest);
    assert.equal(manifest.channel, 'internal');
    assert.equal(manifest.qualification, 'pending');
    assert.equal(manifest.signatureVerification, 'pending');
    assert.equal(manifest.packagedRuntimeVerification, 'pending');
    assert.equal(manifest.platform, platform);
    assert.equal(manifest.sourceSha, f.options.sourceSha);
    assert.deepEqual(manifest.ci, { runId: '123', runAttempt: '2' });
    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.buildRuntime.node, process.version);
    assert.equal(manifest.buildRuntime.nodeModuleAbi, process.versions.modules);
    assert.equal(manifest.artifacts.length, 2);
    for (const artifact of manifest.artifacts) {
      const bytes = fs.readFileSync(path.join(f.releaseDir, artifact.name));
      assert.equal(artifact.bytes, bytes.length);
      assert.equal(artifact.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    }
    const lock = fs.readFileSync(path.join(f.root, 'package-lock.json'));
    assert.equal(manifest.lockSha256, crypto.createHash('sha256').update(lock).digest('hex'));
    assert.deepEqual((await writeCandidateManifest(f.options)).manifest, manifest);
    fs.appendFileSync(path.join(f.releaseDir, f.installer), ' changed');
    const changed = await writeCandidateManifest(f.options);
    assert.notEqual(changed.manifest.artifacts[0].sha256, manifest.artifacts[0].sha256);
  });
}

test('refuses incomplete CI identity or an unsupported platform', async (t) => {
  const f = fixture(t);
  for (const invalid of [
    { platform: 'linux' }, { sourceSha: 'main' }, { sourceSha: undefined },
    { runId: '' }, { runId: '0' }, { runAttempt: '-1' }, { runAttempt: undefined },
  ]) {
    await assert.rejects(writeCandidateManifest({ ...f.options, ...invalid }), /requires/);
  }
  assert.equal(fs.existsSync(path.join(f.releaseDir, 'candidate-win32.json')), false);
});

test('refuses a changed staged lock before emitting provenance', async (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.stagedDir, 'package-lock.json'), ' ');
  await assert.rejects(writeCandidateManifest(f.options), /lock differs/);
  assert.equal(fs.existsSync(path.join(f.releaseDir, 'candidate-win32.json')), false);
});

test('refuses missing, empty, or non-file installers', async (t) => {
  const f = fixture(t);
  const installer = path.join(f.releaseDir, f.installer);
  fs.rmSync(installer);
  await assert.rejects(writeCandidateManifest(f.options), /no installer/);
  fs.writeFileSync(installer, '');
  await assert.rejects(writeCandidateManifest(f.options), /nonempty regular file/);
  fs.rmSync(installer);
  fs.mkdirSync(installer);
  await assert.rejects(writeCandidateManifest(f.options), /nonempty regular file/);
  assert.equal(fs.existsSync(path.join(f.releaseDir, 'candidate-win32.json')), false);
});

test('release workflow gates prereleases without publishing stable updates', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(workflow, /needs: verify/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /run: node desktop\/scripts\/release-candidate\.cjs/);
  assert.match(workflow, /desktop\/release\/candidate-\*\.json/);
  assert.match(workflow, /Incomplete Azure Trusted Signing configuration/);
  assert.match(workflow, /contents: read/);
  const parsed = yaml.load(workflow);
  for (const job of [parsed.jobs.verify, parsed.jobs.build]) {
    const setup = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    assert.equal(setup.uses, 'actions/setup-node@v6');
    assert.equal(setup.with['node-version'], '24.20.0');
  }
  assert.deepEqual(parsed.permissions, { contents: 'read' });
  assert.doesNotMatch(JSON.stringify(parsed.jobs.build), /contents: write|gh release|--publish always/);
  const publish = parsed.jobs['publish-prerelease'];
  assert.equal(publish.needs, 'build');
  assert.equal(publish.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
  assert.deepEqual(publish.permissions, { contents: 'write' });
  assert.equal(publish.steps.find((step) => step.uses?.startsWith('actions/download-artifact@')).with['merge-multiple'], false);
  assert.equal(publish.steps.find((step) => step.uses?.startsWith('actions/download-artifact@')).uses, 'actions/download-artifact@v7');
  const script = publish.steps.find((step) => step.run).run;
  assert.match(script, /gh release create .*--verify-tag --draft --prerelease/);
  assert.match(script, /gh release edit .*--draft=false --prerelease --latest=false/);
  assert.match(script, /manifest\.sourceSha !== process\.env\.GITHUB_SHA/);
  assert.match(script, /digest\('hex'\) !== artifact\.sha256/);
  const upload = script.split('\n').find((line) => line.includes('gh release upload'));
  assert.match(upload, /artifacts\/\*\/\*\.exe artifacts\/\*\/\*\.dmg artifacts\/\*\/candidate-\*\.json/);
  assert.doesNotMatch(upload, /\.yml|\.blockmap/);
  const root = path.join(__dirname, '..', '..');
  const config = yaml.load(fs.readFileSync(path.join(root, 'desktop', 'electron-builder.yml'), 'utf8'));
  assert.equal(config.publish[0].releaseType, 'draft');
  const desktop = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
  assert.match(desktop.scripts['dist:win'], /--publish never$/);
  assert.match(desktop.scripts['dist:mac'], /--publish never$/);
});

test('publication verifies both platforms independently even when diagnostic filenames collide', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}');
  for (const [platform, label] of [['win32', 'Windows'], ['darwin', 'macOS']]) {
    const f = fixture(t, platform);
    fs.writeFileSync(path.join(f.releaseDir, 'builder-debug.yml'), `${platform} build configuration`);
    await writeCandidateManifest(f.options);
    fs.cpSync(f.releaseDir, path.join(root, 'artifacts', `ai-project-studio-${label}`), { recursive: true });
  }
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8'));
  const run = workflow.jobs['publish-prerelease'].steps.find((step) => step.run).run;
  const verification = run.match(/node <<'NODE'\r?\n([\s\S]*?)\r?\nNODE/)[1];
  const verify = () => spawnSync(process.execPath, ['-e', verification], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2', GITHUB_REF_NAME: 'v1.2.3',
    },
  });
  const valid = verify();
  assert.equal(valid.status, 0, valid.stderr);
  for (const [platform, label] of [['win32', 'Windows'], ['darwin', 'macOS']]) {
    const diagnostic = path.join(root, 'artifacts', `ai-project-studio-${label}`, 'builder-debug.yml');
    fs.writeFileSync(diagnostic, 'changed bytes');
    const changed = verify();
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /Release artifact mismatch: builder-debug\.yml/);
    fs.writeFileSync(diagnostic, `${platform} build configuration`);
  }
});

test('Windows candidate build rejects partial signing without invoking the builder', {
  skip: process.platform !== 'win32',
}, () => {
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8'));
  const step = workflow.jobs.build.steps.find((entry) => entry.name === 'Build Windows installer (Azure Trusted Signing)');
  const keys = [
    'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET',
    'AZURE_CODE_SIGNING_ENDPOINT', 'AZURE_CODE_SIGNING_ACCOUNT', 'AZURE_CODE_SIGNING_PROFILE',
  ];
  // GitHub Actions runs `run:` steps on windows-latest with PowerShell 7, so
  // exercise the step under the same host. Legacy powershell.exe also has a
  // .NET Framework cold start that can exceed a short deadline on a loaded
  // runner, which previously failed this gate spuriously.
  const powershell = resolvePowerShell();
  for (const configured of [[], [keys[3]], keys.slice(0, 3), keys]) {
    const env = { ...process.env };
    for (const key of keys) env[key] = configured.includes(key) ? 'fixture' : '';
    const result = spawnSync(powershell, [
      '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'\nfunction npm { Write-Output ('BUILDER:' + ($args -join '|')) }\n${step.run}`,
    ], { env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    assert.ifError(result.error);
    if (configured.length > 0 && configured.length < keys.length) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Incomplete Azure Trusted Signing configuration/);
      assert.doesNotMatch(result.stdout, /BUILDER:/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /BUILDER:run\|dist:win(?:\||\r?\n)/);
      if (configured.length === keys.length) {
        assert.match(result.stdout, /-c\.win\.azureSignOptions\.endpoint=fixture/);
      } else {
        assert.match(result.stdout, /UNSIGNED INTERNAL candidate/);
        assert.doesNotMatch(result.stdout, /-c\.win\.azureSignOptions/);
      }
    }
  }
});

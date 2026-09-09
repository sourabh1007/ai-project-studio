'use strict';

// Packaging drift gate.
//
// A desktop module has to be listed in four independent places before an
// installed shell can use it: electron-builder's `files:`, the asar integrity
// list in inspectPackage, the smoke fixture staging copy, and the asar input
// list in smoke.test.cjs. Nothing checked that those four agreed with what
// main.cjs actually requires, so a new module could pass every test in the repo
// and then crash on first launch of the installed app -- which is how the
// packaged-dependency and packaged-UI defects reached users in 0.11.1/0.11.2,
// and how backend-identity.cjs nearly shipped broken.
//
// This derives the requirement from the source itself rather than from another
// hand-maintained list, so the gate cannot drift the way the lists did.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const desktop = path.resolve(__dirname, '..');
const repo = path.resolve(desktop, '..');

/** Local `require('./x.cjs')` targets, including lazy in-function requires. */
function localRequires(file) {
  const source = fs.readFileSync(path.join(desktop, file), 'utf8');
  const found = new Set();
  for (const match of source.matchAll(/require\(\s*'\.\/([^']+)'\s*\)/g)) {
    found.add(match[1]);
  }
  return [...found];
}

/** Every local module reachable from the shell's real entry points. */
function reachableModules() {
  const entryPoints = ['main.cjs', 'preload.cjs'];
  const seen = new Set(entryPoints);
  const queue = [...entryPoints];
  while (queue.length > 0) {
    for (const dependency of localRequires(queue.pop())) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      queue.push(dependency);
    }
  }
  return [...seen].sort();
}

function packagedPatterns() {
  const config = fs.readFileSync(path.join(desktop, 'electron-builder.yml'), 'utf8');
  const block = /^files:\r?\n((?:[ \t]+-[^\n]*\r?\n)+)/m.exec(config);
  assert.ok(block, 'electron-builder.yml has no explicit files: list');
  return block[1]
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
}

function isPackaged(file, patterns) {
  return patterns.some((pattern) =>
    pattern === file ||
    (pattern.endsWith('/**/*') && file.startsWith(`${pattern.slice(0, -5)}/`)));
}

test('every module the shell actually requires is packaged', () => {
  const patterns = packagedPatterns();
  for (const module of reachableModules()) {
    assert.ok(
      isPackaged(module, patterns),
      `${module} is required at runtime but missing from electron-builder.yml files:. ` +
      'An installed shell would fail to launch.',
    );
  }
});

test('every packaged module exists on disk', () => {
  for (const pattern of packagedPatterns()) {
    if (pattern.includes('*')) continue;
    assert.ok(
      fs.existsSync(path.join(desktop, pattern)),
      `electron-builder.yml packages ${pattern}, which does not exist`,
    );
  }
});

test('the startup splash window ships with all of its own assets', () => {
  // The splash is the first thing a user sees; a missing asset here reads as
  // "the app did not start" with nothing else to go on.
  const patterns = packagedPatterns();
  for (const asset of fs.readdirSync(path.join(desktop, 'startup'))) {
    assert.ok(
      isPackaged(`startup/${asset}`, patterns),
      `startup/${asset} is not packaged`,
    );
  }
});

test('the asar integrity list and the packaged list do not drift apart', () => {
  const helpers = fs.readFileSync(
    path.join(desktop, 'scripts', 'smoke-helpers.cjs'), 'utf8');
  const patterns = packagedPatterns();
  const listed = [...helpers.matchAll(/'([\w-]+\.cjs)'/g)].map((m) => m[1]);
  assert.ok(listed.length > 0, 'smoke-helpers.cjs lists no modules to verify');
  for (const module of new Set(listed)) {
    assert.ok(
      isPackaged(module, patterns),
      `smoke-helpers.cjs verifies ${module}, which electron-builder does not package. ` +
      'The integrity check would fail every packaged launch.',
    );
  }
});

test('the smoke asar fixture stages everything its integrity check demands', () => {
  // Staging and verification are two separate lists in the same file. When they
  // disagree the failure surfaces as an unexplained "timed out waiting for
  // fixture readiness" rather than as a missing file.
  const smoke = fs.readFileSync(path.join(desktop, 'tests', 'smoke.test.cjs'), 'utf8');
  const helpers = fs.readFileSync(
    path.join(desktop, 'scripts', 'smoke-helpers.cjs'), 'utf8');
  const verified = new Set(
    [...helpers.matchAll(/'([\w-]+\.cjs)'/g)].map((m) => m[1]));
  const staged = new Set([...smoke.matchAll(/'([\w-]+\.cjs)'/g)].map((m) => m[1]));
  for (const module of verified) {
    assert.ok(
      staged.has(module),
      `smoke.test.cjs does not stage ${module} into the asar fixture, but ` +
      'inspectPackage requires it. The packaged smoke launch would never become ready.',
    );
  }
});

test('the desktop protocol version matches the backend that must answer it', () => {
  // main.cjs refuses a backend whose protocol version differs. If these two
  // constants drift, every launch fails the identity handshake -- including an
  // upgrade where only one side was rebuilt.
  const desktopSource = fs.readFileSync(path.join(desktop, 'backend-identity.cjs'), 'utf8');
  const backendSource = fs.readFileSync(
    path.join(repo, 'backend', 'src', 'api', 'identity-controller.ts'), 'utf8');
  const desktopVersion = /DESKTOP_PROTOCOL_VERSION\s*=\s*(\d+)/.exec(desktopSource);
  const backendVersion = /DESKTOP_PROTOCOL_VERSION\s*=\s*(\d+)/.exec(backendSource);
  assert.ok(desktopVersion, 'desktop declares no protocol version');
  assert.ok(backendVersion, 'backend declares no protocol version');
  assert.equal(desktopVersion[1], backendVersion[1]);
});

test('the packaged app version is the version the workspace builds', () => {
  // An installer that reports a different version than the backend it embeds
  // makes upgrade reports unreadable and breaks update comparisons.
  const read = (...segments) =>
    JSON.parse(fs.readFileSync(path.join(repo, ...segments), 'utf8')).version;
  const shell = read('desktop', 'package.json');
  assert.equal(shell, read('backend', 'package.json'));
  assert.equal(shell, read('ui', 'package.json'));
});

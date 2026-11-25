import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { resolveCopilotNativeCommand, resolveCopilotNpmNativeExecutable } from './copilot-native-command.js';

it('dispatches official npm Windows entry points without a shell or interpreting prompt arguments', () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-copilot-launch-'));
  try {
    const pkg = join(root, 'node_modules', '@github', 'copilot');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'loader.js'), '');
    const args = ['-p', 'Text with "quotes" & %variables% | <commands>', '--session-id', 'id'];
    for (const bin of ['loader.js', { copilot: 'loader.js' }]) {
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@github/copilot', bin }));
      expect(resolveCopilotNativeCommand({ command: join(root, 'copilot.cmd'), args })).toEqual({
        command: process.execPath, args: [join(pkg, 'loader.js'), ...args],
      });
    }
    for (const manifest of [
      'null', '42', '{"name":"@github/copilot"}', '{"name":"different","bin":"loader.js"}',
      '{"name":"@github/copilot","bin":false}', '{"name":"@github/copilot","bin":{}}',
      '{"name":"@github/copilot","bin":42}', '{"name":"@github/copilot","bin":"Z:\\\\outside.js"}',
      '{"name":"@github/copilot","bin":"../outside.js"}',
      '{"name":"@github/copilot","bin":"loader.exe"}',
      '{"name":"@github/copilot","bin":"missing.js"}', '{', ' '.repeat(65_537),
    ]) {
      writeFileSync(join(pkg, 'package.json'), manifest);
      expect(() => resolveCopilotNativeCommand({ command: join(root, 'copilot.cmd'), args })).toThrow('No shell command was executed');
    }
    expect(() => resolveCopilotNativeCommand({ command: join(root, 'absent', 'copilot.cmd'), args })).toThrow();
    expect(resolveCopilotNativeCommand({ command: join(root, 'native.exe'), args })).toEqual({ command: join(root, 'native.exe'), args });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('automatically selects the official native payload in nested and hoisted npm installations', () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-copilot-native-'));
  try {
    const shim = join(root, 'copilot.cmd');
    const pkg = join(root, 'node_modules', '@github', 'copilot');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(shim, '@echo off');
    for (const architecture of ['x64', 'arm64'] as const) {
      const name = `copilot-win32-${architecture}`;
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({
        name: '@github/copilot', bin: 'loader.js', optionalDependencies: { [`@github/${name}`]: '1.0.0' },
      }));
      writeFileSync(join(pkg, 'loader.js'), '');
      for (const scope of [join(pkg, 'node_modules', '@github'), join(root, 'node_modules', '@github')]) {
        const platform = join(scope, name);
        mkdirSync(platform, { recursive: true });
        const executable = join(platform, 'copilot.exe');
        writeFileSync(executable, 'native fixture');
        for (const bin of ['copilot.exe', { [name]: 'copilot.exe' }]) {
          writeFileSync(join(platform, 'package.json'), JSON.stringify({ name: `@github/${name}`, bin }));
          expect(resolveCopilotNpmNativeExecutable(shim, architecture)).toBe(executable);
          if (architecture === process.arch) {
            const args = ['-p', 'Multiline\n"quoted" & %PATH% | <text>'];
            expect(resolveCopilotNativeCommand({ command: shim, args })).toEqual({ command: executable, args });
          }
        }
        rmSync(platform, { recursive: true, force: true });
      }
    }
    expect(resolveCopilotNpmNativeExecutable(shim, 's390x')).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('does not execute unverified, missing, oversized or escaping npm platform entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-copilot-invalid-'));
  try {
    const shim = join(root, 'copilot.cmd');
    const pkg = join(root, 'node_modules', '@github', 'copilot');
    const name = 'copilot-win32-x64';
    const platform = join(pkg, 'node_modules', '@github', name);
    mkdirSync(platform, { recursive: true });
    for (const record of [
      { name: 'other', optionalDependencies: { [`@github/${name}`]: '1' } },
      { name: '@github/copilot' },
      { name: '@github/copilot', optionalDependencies: true },
      { name: '@github/copilot', optionalDependencies: {} },
      { name: '@github/copilot', optionalDependencies: { [`@github/${name}`]: false } },
    ]) {
      writeFileSync(join(pkg, 'package.json'), JSON.stringify(record));
      expect(resolveCopilotNpmNativeExecutable(shim, 'x64')).toBeNull();
    }
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
      name: '@github/copilot', optionalDependencies: { [`@github/${name}`]: '1' },
    }));
    for (const record of [
      { name: 'other', bin: 'copilot.exe' },
      { name: `@github/${name}` },
      { name: `@github/${name}`, bin: false },
      { name: `@github/${name}`, bin: {} },
      { name: `@github/${name}`, bin: { [name]: 1 } },
      { name: `@github/${name}`, bin: '../outside.exe' },
      { name: `@github/${name}`, bin: 'Z:\\outside.exe' },
      { name: `@github/${name}`, bin: 'loader.js' },
      { name: `@github/${name}`, bin: 'missing.exe' },
      { name: `@github/${name}`, bin: 'directory.exe' },
    ]) {
      mkdirSync(join(platform, 'directory.exe'), { recursive: true });
      writeFileSync(join(platform, 'package.json'), JSON.stringify(record));
      expect(resolveCopilotNpmNativeExecutable(shim, 'x64')).toBeNull();
    }
    for (const record of ['null', '{', ' '.repeat(65_537)]) {
      writeFileSync(join(platform, 'package.json'), record);
      expect(resolveCopilotNpmNativeExecutable(shim, 'x64')).toBeNull();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

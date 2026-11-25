import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveExecutable } from '../../terminal/executable-resolver.js';
import { ValidationError } from '../../kernel/error-types.js';
import type { Command } from './copilot-cmd-builder.js';

function readPackage(root: string): Record<string, unknown> {
  const manifest = join(root, 'package.json');
  if (statSync(manifest).size > 65_536) throw new Error('Oversized manifest');
  const value: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('Invalid manifest');
  return value as Record<string, unknown>;
}

/** Find npm's real platform binary, including nested and hoisted installations. */
export function resolveCopilotNpmNativeExecutable(shim: string, architecture = process.arch): string | null {
  if (!['x64', 'arm64'].includes(architecture)) return null;
  const root = join(dirname(shim), 'node_modules', '@github', 'copilot');
  const name = `copilot-win32-${architecture}`;
  try {
    const pkg = readPackage(root);
    const dependencies = pkg.optionalDependencies;
    if (pkg.name !== '@github/copilot' || !dependencies || typeof dependencies !== 'object' ||
      typeof (dependencies as Record<string, unknown>)[`@github/${name}`] !== 'string') return null;
    for (const directory of [join(root, 'node_modules', '@github', name), join(dirname(root), name)]) {
      try {
        const platform = readPackage(directory);
        const bin = platform.bin;
        const entry = typeof bin === 'string' ? bin
          : bin && typeof bin === 'object' ? (bin as Record<string, unknown>)[name] : null;
        if (platform.name !== `@github/${name}` || typeof entry !== 'string') continue;
        const executable = resolve(directory, entry);
        const local = relative(directory, executable);
        if (!local.startsWith('..') && !isAbsolute(local) && /\.exe$/i.test(executable) &&
          existsSync(executable) && statSync(executable).isFile()) return executable;
      } catch {
        // A missing nested dependency can still be present in npm's hoisted scope.
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Resolve npm's shim to its native payload or verified Node loader, never a shell. */
export function resolveCopilotNativeCommand(command: Command): Command {
  const executable = resolveExecutable(command.command);
  if (!/\.(?:cmd|bat)$/i.test(executable)) return { ...command, command: executable };
  const native = resolveCopilotNpmNativeExecutable(executable);
  if (native) return { ...command, command: native };
  const root = join(dirname(executable), 'node_modules', '@github', 'copilot');
  try {
    const record = readPackage(root);
    const entry = typeof record.bin === 'string' ? record.bin
      : record.bin && typeof record.bin === 'object' ? (record.bin as Record<string, unknown>).copilot : null;
    if (record.name !== '@github/copilot' || typeof entry !== 'string') throw new Error('Not a Copilot package');
    const script = resolve(root, entry);
    const local = relative(root, script);
    if (local.startsWith('..') || isAbsolute(local) || !/\.(?:cjs|mjs|js)$/i.test(script) || !existsSync(script)) {
      throw new Error('Invalid entry point');
    }
    return { command: process.execPath, args: [script, ...command.args] };
  } catch {
    throw new ValidationError('The configured Copilot Windows command shim has no verifiable npm entry point. Configure a native executable or reinstall the official @github/copilot package. No shell command was executed.');
  }
}

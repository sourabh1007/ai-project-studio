import { win32 } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveExecutable, type ResolveExecutableDeps } from '../terminal/executable-resolver.js';

/**
 * Do not wrap the app's explicit cmd launcher in a second shell. cmd /s /c
 * consumes an outer pair of quotes; libuv must not C-escape that command string.
 */
export function mcpInspectorLaunch(
  command: string,
  args: string[],
  platform: string,
  resolution: ResolveExecutableDeps = {},
): { command: string; args: string[]; shell: boolean; windowsVerbatimArguments?: boolean } {
  if (platform === 'win32' &&
      /^cmd(?:\.exe)?$/i.test(win32.basename(command)) &&
      args.length === 4 && args.slice(0, 3).map((arg) => arg.toLowerCase()).join(' ') === '/d /s /c') {
    const line = args[3];
    const quoted = line.startsWith('""') && line.endsWith('"') ? line : `"${line}"`;
    return { command, args: [...args.slice(0, 3), quoted], shell: false, windowsVerbatimArguments: true };
  }
  if (platform !== 'win32') return { command, args, shell: false };
  const resolved = resolveExecutable(command, { ...resolution, isWindows: true, pathExt: '.EXE;.COM;.CMD;.BAT' });
  const npmCommand = /^(npm|npx)(?:\.cmd)?$/i.exec(win32.basename(resolved));
  if (npmCommand) {
    const fileExists = resolution.fileExists ?? existsSync;
    const directory = win32.dirname(resolved);
    const script = win32.join(directory, 'node_modules', 'npm', 'bin', `${npmCommand[1]!.toLowerCase()}-cli.js`);
    const node = [win32.join(directory, 'node.exe'),
      resolveExecutable('node', { ...resolution, isWindows: true, pathExt: '.EXE' }), process.execPath]
      .find((candidate) => /\.exe$/i.test(candidate) && fileExists(candidate));
    if (node && fileExists(script)) {
      return { command: node, args: [script, ...args], shell: false };
    }
  }
  if (!/\.(?:exe|com)$/i.test(resolved)) {
    throw new Error('MCP stdio requires a native .exe/.com executable on Windows. Batch shims (.cmd/.bat) and unresolved commands are not executed implicitly; configure the underlying executable with structured arguments, or an explicit trusted cmd /d /s /c command.');
  }
  return { command: resolved, args, shell: false };
}

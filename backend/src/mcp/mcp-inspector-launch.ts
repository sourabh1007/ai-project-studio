import { win32 } from 'node:path';

/**
 * Do not wrap the app's explicit cmd launcher in a second shell. cmd /s /c
 * consumes an outer pair of quotes; libuv must not C-escape that command string.
 */
export function mcpInspectorLaunch(
  command: string,
  args: string[],
  platform: string,
): { command: string; args: string[]; shell: boolean; windowsVerbatimArguments?: boolean } {
  if (platform === 'win32' &&
      /^cmd(?:\.exe)?$/i.test(win32.basename(command)) &&
      args.length === 4 && args.slice(0, 3).map((arg) => arg.toLowerCase()).join(' ') === '/d /s /c') {
    const line = args[3];
    const quoted = line.startsWith('""') && line.endsWith('"') ? line : `"${line}"`;
    return { command, args: [...args.slice(0, 3), quoted], shell: false, windowsVerbatimArguments: true };
  }
  return {
    command, args,
    shell: platform === 'win32' && !/\.(?:exe|com)$/i.test(command),
  };
}

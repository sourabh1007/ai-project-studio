import { describe, expect, it } from 'vitest';
import { mcpInspectorLaunch } from './mcp-inspector-launch.js';

describe('MCP inspector Windows launch quoting', () => {
  it('preserves a single outer cmd quote pair without adding a second shell', () => {
    const line = '"C:\\Program Files\\nodejs\\node.exe" "C:\\app folder\\server.js"';
    expect(mcpInspectorLaunch('C:\\Windows\\System32\\CMD.EXE', ['/D', '/S', '/C', line], 'win32'))
      .toEqual({
        command: 'C:\\Windows\\System32\\CMD.EXE',
        args: ['/D', '/S', '/C', `"${line}"`],
        shell: false, windowsVerbatimArguments: true,
      });
    expect(mcpInspectorLaunch('cmd', ['/d', '/s', '/c', `"${line}"`], 'win32').args[3]).toBe(`"${line}"`);
  });
  it.each([
    ['node', ['server.js'], 'linux', false],
    ['C:\\Program Files\\nodejs\\node.exe', ['server.js'], 'win32', false],
    ['runner.COM', [], 'win32', false],
    ['npx', ['-y', 'server'], 'win32', true],
    ['npx.cmd', [], 'win32', true],
    ['cmd.exe', ['/c', 'echo fixture'], 'win32', false],
    ['cmd.exe', ['/d', '/q', '/c', 'echo fixture'], 'win32', false],
  ] as const)('keeps unrelated launch behavior for %s', (command, args, platform, shell) => {
    expect(mcpInspectorLaunch(command, [...args], platform)).toEqual({ command, args, shell });
  });
});

import { describe, expect, it } from 'vitest';
import { mcpInspectorLaunch } from './mcp-inspector-launch.js';

describe('MCP inspector Windows launch quoting', () => {
  it.each(['npx', 'npx.cmd', 'npm.cmd'])('launches verified npm entrypoints for %s without a batch shell', (command) => {
    const tool = command.startsWith('npx') ? 'npx' : 'npm';
    const directory = 'C:\\Program Files\\nodejs';
    const script = `${directory}\\node_modules\\npm\\bin\\${tool}-cli.js`;
    const paths = new Set([`${directory}\\${tool}.CMD`, `${directory}\\node.exe`, script]);
    const args = ['-y', '@azure/mcp', 'server', 'name with spaces', '&echo literal', '%PATH%', 'a"b'];
    expect(mcpInspectorLaunch(command, args, 'win32', { pathEnv: directory,
      fileExists: (path) => [...paths].some((existing) => existing.toLowerCase() === path.toLowerCase()) }))
      .toEqual({ command: `${directory}\\node.exe`, args: [script, ...args], shell: false });
  });
  it('uses native Node from PATH for a verified global npm entrypoint and fails closed for missing scripts/runtimes', () => {
    const script = 'C:\\npm\\node_modules\\npm\\bin\\npx-cli.js';
    const paths = new Set(['C:\\npm\\npx.CMD', 'C:\\node\\node.EXE', script]);
    const resolution = { pathEnv: 'C:\\npm;C:\\node', fileExists: (path: string) => paths.has(path) };
    expect(mcpInspectorLaunch('npx', ['@org/mcp'], 'win32', resolution))
      .toEqual({ command: 'C:\\node\\node.EXE', args: [script, '@org/mcp'], shell: false });
    paths.delete(script);
    expect(() => mcpInspectorLaunch('npx', [], 'win32', resolution)).toThrow('Batch shims');
    paths.add(script);
    paths.delete('C:\\node\\node.EXE');
    expect(() => mcpInspectorLaunch('npx', [], 'win32', resolution)).toThrow('Batch shims');
  });
  it('checks the real filesystem when no existence probe is injected and never guesses an npm entrypoint', () => {
    expect(() => mcpInspectorLaunch('C:\\studio-nonexistent-fixture\\npx.cmd', [], 'win32', { pathEnv: '' }))
      .toThrow('Batch shims');
  });
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
    ['cmd.exe', ['/c', 'echo fixture'], 'win32', false],
    ['cmd.exe', ['/d', '/q', '/c', 'echo fixture'], 'win32', false],
  ] as const)('keeps unrelated launch behavior for %s', (command, args, platform, shell) => {
    expect(mcpInspectorLaunch(command, [...args], platform, { fileExists: () => false })).toEqual({ command, args, shell });
  });
  it('resolves native PATH executables without interpreting structured spaced argv', () => {
    expect(mcpInspectorLaunch('node', ['C:\\a folder\\server.cjs', '&echo not-a-shell'], 'win32', {
      pathEnv: 'C:\\native tools', fileExists: (path) => path === 'C:\\native tools\\node.EXE',
    })).toEqual({ command: 'C:\\native tools\\node.EXE', args: ['C:\\a folder\\server.cjs', '&echo not-a-shell'], shell: false });
  });
  it.each(['npx', 'npx.cmd', 'runner.bat'])('rejects implicit batch shim %s with actionable guidance', (command) => {
    expect(() => mcpInspectorLaunch(command, [], 'win32', {
      pathEnv: 'C:\\shims', fileExists: (path) => /\.cmd$/i.test(path),
    })).toThrow(/Batch shims/);
  });
});

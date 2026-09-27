import { describe, it, expect, vi } from 'vitest';
import {
  providerLaunchSpec,
  wrapServerSpec,
  unwrapServerSpec,
  isWrappableServer,
  isWrappedServer,
  MCP_PROXY_ORIGINAL_ENV,
  MCP_PROXY_SERVER_ENV,
  MCP_PROXY_PROVIDER_ENV,
  type WrapContext,
} from './mcp-proxy-config.js';

const ctx: WrapContext = {
  nodePath: '/usr/bin/node',
  proxyScript: '/app/mcp/mcp-proxy.js',
  provider: 'copilot',
  serverName: 'filesystem',
  apiBase: 'http://127.0.0.1:1234/api',
  controlToken: 'secret',
};

describe('providerLaunchSpec', () => {
  it('uses the cmd.exe fallback when ComSpec is unavailable', () => {
    vi.stubEnv('ComSpec', undefined);
    try {
      expect(providerLaunchSpec('C:\\Program Files\\nodejs\\node.exe', [], 'win32').command).toBe('cmd.exe');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('leaves commands unchanged when Windows quoting is not required', () => {
    expect(providerLaunchSpec('node', ['server.js'], 'win32')).toEqual({
      command: 'node',
      args: ['server.js'],
    });
    expect(
      providerLaunchSpec('/Applications/App.app/Contents/MacOS/App', ['server.js'], 'darwin'),
    ).toEqual({
      command: '/Applications/App.app/Contents/MacOS/App',
      args: ['server.js'],
    });
  });

  it('uses cmd.exe on Windows when the executable path contains spaces', () => {
    expect(
      providerLaunchSpec(
        'C:\\Program Files\\AI Project Studio\\AI Project Studio.exe',
        ['C:\\Program Files\\AI Project Studio\\resources\\server.js'],
        'win32',
        'C:\\Windows\\System32\\cmd.exe',
      ),
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '"C:\\Program Files\\AI Project Studio\\AI Project Studio.exe" "C:\\Program Files\\AI Project Studio\\resources\\server.js"',
      ],
    });
  });

  it('quotes empty args and embedded quotes in the Windows command line', () => {
    expect(
      providerLaunchSpec(
        'C:\\Program Files\\nodejs\\node.exe',
        ['', 'say "hello"'],
        'win32',
        'cmd.exe',
      ).args,
    ).toEqual([
      '/d',
      '/s',
      '/c',
      '"C:\\Program Files\\nodejs\\node.exe" "" "say \\"hello\\""',
    ]);
  });
});

describe('isWrappableServer', () => {
  it('accepts stdio servers with a command', () => {
    expect(isWrappableServer({ command: 'npx', args: ['x'] })).toBe(true);
  });

  it('rejects url-based and command-less servers', () => {
    expect(isWrappableServer({ url: 'http://x' })).toBe(false);
    expect(isWrappableServer({ command: '   ' })).toBe(false);
    expect(isWrappableServer('nope')).toBe(false);
    expect(isWrappableServer(null)).toBe(false);
  });
});

describe('wrapServerSpec', () => {
  it('wraps a stdio server to launch through the proxy', () => {
    const spec = {
      command: 'npx',
      args: ['-y', 'server-filesystem', '/tmp'],
      env: { FOO: 'bar' },
      type: 'stdio',
      tools: ['*'],
    };
    const wrapped = wrapServerSpec(spec, ctx);
    expect(wrapped.command).toBe('/usr/bin/node');
    expect(wrapped.args).toEqual([
      '/app/mcp/mcp-proxy.js',
      'npx',
      '-y',
      'server-filesystem',
      '/tmp',
    ]);
    const env = wrapped.env as Record<string, string>;
    expect(env.FOO).toBe('bar');
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env[MCP_PROXY_SERVER_ENV]).toBe('filesystem');
    expect(env[MCP_PROXY_PROVIDER_ENV]).toBe('copilot');
    expect(env.STUDIO_API_BASE).toBe('http://127.0.0.1:1234/api');
    expect(env.STUDIO_CONTROL_TOKEN).toBe('secret');
    // Non-command fields are preserved.
    expect(wrapped.type).toBe('stdio');
    expect(wrapped.tools).toEqual(['*']);
  });

  it('returns non-stdio specs unchanged', () => {
    const spec = { url: 'http://server', type: 'http' };
    expect(wrapServerSpec(spec, ctx)).toBe(spec);
  });

  it('is idempotent and round-trips losslessly', () => {
    const spec = { command: 'node', args: ['s.js'], env: { A: '1' } };
    const once = wrapServerSpec(spec, ctx);
    expect(isWrappedServer(once)).toBe(true);
    const twice = wrapServerSpec(once, ctx);
    // Re-wrapping does not nest the proxy.
    expect(twice.args).toEqual(['/app/mcp/mcp-proxy.js', 'node', 's.js']);
    expect(unwrapServerSpec(twice)).toEqual(spec);
  });

  it('wraps a command-only server with no args', () => {
    const wrapped = wrapServerSpec({ command: 'my-server' }, ctx);
    expect(wrapped.args).toEqual(['/app/mcp/mcp-proxy.js', 'my-server']);
  });

  it('wraps through cmd.exe on Windows when the node path contains spaces', () => {
    const wrapped = wrapServerSpec(
      { command: 'npx', args: ['-y', 'server-filesystem'] },
      {
        ...ctx,
        nodePath: 'C:\\Program Files\\AI Project Studio\\AI Project Studio.exe',
        proxyScript: 'C:\\Program Files\\AI Project Studio\\resources\\mcp-proxy.js',
        platform: 'win32',
        windowsShell: 'C:\\Windows\\System32\\cmd.exe',
      },
    );
    expect(wrapped.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(wrapped.args).toEqual([
      '/d',
      '/s',
      '/c',
      '"C:\\Program Files\\AI Project Studio\\AI Project Studio.exe" "C:\\Program Files\\AI Project Studio\\resources\\mcp-proxy.js" npx -y server-filesystem',
    ]);
    expect(unwrapServerSpec(wrapped)).toEqual({
      command: 'npx',
      args: ['-y', 'server-filesystem'],
    });
  });
});

describe('unwrapServerSpec', () => {
  it('returns unwrapped specs unchanged', () => {
    const spec = { command: 'npx', args: [] };
    expect(unwrapServerSpec(spec)).toBe(spec);
  });

  it('recovers the original spec from the stash', () => {
    const original = { command: 'npx', args: ['a'], env: { Z: '9' } };
    const wrapped = wrapServerSpec(original, ctx);
    expect(unwrapServerSpec(wrapped)).toEqual(original);
  });

  it('keeps the wrapped spec when the stash is corrupt', () => {
    const spec = { command: 'node', env: { [MCP_PROXY_ORIGINAL_ENV]: '{not json' } };
    expect(unwrapServerSpec(spec)).toBe(spec);
  });

  it('keeps the wrapped spec when the stash is valid JSON but not an object', () => {
    const spec = { command: 'node', env: { [MCP_PROXY_ORIGINAL_ENV]: '[1,2,3]' } };
    expect(unwrapServerSpec(spec)).toBe(spec);
  });
});

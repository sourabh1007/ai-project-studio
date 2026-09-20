import { describe, it, expect } from 'vitest';
import {
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

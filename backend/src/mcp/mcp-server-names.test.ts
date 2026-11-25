import { describe, it, expect } from 'vitest';
import { enabledMcpServerNames, headlessMcpServerNames, nativeMcpServerNames } from './mcp-server-names.js';

describe('native effective MCP inventory', () => {
  it('disables every native source, including plugins and already-disabled servers', () => {
    expect(nativeMcpServerNames(JSON.stringify({ mcpServers: {
      user: { source: 'user' }, workspace: { source: 'workspace' },
      'plugin:server': { source: 'plugin', enabled: false }, builtin: { source: 'builtin' },
    } }))).toEqual(['user', 'workspace', 'plugin:server', 'builtin']);
    expect(nativeMcpServerNames('{"mcpServers":{}}')).toEqual([]);
  });
  it.each(['invalid private-token', 'null', '[]', '{}', '{"mcpServers":null}', '{"mcpServers":{"-unsafe":{}}}'])
    ('fails closed on missing or invalid inventory without echoing credentials: %s', (raw) => {
      expect(() => nativeMcpServerNames(raw)).toThrow();
      try { nativeMcpServerNames(raw); } catch (error) {
        expect((error as Error).message).not.toContain('private-token');
      }
    });
});

describe('conservative headless MCP suppression', () => {
  it('unions user, workspace and ancestor declarations without trusting enable flags', () => {
    expect(headlessMcpServerNames([
      { label: 'missing', document: null },
      { label: 'empty', document: {} },
      { label: 'user', document: { mcpServers: { alpha: { command: 'node' }, disabled: { enabled: false } } } },
      { label: 'workspace', document: { alpha: {}, beta: {} }, allowBareMap: true },
      { label: 'ancestor', document: { mcpServers: { gamma: {} } }, allowBareMap: true },
    ])).toEqual(['alpha', 'disabled', 'beta', 'gamma']);
  });
  it.each([[], true, { mcpServers: [] }, { mcpServers: { broken: true } }, { mcpServers: { '': {} } }, { mcpServers: { '-bad': {} } }])
    ('blocks malformed trusted source %j rather than loading it or guessing', (document) => {
      expect(() => headlessMcpServerNames([{ label: 'workspace', document }])).toThrow(/Repair.*native CLI/);
    });
});

describe('enabledMcpServerNames', () => {
  it('returns every object-valued server that is not disabled', () => {
    const names = enabledMcpServerNames({
      mcpServers: {
        github: { url: 'https://example.com' },
        azure: { command: 'x', enabled: true },
        off: { command: 'y', enabled: false },
      },
    });
    expect(names.sort()).toEqual(['azure', 'github']);
  });

  it('ignores non-object server entries', () => {
    const names = enabledMcpServerNames({
      mcpServers: { good: { url: 'u' }, bad: 'nope' as unknown as object },
    });
    expect(names).toEqual(['good']);
  });

  it('returns an empty list for a null document', () => {
    expect(enabledMcpServerNames(null)).toEqual([]);
  });

  it('returns an empty list when mcpServers is missing or malformed', () => {
    expect(enabledMcpServerNames({})).toEqual([]);
    expect(
      enabledMcpServerNames({
        mcpServers: [] as unknown,
      } as unknown as Parameters<typeof enabledMcpServerNames>[0]),
    ).toEqual([]);
  });
});

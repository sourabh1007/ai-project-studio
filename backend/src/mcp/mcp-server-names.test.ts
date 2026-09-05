import { describe, it, expect } from 'vitest';
import { enabledMcpServerNames } from './mcp-server-names.js';

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
      enabledMcpServerNames({ mcpServers: [] as unknown as object }),
    ).toEqual([]);
  });
});

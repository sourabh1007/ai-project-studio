import { describe, expect, it } from 'vitest';
import { mergeBuiltinSources } from './mcp-builtin-sources.js';
import type { McpCapabilities, McpServerEntry } from './mcp-contract.js';

function builtin(kind: 'resolved' | 'global', spec: Record<string, unknown>, name = 'ado'): McpServerEntry {
  return {
    name: `${kind}:${name}`, displayName: name, builtinName: name, origin: 'agency-built-in',
    spec, enabled: spec.enabled !== false,
    capabilities: { edit: { supported: kind === 'global', reason: null } } as McpCapabilities,
    configurationSources: [{ kind, source: kind, scope: kind, spec }],
  };
}

describe('logical native builtin source cards', () => {
  it('merges equal declarations despite property ordering and preserves the global action id and both sources', () => {
    const resolved = builtin('resolved', { organization: 'org', tools: ['a'], enabled: false });
    const global = builtin('global', { enabled: false, tools: ['a'], organization: 'org' });
    const result = mergeBuiltinSources([resolved, global]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'global:ado', enabled: false, configurationConflict: false, capabilities: { edit: { supported: true } } });
    expect(result[0].configurationSources!.map((source) => source.kind)).toEqual(['resolved', 'global']);
    expect(resolved.configurationSources).toHaveLength(1);
    expect(global.configurationSources).toHaveLength(1);
  });

  it('keeps resolved values and visibly preserves the conflicting global declaration in one read-only card', () => {
    const resolved = builtin('resolved', { organization: 'local' });
    const global = builtin('global', { organization: 'global' });
    const result = mergeBuiltinSources([global, resolved]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'resolved:ado', spec: { organization: 'local' }, configurationConflict: true, capabilities: { edit: { supported: false } } });
    expect(result[0].configurationSources![1].spec.organization).toBe('global');
    expect(global.capabilities!.edit.supported).toBe(true);
  });

  it('treats differing enabled values as conflicting even with equal specs', () => {
    const resolved = builtin('resolved', {});
    const global = { ...builtin('global', {}), enabled: false };
    expect(mergeBuiltinSources([resolved, global])[0].configurationConflict).toBe(true);
  });

  it('preserves custom aliases, app entries, distinct builtins and catalog entries', () => {
    const custom: McpServerEntry = { name: 'custom:ado', origin: 'custom', displayName: 'ado', spec: { command: 'server' } };
    const unusual = { ...custom, name: 'custom:global', configurationSources: [{ kind: 'global' as const, source: 'custom', scope: 'custom', spec: {} }] };
    const app: McpServerEntry = { name: 'studio', origin: 'app', spec: {} };
    const catalog: McpServerEntry = { name: 'catalog:ado', origin: 'agency-built-in', builtinName: 'ado', catalog: true, spec: {} };
    const missingName = { ...builtin('global', {}), name: 'unknown', builtinName: undefined };
    const resolved = builtin('resolved', {});
    const other = builtin('resolved', {}, 'finish-pr');
    const entries = [custom, unusual, app, catalog, missingName, resolved, other];
    expect(mergeBuiltinSources(entries)).toEqual(entries);
  });

  it('keeps unmatched global declarations visible but blocks editing until resolved configuration is verified', () => {
    const global = builtin('global', {});
    const result = mergeBuiltinSources([global]);
    expect(result).toHaveLength(1);
    expect(result[0].configurationSources).toEqual(global.configurationSources);
    expect(result[0].capabilities!.edit).toMatchObject({ supported: false, reason: expect.stringContaining('not been confirmed') });
    expect(result[0].configurationConflict).toBeUndefined();
  });
});

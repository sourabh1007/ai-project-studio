import { describe, expect, it } from 'vitest';
import { createAgencyMcpBuiltinRuntime } from './agency-mcp-builtin-runtime.js';

const runtime = createAgencyMcpBuiltinRuntime({ command: () => 'C:\\Program Files\\Agency\\agency.exe', cwd: 'C:\\workspace with spaces' });

describe('verified public native builtin argument binding', () => {
  it('supports option-free public builtins without inferring stored global options or authentication requirements', () => {
    expect(runtime.resolve('finish-pr', { enabled: true })).toEqual({
      supported: true, canonicalName: 'finish-pr',
      launch: { command: 'C:\\Program Files\\Agency\\agency.exe', args: ['mcp', 'finish-pr'], cwd: 'C:\\workspace with spaces' },
    });
    expect(runtime.resolve('msft-learn', {})).toMatchObject({ supported: true });
    expect(runtime.resolve('ado', { type: 'ado' })).toMatchObject({ supported: true });
  });

  it('binds every verified ADO option and preserves argument boundaries without a shell', () => {
    expect(runtime.resolve('ado-alias', {
      type: 'ado', scope_to_current_organization: true, allow_cross_organization_fallback: true,
      legacy: true, toolsets: ['core', 'work_items'],
    })).toMatchObject({
      supported: true, canonicalName: 'ado',
      launch: { args: ['mcp', 'ado', '--scope-to-current-organization', '--allow-cross-organization-fallback', '--legacy', '--toolsets', 'core,work_items'] },
    });
    const organization = 'org with spaces & symbols';
    expect(runtime.resolve('ado', { organization, legacy: false, scope_to_current_organization: false, allow_cross_organization_fallback: false }))
      .toMatchObject({ launch: { args: ['mcp', 'ado', '--organization', organization] } });
  });

  it.each([
    ['hidden', {}],
    ['ado', { type: 'hidden' }],
    ['ado', { type: null }],
    ['ado', { type: 1 }],
    ['ado', { enabled: 'true' }],
    ['ado', { enabled: false }],
    ['ado', { organization: '' }],
    ['ado', { organization: null }],
    ['ado', { organization: '-flag' }],
    ['ado', { organization: 'line\nbreak' }],
    ['ado', { organization: 'line\0break' }],
    ['ado', { scope_to_current_organization: 'true' }],
    ['ado', { legacy: 1 }],
    ['ado', { allow_cross_organization_fallback: true }],
    ['ado', { organization: 'org', scope_to_current_organization: true }],
    ['ado', { toolsets: [] }],
    ['ado', { toolsets: 'core' }],
    ['ado', { toolsets: [1] }],
    ['ado', { toolsets: ['-flag'] }],
    ['ado', { toolsets: ['core,extra'] }],
  ] as const)('rejects invalid or ambiguous native options for %s: %j', (name, spec) => {
    expect(runtime.resolve(name, spec)).toMatchObject({ supported: false, reason: expect.any(String) });
  });

  it.each(['headers', 'env', 'tools', 'args', 'unknown', 'compatibility'])('never drops an unverified configured field: %s', (field) => {
    const result = runtime.resolve('ado', { organization: 'org', [field]: 'private fixture' });
    expect(result).toMatchObject({ supported: false, reason: expect.stringContaining('without a verified native CLI mapping') });
    expect(JSON.stringify(result)).not.toContain('private fixture');
  });

  it('blocks options on another builtin rather than guessing its option names', () => {
    expect(runtime.resolve('finish-pr', { organization: 'org' })).toMatchObject({ supported: false });
  });

  it('does not launch shell wrappers', () => {
    const shim = createAgencyMcpBuiltinRuntime({ command: () => 'agency.cmd', cwd: 'workspace' });
    expect(shim.resolve('ado', {})).toMatchObject({ supported: false, reason: expect.stringContaining('shell wrappers') });
  });

  it('rebuilds every empirically verified Bluebird field including plural repositories and repeated scopes', () => {
    expect(runtime.resolve('bluebird', {
      type: 'bluebird', organization: 'org', project: 'project', repositories: ['repo one', 'repo2'],
      branch: 'main', scopes: ['org/project/repo;branch=main'], mini: true, full: false, local: true,
    })).toMatchObject({ supported: true, launch: { args: [
      'mcp', 'bluebird', '--organization', 'org', '--project', 'project',
      '--repository', 'repo one', '--repository', 'repo2', '--branch', 'main',
      '--scopes', 'org/project/repo;branch=main', '--mini', '--local',
    ] } });
    expect(runtime.resolve('bluebird', { type: 'bluebird', full: false, local: false, mini: false }))
      .toMatchObject({ supported: true, launch: { args: ['mcp', 'bluebird'] } });
    expect(runtime.resolve('bluebird', { repositories: [], scopes: [] })).toMatchObject({ supported: true });
  });

  it('binds native Kusto JSON and Logger string fields without leaking or discarding any configured fields', () => {
    const services = [{ service_uri: 'https://example.invalid', default_database: 'db', description: 'contains spaces' }];
    expect(runtime.resolve('kusto', { service_uri: 'https://example.invalid/', database: 'db', known_services: services }))
      .toMatchObject({ supported: true, launch: { args: [
        'mcp', 'kusto', '--service-uri', 'https://example.invalid/', '--database', 'db', '--known-services', JSON.stringify(services),
      ] } });
    expect(runtime.resolve('logger', { connection_string: 'fixture;value=private', filestore_dir_name: 'fixture' }))
      .toMatchObject({ supported: true, launch: { args: ['mcp', 'logger', '--connection-string', 'fixture;value=private', '--filestore-dir-name', 'fixture'] } });
  });

  it.each([
    ['bluebird', { mini: 'true' }], ['bluebird', { repositories: 'repo' }],
    ['bluebird', { scopes: [1] }], ['bluebird', { project: '' }],
    ['logger', { connection_string: 'line\nbreak' }],
    ['kusto', { known_services: '[]' }], ['kusto', { known_services: [null] }],
    ['kusto', { known_services: [[]] }], ['kusto', { known_services: [{}] }],
    ['kusto', { known_services: [{ service_uri: 'https://example.invalid', hidden: 'field' }] }],
    ['kusto', { known_services: [{ service_uri: 'https://example.invalid', description: 1 }] }],
  ] as const)('rejects invalid newly bound native fields %s %j', (name, spec) => {
    expect(runtime.resolve(name, spec)).toMatchObject({ supported: false });
  });
});

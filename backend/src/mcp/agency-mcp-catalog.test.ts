import { describe, expect, it, vi } from 'vitest';
import { AGENCY_PUBLIC_MCPS, createAgencyMcpCatalog, parseAgencyAvailableMcps, type AgencyPublicMcp } from './agency-mcp-catalog.js';
import type { AgencyMcpConfigRunner } from './agency-mcp-config-store.js';

const approved: AgencyPublicMcp[] = [
  { name: 'public-one', description: 'Documented fixture one', instruction: 'Review agency config set --help before configuring public-one.' },
  { name: 'public-two', description: 'Documented fixture two', instruction: 'Review agency config set --help before configuring public-two.' },
];
const help = [
  'Usage: agency config set [OPTIONS]',
  '          Available MCPs:',
  '            public-two',
  '            hidden-fixture',
  '            public-one',
  '            public-one',
  '',
  'Other options:',
  '  unrelated',
].join('\r\n');

describe('Agency installed public MCP catalog', () => {
  it('contains exactly the verified public documentation table with canonical native setup guidance', () => {
    const names = [
      'ado', 'finish-pr', 'bluebird', 'es-chat', 'engage', 'msft-learn', 's360-breeze',
      'change-ledger', 'safefly', 'perf-pas', 'domain-lens', 'service-tree', 'icm', 'watson',
      'fluent', 'security-context', 'dvdr', 'ecs', 'top', 'smart-dri', 'atlas', 'graph',
      'powerbi', 'kusto', 'workiq', 'teams', 'sharepoint', 'onedrive', 'mail', 'calendar',
      'cloudbuild', 'word', 'planner', 'm365-user', 'm365-copilot', 'enghub', 'logger', 'mrc',
    ];
    expect(AGENCY_PUBLIC_MCPS.map((entry) => entry.name)).toEqual(names);
    expect(new Set(names).size).toBe(38);
    for (const entry of AGENCY_PUBLIC_MCPS) {
      expect(entry.description.trim()).not.toBe('');
      expect(entry.instruction).toContain(`agency config set --global --mcp ${entry.name}`);
      expect(entry.instruction).toContain('Some built-ins require parameters');
      expect(entry.instruction).toContain('agency config set --global --mcp "ado --organization myorg"');
    }
  });
  it('parses only exact section rows, deduplicating and stopping before other help', () => {
    expect(parseAgencyAvailableMcps(help)).toEqual(['public-two', 'hidden-fixture', 'public-one']);
    expect(parseAgencyAvailableMcps('\u001b[1mAvailable MCPs:\u001b[0m\n  public-one\nNext:\n  other'))
      .toEqual(['public-one']);
  });

  it.each([
    '', 'Usage: agency mcp\n  public-one', 'Available MCPs:\n',
    'Available MCPs:\n\n  public-one', 'Available MCPs:\npublic-one',
    'Available MCPs:\n  public-one, public-two', 'Available MCPs:\n  public-one description',
    'Available MCPs:\n  ../invalid', 'Available MCPs:\n  public-one\n  malformed row',
  ])('does not guess catalog entries from malformed or unrelated help %j', (text) => {
    expect(parseAgencyAvailableMcps(text)).toBeNull();
  });

  it('requires both installed help and verified public allow-list; never exposes hidden help entries', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: help }));
    const catalog = await createAgencyMcpCatalog({ run }, [...approved, {
      name: 'not-installed', description: 'Absent', instruction: 'Do not show',
    }])();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(['config', 'set', '--help']);
    expect(catalog.servers.map((entry) => entry.name)).toEqual(['catalog:public-one', 'catalog:public-two']);
    expect(JSON.stringify(catalog)).not.toContain('hidden-fixture');
    const first = catalog.servers[0];
    expect(first).toMatchObject({
      displayName: 'public-one', catalog: true, providerLabel: 'Agency',
      source: 'Installed Agency MCP catalog', scope: 'Available built-in',
      spec: { type: 'agency-builtin', description: 'Documented fixture one' },
      toolDiscovery: { status: 'skipped', output: [] },
    });
    expect(first).not.toHaveProperty('enabled');
    expect(first.spec).not.toHaveProperty('command');
    expect(Object.values(first.capabilities!).every((cap) => !cap.supported && cap.reason!.includes('not configured or connected'))).toBe(true);
    expect(first.capabilities!.edit.reason).toContain(approved[0].instruction);
  });

  it('does not fabricate installed entries from the public allow-list alone', async () => {
    const load = createAgencyMcpCatalog({ run: async () => ({ code: 0, stdout: 'Available MCPs:\n  different' }) }, approved);
    expect((await load()).servers).toEqual([]);
  });

  it('reports command, transport and parse failures without exposing command output', async () => {
    const run = vi.fn<AgencyMcpConfigRunner['run']>()
      .mockResolvedValueOnce({ code: 1, stdout: 'sensitive', stderr: 'sensitive' })
      .mockRejectedValueOnce(new Error('sensitive'))
      .mockResolvedValueOnce({ code: 0, stdout: 'sensitive' });
    const load = createAgencyMcpCatalog({ run }, approved);
    for (const expected of ['help is unavailable', 'bounded command', 'recognized Available MCPs']) {
      const result = await load();
      expect(result.servers).toEqual([]);
      expect(result.notices[0]).toContain(expected);
      expect(JSON.stringify(result)).not.toContain('sensitive');
    }
  });

  it('coalesces overlapping read-only help calls without retaining stale installation results', async () => {
    let release!: (result: { code: number; stdout: string }) => void;
    const run = vi.fn(() => new Promise<{ code: number; stdout: string }>((resolve) => { release = resolve; }));
    const load = createAgencyMcpCatalog({ run }, approved);
    const first = load();
    const second = load();
    expect(run).toHaveBeenCalledTimes(1);
    release({ code: 0, stdout: help });
    expect(await first).toEqual(await second);
    const next = load();
    expect(run).toHaveBeenCalledTimes(2);
    release({ code: 0, stdout: 'Available MCPs:\n  public-two' });
    expect((await next).servers.map((entry) => entry.displayName)).toEqual(['public-two']);
  });
});

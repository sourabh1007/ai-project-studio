import { describe, expect, it, vi } from 'vitest';
import { createAgencyMcpOptions, parseAgencyMcpOptions } from './agency-mcp-options.js';

const help = `Usage: agency.exe mcp ado [OPTIONS]

Options:
      --organization <ORGANIZATION>
          Organization description
          Second sentence [env: PRIVATE=do-not-expose]
          [aliases: --org]
      --legacy
          Legacy mode
      --mode <MODE>
          Mode choice
          Possible values:
          - one: First
          - two: Second
      --other <OTHER>  Inline description [default: do-not-expose]
          [possible values: a, b]
      --transport <TRANSPORT>
          Proxy transport
          [default: stdio]
  -h, --help
          Print help
Commands:
  hidden-entry
`;

describe('cached public native options', () => {
  it('parses exact advertised options without shared proxy flags, hidden sections, env values or defaults', () => {
    expect(parseAgencyMcpOptions('ado', help)).toEqual([
      { flag: '--organization', valueHint: 'ORGANIZATION', description: 'Organization description Second sentence' },
      { flag: '--legacy', description: 'Legacy mode' },
      { flag: '--mode', valueHint: 'MODE', description: 'Mode choice', choices: ['one', 'two'] },
      { flag: '--other', valueHint: 'OTHER', description: 'Inline description', choices: ['a', 'b'] },
    ]);
    expect(parseAgencyMcpOptions('ado', '\u001b[32mUsage: agency.exe mcp ado\u001b[0m\nOptions:\n  --flag\n    Description\n')).toEqual([{ flag: '--flag', description: 'Description' }]);
    expect(parseAgencyMcpOptions('ado', 'Usage: agency.exe mcp ado [OPTIONS]\nOptions:\n  --help\n    Help\n')).toEqual([]);
    for (const text of ['', 'Usage: agency.exe mcp other [OPTIONS]\nOptions:', 'Usage: agency.exe mcp ado [OPTIONS]', 'Usage: agency.exe mcp ado [OPTIONS]\nOptions:\n  --bad [VALUE]']) {
      expect(parseAgencyMcpOptions('ado', text)).toBeNull();
    }
  });

  function setup() {
    let now = 1000;
    const runner = { run: vi.fn(async (_args: string[]) => ({ code: 0, stdout: help, stderr: '' })) };
    const options = createAgencyMcpOptions({ runner, now: () => now, ttlMs: 60_000, maxConcurrent: 1 });
    return { options, runner, advance: (ms: number) => { now += ms; } };
  }

  it('uses bounded public help only, caches it, returns copies and refreshes on TTL expiry', async () => {
    const s = setup();
    const result = await s.options.get('ado');
    expect(s.runner.run).toHaveBeenCalledWith(['mcp', 'ado', '--help']);
    expect(result).toMatchObject({
      command: 'agency config set --global --mcp', stale: false, cachedAt: '1970-01-01T00:00:01.000Z',
      examples: ['--organization <ORGANIZATION>', '--legacy', '--mode one'],
    });
    expect(JSON.stringify(result)).not.toContain('do-not-expose');
    result.options[0].description = 'mutated';
    expect((await s.options.get('ado')).options[0].description).not.toBe('mutated');
    expect(s.runner.run).toHaveBeenCalledOnce();
    s.advance(60_000);
    expect((await s.options.get('ado')).cachedAt).toBe('1970-01-01T00:01:01.000Z');
    expect(s.runner.run).toHaveBeenCalledTimes(2);
  });

  it('never invokes help for unlisted types and handles option-free builtin help honestly', async () => {
    const s = setup();
    expect((await s.options.get('private')).message).toContain('verified public');
    expect(s.runner.run).not.toHaveBeenCalled();
    s.runner.run.mockResolvedValue({ code: 0, stdout: 'Usage: agency.exe mcp finish-pr [OPTIONS]\nOptions:\n --help\n  Help', stderr: '' });
    expect(await s.options.get('finish-pr')).toMatchObject({ options: [], examples: [], stale: false, message: expect.stringContaining('No server-specific') });
  });

  it('coalesces simultaneous reads and rejects excess concurrent help without queuing', async () => {
    const s = setup();
    let release!: (value: { code: number; stdout: string; stderr: string }) => void;
    s.runner.run.mockImplementationOnce(async () => new Promise((resolve) => { release = resolve; }));
    const one = s.options.get('ado');
    const two = s.options.get('ado');
    expect((await s.options.get('kusto')).message).toContain('busy');
    expect(s.runner.run).toHaveBeenCalledOnce();
    release({ code: 0, stdout: help, stderr: '' });
    expect(await one).toEqual(await two);
  });

  it('keeps stale suggestions on failure and backs off subsequent failing refreshes', async () => {
    const s = setup();
    await s.options.get('ado');
    s.advance(60_000);
    s.runner.run.mockRejectedValueOnce(new Error('private credentials in failure'));
    const stale = await s.options.get('ado');
    expect(stale).toMatchObject({ stale: true, cachedAt: '1970-01-01T00:00:01.000Z', message: expect.stringContaining('refresh failed') });
    expect(stale.options).toHaveLength(4);
    expect(JSON.stringify(stale)).not.toContain('private credentials');
    await s.options.get('ado');
    expect(s.runner.run).toHaveBeenCalledTimes(2);
    s.advance(30_000);
    expect((await s.options.get('ado')).stale).toBe(false);
  });

  it.each([{ code: 2, stdout: 'private', stderr: 'private' }, { code: 0, stdout: 'malformed help', stderr: '' }])('does not invent suggestions from unavailable/malformed help', async (response) => {
    const s = setup();
    s.runner.run.mockResolvedValue(response);
    expect(await s.options.get('ado')).toMatchObject({ options: [], cachedAt: null, stale: false, message: expect.stringContaining('unavailable') });
    await s.options.get('ado');
    expect(s.runner.run).toHaveBeenCalledOnce();
    s.advance(60_000);
    await s.options.get('ado');
    expect(s.runner.run).toHaveBeenCalledTimes(2);
  });
});

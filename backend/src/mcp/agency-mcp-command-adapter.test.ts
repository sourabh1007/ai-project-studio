import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createAgencyMcpCommandRunner } from './agency-mcp-command-adapter.js';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, existsSync: vi.fn(fs.existsSync) };
});

describe('Agency direct command runner', () => {
  const runner = (timeoutMs = 5000) => createAgencyMcpCommandRunner({
    executable: () => process.execPath, cwd: process.cwd(), timeoutMs,
  });

  it('preserves spaces, quotes and shell metacharacters in the single spec argument through a real process', async () => {
    const spec = 'ado --organization "org with spaces" --value "& echo injected | > marker ; $(test)"';
    const argv = ['config', 'set', '--global', '--mcp', spec];
    const result = await runner().run(['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...argv]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(argv);
    expect(result.stderr).toBe('');
  });

  it('returns nonzero exits to the domain for safe reporting', async () => {
    const result = await runner().run(['-e', 'process.stderr.write("fixture"); process.exit(7)']);
    expect(result).toEqual({ code: 7, stdout: '', stderr: 'fixture' });
  });

  it('kills hung commands within the timeout', async () => {
    await expect(runner(100).run(['-e', 'setInterval(()=>{},1000)'])).rejects.toThrow(/failed or timed out/);
  });

  it('blocks nonexistent binaries and existing shell wrappers', async () => {
    await expect(createAgencyMcpCommandRunner({
      executable: () => 'nonexistent-agency-fixture.exe', cwd: process.cwd(), timeoutMs: 100,
    }).run([])).rejects.toThrow(/unavailable/);
    vi.mocked(existsSync).mockReturnValueOnce(true);
    await expect(createAgencyMcpCommandRunner({
      executable: () => 'unexecuted.cmd', cwd: process.cwd(), timeoutMs: 100,
    }).run([])).rejects.toThrow(/unavailable/);
  });
});

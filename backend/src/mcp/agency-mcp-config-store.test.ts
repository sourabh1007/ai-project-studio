import { describe, expect, it, vi } from 'vitest';
import { createAgencyMcpConfigStore } from './agency-mcp-config-store.js';

function setup(stdout = 'servers:\n  a:\n    command: node\nbuiltins:\n  github: false\n') {
  const run = vi.fn(async (_args: string[]): Promise<{ code: number; stdout: string; stderr?: string }> => ({ code: 0, stdout }));
  const store = createAgencyMcpConfigStore({ runner: { run }, sourcePath: 'native' });
  return { store, run };
}

describe('Agency native configuration store', () => {
  it('treats the verified Windows missing-global-file diagnostic as unconfigured only in global scope', async () => {
    const stderr = 'Error: Failed to load global config: Failed to read config file C:\\isolated\\agency.toml: The system cannot find the file specified. (os error 2)';
    const run = vi.fn(async () => ({ code: 1, stdout: '', stderr }));
    const global = createAgencyMcpConfigStore({ runner: { run }, sourcePath: 'global', scope: 'global' });
    expect(await global.read('global')).toBeNull();
    const resolved = createAgencyMcpConfigStore({ runner: { run }, sourcePath: 'resolved' });
    await expect(resolved.read('resolved')).rejects.toThrow(/not treated as an empty/);
    for (const result of [
      { code: 2, stdout: '', stderr },
      { code: 1, stdout: 'partial', stderr },
      { code: 1, stdout: '', stderr: stderr.replace('(os error 2)', '(os error 5)') },
      { code: 1, stdout: '', stderr: `${stderr}\nError: different failure` },
      { code: 1, stdout: '', stderr: undefined },
    ]) {
      run.mockResolvedValueOnce(result as { code: number; stdout: string; stderr: string });
      await expect(global.read('global')).rejects.toThrow(/not treated as an empty/);
    }
  });
  it('reads only the global scope for persistence verification', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: 'builtins:\n  ado:\n    enabled: false\n' }));
    const store = createAgencyMcpConfigStore({ runner: { run }, sourcePath: 'global', scope: 'global' });
    expect(await store.read('global')).toEqual({ mcps: { builtins: { ado: { enabled: false } } } });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(['config', 'get', '--global', 'mcps']);
  });
  it('reads resolved YAML without inventing provenance, JSON flags or meta calls', async () => {
    const { store, run } = setup();
    expect(await store.read('native')).toEqual({ mcps: { servers: { a: { command: 'node' } }, builtins: { github: false } } });
    expect(run).toHaveBeenCalledWith(['config', 'get', 'mcps']);
  });
  it('rejects writes rather than corrupting TOML or silently converting formats', async () => {
    const { store, run } = setup();
    const document = { mcps: { servers: { a: { command: 'x & echo secret', args: ['"'] } }, builtins: { github: false }, other: 'preserved' } };
    await expect(store.write('native', document)).rejects.toThrow(/object config setters can corrupt TOML/);
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['', 'null', '42', '[]', 'bad: [', 'a: 1\na: 2'])('rejects unusable native output %j without leaking it', async (stdout) => {
    const { store } = setup(stdout);
    await expect(store.read('native')).rejects.toThrow(/valid YAML mcps map/);
  });
  it('distinguishes CLI failures from empty config and redacts transport errors', async () => {
    const { store, run } = setup();
    run.mockResolvedValueOnce({ code: 1, stdout: 'secret' });
    await expect(store.read('native')).rejects.toThrow(/not treated as an empty configuration/);
    run.mockRejectedValueOnce(new Error('secret auth token'));
    await expect(store.read('native')).rejects.toThrow(/command is unavailable/);
    await expect(store.read('other')).rejects.toThrow(/Unknown Agency/);
  });

  it.each([
    "Error: Key 'mcps' not found in config",
    "\u001b[31mError: Key 'mcps' not found in config\u001b[0m\r\n",
    "native informational output\nError: Key 'mcps' not found in config\n",
    "Key 'mcps' not found in config",
  ])('treats the exact documented missing mcps diagnostic as unconfigured: %j', async (stderr) => {
    const { store, run } = setup();
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr });
    expect(await store.read('native')).toBeNull();
  });

  it.each([
    { code: 1, stdout: '' },
    { code: 1, stdout: '', stderr: "Error: Key 'other' not found in config" },
    { code: 1, stdout: '', stderr: "Error: permission denied" },
    { code: 1, stdout: 'partial config', stderr: "Error: Key 'mcps' not found in config" },
    { code: 2, stdout: '', stderr: "Error: Key 'mcps' not found in config" },
    { code: 1, stdout: '', stderr: "Error: Key 'mcps' not found in config\nError: additional failure" },
  ])('does not hide other CLI failures as empty configuration %j', async (result) => {
    const { store, run } = setup();
    run.mockResolvedValueOnce(result);
    await expect(store.read('native')).rejects.toThrow(/Unrecognized CLI errors/);
  });
});

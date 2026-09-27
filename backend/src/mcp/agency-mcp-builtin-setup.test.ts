import { describe, expect, it, vi } from 'vitest';
import { createAgencyMcpBuiltinSetup } from './agency-mcp-builtin-setup.js';
import { createAgencyMcpCatalog } from './agency-mcp-catalog.js';
import { createMcpConfigWrites } from './mcp-config-writes.js';
import type { McpConfigDocument, McpConfigFileStore } from './mcp-contract.js';

function setup(initial: McpConfigDocument | null = null) {
  let document = initial;
  const globalStore: McpConfigFileStore = {
    read: vi.fn(async () => structuredClone(document)),
    write: vi.fn(),
  };
  const catalog = createAgencyMcpCatalog({
    run: async () => ({ code: 0, stdout: 'Available MCPs:\n  ado\n  kusto' }),
  }, ['ado', 'kusto'].map((name) => ({ name, description: name, instruction: name })));
  const runner = { run: vi.fn(async (args: string[]) => {
    const name = args[4].split(' ')[0];
    const prior = document?.mcps as Record<string, unknown> | undefined;
    document = { ...document, mcps: { ...prior, builtins: { ...(prior?.builtins as object), [name]: { enabled: false, nativeArguments: args[4] } } } };
    return { code: 0, stdout: 'private output', stderr: 'private error' };
  }) };
  const manager = createAgencyMcpBuiltinSetup({
    runner, globalStore, catalog, globalSource: 'global', writes: createMcpConfigWrites(),
  });
  return { manager, runner, globalStore, catalog, getDocument: () => document };
}

describe('native Agency global built-in setup', () => {
  it('passes exactly one MCP spec argv and verifies persisted scoped data without generic JSON writes', async () => {
    const { manager, runner, globalStore, getDocument } = setup({ mcps: { servers: { other: { command: 'preserved' } } }, sibling: true });
    const value = 'org-"quoted"-C:\\folder&symbol';
    const args = ` --organization ${JSON.stringify(value)} --legacy `;
    await manager.configure('ado', args, 'add');
    expect(runner.run).toHaveBeenCalledOnce();
    expect(runner.run).toHaveBeenCalledWith(['config', 'set', '--global', '--mcp', `ado --organization ${value} --legacy`]);
    expect(globalStore.read).toHaveBeenNthCalledWith(1, 'global');
    expect(globalStore.read).toHaveBeenNthCalledWith(2, 'global');
    expect(globalStore.write).not.toHaveBeenCalled();
    expect(getDocument()).toMatchObject({ sibling: true, mcps: { servers: { other: { command: 'preserved' } }, builtins: { ado: { enabled: false } } } });
  });

  it.each([null, { mcps: {} }, { mcps: { builtins: {}, servers: {} } }])('supports empty arguments and absent builtins %j', async (document) => {
    const s = setup(document);
    await s.manager.configure('ado', '  ', 'add');
    expect(s.runner.run.mock.calls[0][0][4]).toBe('ado');
  });

  it.each([true, false, { enabled: true }])('edits a valid explicitly owned entry %j', async (value) => {
    const s = setup({ mcps: { builtins: { ado: value } } });
    await s.manager.configure('ado', '--organization mine', 'edit');
    expect(s.runner.run).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, 1, 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(4097)])('rejects invalid arguments without reads or writes', async (args) => {
    const s = setup();
    await expect(s.manager.configure('ado', args as string, 'add')).rejects.toThrow(/single line/);
    expect(s.globalStore.read).not.toHaveBeenCalled();
    expect(s.runner.run).not.toHaveBeenCalled();
  });

  it.each(['agency mcp ado --organization org', 'ado --organization org', '--organization "org space"', '--help'])('rejects incorrectly constructed commands before even reading/writing global configuration', async (args) => {
    const s = setup();
    await expect(s.manager.configure('ado', args, 'add')).rejects.toThrow();
    expect(s.globalStore.read).not.toHaveBeenCalled();
    expect(s.runner.run).not.toHaveBeenCalled();
  });

  it.each(['ado --evil', '../ado', '', 'UNLISTED'])('rejects unsafe builtin name %j', async (name) => {
    const s = setup();
    await expect(s.manager.configure(name, '', 'add')).rejects.toThrow(/Invalid Agency/);
    expect(s.runner.run).not.toHaveBeenCalled();
  });

  it('rejects unavailable/nonpublic names', async () => {
    const s = setup();
    await expect(s.manager.configure('private', '', 'add')).rejects.toThrow(/installed, public/);
    expect(s.globalStore.read).not.toHaveBeenCalled();
  });

  it.each([
    [{ mcps: null }, /must be an object/],
    [{ mcps: [] }, /must be an object/],
    [{ mcps: { builtins: [] } }, /built-ins must be an object/],
    [{ mcps: { servers: false } }, /custom servers must be an object/],
    [{ mcps: { servers: { ado: {} } } }, /name conflict/],
    [{ mcps: { builtins: { ado: true } } }, /already exists/],
  ] as const)('blocks malformed/conflicting global configuration %j', async (document, error) => {
    const s = setup(document as McpConfigDocument);
    await expect(s.manager.configure('ado', '', 'add')).rejects.toThrow(error);
    expect(s.runner.run).not.toHaveBeenCalled();
  });

  it('blocks removed or malformed edit targets', async () => {
    await expect(setup().manager.configure('ado', '', 'edit')).rejects.toThrow(/was removed/);
    const s = setup({ mcps: { builtins: { ado: 42 } } });
    await expect(s.manager.configure('ado', '', 'edit')).rejects.toThrow(/malformed/);
    expect(s.runner.run).not.toHaveBeenCalled();
  });

  it('propagates safe source read failures without issuing a setter', async () => {
    const s = setup();
    vi.mocked(s.globalStore.read).mockRejectedValue(new Error('Global source unavailable'));
    await expect(s.manager.configure('ado', '', 'add')).rejects.toThrow(/unavailable/);
    expect(s.runner.run).not.toHaveBeenCalled();
  });

  it('never retries or leaks setter diagnostics on a nonzero exit', async () => {
    const s = setup();
    s.runner.run.mockResolvedValue({ code: 2, stdout: 'private token', stderr: 'credential' });
    await expect(s.manager.configure('ado', '', 'add')).rejects.toThrow(/Agency rejected/);
    expect(s.runner.run).toHaveBeenCalledOnce();
    expect(s.globalStore.read).toHaveBeenCalledOnce();
  });

  it('reports unavailable/timed-out setter persistence as unknown without retry', async () => {
    const s = setup();
    s.runner.run.mockRejectedValue(new Error('private timeout command token'));
    await expect(s.manager.configure('ado', '', 'add')).rejects.toThrow(/persistence is unknown/);
    expect(s.runner.run).toHaveBeenCalledOnce();
  });

  it.each([null, { mcps: {} }, { mcps: { builtins: { ado: 1 } } }])('does not claim configured if read-back lacks a valid declaration %j', async (after) => {
    const s = setup();
    vi.mocked(s.globalStore.read).mockResolvedValueOnce(null).mockResolvedValueOnce(after);
    await expect(s.manager.configure('ado', '', 'add')).rejects.toThrow(/could not be verified/);
    expect(s.runner.run).toHaveBeenCalledOnce();
  });

  it.each([true, false])('accepts persisted boolean builtin %s without claiming live state', async (value) => {
    const s = setup();
    vi.mocked(s.globalStore.read).mockResolvedValueOnce(null).mockResolvedValueOnce({ mcps: { builtins: { ado: value } } });
    await expect(s.manager.configure('ado', '', 'add')).resolves.toBeUndefined();
  });

  it('does not leak read-back failures or retry', async () => {
    const s = setup();
    vi.mocked(s.globalStore.read).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('secret'));
    await expect(s.manager.configure('ado', '', 'add')).rejects.toThrow(/could not be verified/);
    expect(s.runner.run).toHaveBeenCalledOnce();
  });

  it('serializes read/set/verify across builtin names with a bounded queue', async () => {
    const s = setup();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const original = s.runner.run.getMockImplementation()!;
    s.runner.run.mockImplementationOnce(async (args) => { await held; return original(args); });
    const first = s.manager.configure('ado', '', 'add');
    const second = s.manager.configure('kusto', '', 'add');
    await expect(s.manager.configure('ado', '', 'add')).rejects.toThrow(/busy/);
    await vi.waitFor(() => expect(s.runner.run).toHaveBeenCalledOnce());
    expect(s.globalStore.read).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
    expect(s.runner.run).toHaveBeenCalledTimes(2);
    expect(s.globalStore.read).toHaveBeenCalledTimes(4);
    expect(s.getDocument()).toMatchObject({ mcps: { builtins: { ado: {}, kusto: {} } } });
    await expect(s.manager.configure('ado', '', 'edit')).resolves.toBeUndefined();
  });

  it('rechecks concurrent duplicate adds after the previous write', async () => {
    const s = setup();
    const first = s.manager.configure('ado', '', 'add');
    const second = s.manager.configure('ado', '', 'add');
    await first;
    await expect(second).rejects.toThrow(/already exists/);
    expect(s.runner.run).toHaveBeenCalledOnce();
  });
});

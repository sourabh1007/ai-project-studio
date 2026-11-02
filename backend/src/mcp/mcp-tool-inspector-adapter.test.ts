import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMcpToolInspector } from './mcp-tool-inspector-adapter.js';
import { providerLaunchSpec } from './mcp-proxy-config.js';

describe('MCP inspector real local protocol fixture', () => {
  it.each(['unsupported-protocol', 'missing-capabilities', 'invalid-tools'])('refuses invalid negotiated %s', async (mode) => {
    const script = fileURLToPath(new URL('./fixtures/stdio probe fixture.cjs', import.meta.url));
    const result = await createMcpToolInspector().inspect({
      serverName: 'fixture', spec: providerLaunchSpec(process.execPath, [script, mode]), timeoutMs: 3000,
    });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('initialize');
  });
  it('does not request unadvertised tools', async () => {
    const script = fileURLToPath(new URL('./fixtures/stdio probe fixture.cjs', import.meta.url));
    const result = await createMcpToolInspector().inspect({
      serverName: 'fixture', spec: providerLaunchSpec(process.execPath, [script, 'no-tools']), timeoutMs: 3000,
    });
    expect(result.status).toBe('ok');
    expect(result.tools).toEqual([]);
    expect(result.message).toContain('does not advertise');
  });
  it('discovers a spaced script through a bare Windows node command without a shell', async () => {
    if (process.platform !== 'win32') return;
    const script = fileURLToPath(new URL('./fixtures/stdio probe fixture.cjs', import.meta.url));
    const result = await createMcpToolInspector().inspect({
      serverName: 'fixture', spec: { command: 'node', args: [script] }, timeoutMs: 3000,
    });
    expect(result.status, result.message ?? '').toBe('ok');
  });
  it('collects all tools/list pages and refuses a repeating cursor rather than claiming a complete inventory', async () => {
    const script = fileURLToPath(new URL('./fixtures/stdio probe fixture.cjs', import.meta.url));
    const result = await createMcpToolInspector().inspect({
      serverName: 'fixture', spec: providerLaunchSpec(process.execPath, [script, 'pages']), timeoutMs: 3000,
    });
    expect(result.status).toBe('ok');
    expect(result.tools.map((tool) => tool.name)).toEqual(['first_page_tool', 'second_page_tool']);
    const loop = await createMcpToolInspector().inspect({
      serverName: 'fixture', spec: providerLaunchSpec(process.execPath, [script, 'cursor-loop']), timeoutMs: 3000,
    });
    expect(loop.status).toBe('failed');
    expect(loop.message).toContain('pagination');
    expect(loop.tools).toEqual([]);
  });
  it('reports live progress and terminates its protocol subprocess when explicitly cancelled', async () => {
    const script = fileURLToPath(new URL('./fixtures/stdio probe fixture.cjs', import.meta.url));
    const controller = new AbortController();
    const progress: string[][] = [];
    const result = await createMcpToolInspector().inspect({
      serverName: 'fixture', spec: providerLaunchSpec(process.execPath, [script, 'challenge']),
      timeoutMs: 3000, signal: controller.signal,
      onProgress: (output) => { progress.push([...output]); controller.abort(); },
    });
    expect(progress.flat().join(' ')).toContain('enter the code ABCD12345');
    expect(result.message).toBe('MCP inspection was cancelled');
    const pid = Number(/fixture-pid=(\d+)/.exec(progress.flat().join(' '))![1]);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('does not start a subprocess when the caller already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await createMcpToolInspector().inspect({
      serverName: 'fixture', spec: { command: 'must-not-launch' }, timeoutMs: 1000, signal: controller.signal,
    });
    expect(result.message).toBe('MCP inspection was cancelled');
  });

  it('retains evidence of an unconfirmed live challenge when the native server advertises tools before sign-in', async () => {
    const script = fileURLToPath(new URL('./fixtures/stdio probe fixture.cjs', import.meta.url));
    const result = await createMcpToolInspector().inspect({
      serverName: 'fixture', spec: providerLaunchSpec(process.execPath, [script, 'challenge-inventory']), timeoutMs: 3000,
    });
    expect(result.status).toBe('ok');
    expect(result.authenticationInterrupted).toBe(true);
    expect(result.tools).toHaveLength(1);
  });

  it('observes a JSON-RPC authentication error without losing its evidence', async () => {
    const script = fileURLToPath(new URL('./fixtures/stdio probe fixture.cjs', import.meta.url));
    const result = await createMcpToolInspector().inspect({
      serverName: 'fixture', spec: providerLaunchSpec(process.execPath, [script, 'auth-error']), timeoutMs: 3000,
    });
    expect(result.status).toBe('failed');
    expect(result.authRequired).toBe(true);
  });
  it('initializes and lists tools through the actual app-owned Windows launcher shape', async () => {
    const script = fileURLToPath(new URL('./fixtures/stdio probe fixture.cjs', import.meta.url));
    const launch = providerLaunchSpec(process.execPath, [script]);
    const result = await createMcpToolInspector().inspect({
      serverName: 'fixture', spec: launch, timeoutMs: 3_000,
    });
    expect(result.status, `${result.message}\n${result.output.join('\n')}`).toBe('ok');
    expect(result.tools).toEqual([{ name: 'fixture_tool', description: 'Harmless local protocol fixture' }]);
  });

  it('surfaces the actual stderr cause of an early process exit', async () => {
    const script = fileURLToPath(new URL('./fixtures/stdio probe fixture.cjs', import.meta.url));
    const result = await createMcpToolInspector().inspect({
      serverName: 'fixture',
      spec: providerLaunchSpec(process.execPath, [script, 'fail']),
      timeoutMs: 1_000,
    });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('fixture executable cannot start: path with spaces');
  });

  it('bounds an unresponsive protocol process and identifies the timeout precisely', async () => {
    const script = fileURLToPath(new URL('./fixtures/stdio probe fixture.cjs', import.meta.url));
    const result = await createMcpToolInspector().inspect({
      serverName: 'fixture',
      spec: providerLaunchSpec(process.execPath, [script, 'hang']),
      timeoutMs: 200,
    });
    expect(result.status).toBe('failed');
    expect(result.message).toBe('Timed out after 200ms while inspecting MCP tools');
  });
});

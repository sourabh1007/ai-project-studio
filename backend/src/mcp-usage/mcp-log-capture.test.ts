import { describe, expect, it, vi } from 'vitest';
import { createMcpLogCapture, mcpCallFromEvent, type McpLogCaptureDeps, type McpLogPage } from './mcp-log-capture.js';
import { MCP_USAGE_NAMESPACE, mcpUsageConfigSchema, mcpUsageDefaults } from './config.js';

const timestamp = '2026-09-26T10:00:00.000Z';
const event = (data: Record<string, unknown> = {}) => ({
  type: 'tool.execution_start', timestamp,
  data: { toolCallId: 'call-1', mcpServerName: 'ado', ...data },
});
const page = (lines = [JSON.stringify(event())]): McpLogPage => ({
  lines, cursor: { offset: 42, skipping: false }, oversized: false,
});
function fixture(overrides: Partial<McpLogCaptureDeps> = {}) {
  const deps: McpLogCaptureDeps = {
    owners: {
      list: vi.fn().mockReturnValue([{ key: 'agency:s', provider: 'agency', sessionId: 's' }]),
      resolve: vi.fn().mockReturnValue({ featureId: 'f', sessionId: 's', scope: 'feature' }),
    },
    reader: { read: vi.fn().mockResolvedValue(page()) },
    usage: { recordObserved: vi.fn() },
    logger: { warn: vi.fn() },
    sourcesPerTick: 2, bytesPerSource: 4096, maxCachedSources: 2, ...overrides,
  };
  return { deps, capture: createMcpLogCapture(deps) };
}

describe('explicit CLI MCP event identification', () => {
  it.each([
    ['builtin', 'built-in'], ['user', 'configured'], ['workspace', 'configured'],
    ['plugin', 'configured'], ['managed', 'unknown'], [undefined, 'unknown'], ['future', 'unknown'],
  ])('uses only explicit provenance %s', (mcpConfigSource, origin) => {
    expect(mcpCallFromEvent(event({ mcpConfigSource }))).toEqual({
      server: 'ado', callId: 'call-1', recordedAt: timestamp, origin,
    });
  });
  it('prefers config identity over display name and never reads billing/arguments', () => {
    expect(mcpCallFromEvent(event({
      mcpConfigServerName: 'my-server', arguments: { secret: 'not retained' },
      inputTokens: 10, nanoAiu: 200,
    }))).toEqual({ server: 'my-server', callId: 'call-1', recordedAt: timestamp, origin: 'unknown' });
  });
  it.each([
    null, [], 1, 'text', {}, { type: 'tool.execution_complete' },
    { type: 'tool.execution_start', data: null }, { type: 'tool.execution_start', data: [] },
    event({ toolCallId: '' }), event({ toolCallId: 7 }), event({ toolCallId: 'a\nb' }),
    event({ toolCallId: 'x'.repeat(513) }), event({ mcpServerName: undefined, toolName: 'mcp_ado_tool' }),
    event({ mcpConfigServerName: '' }), event({ mcpServerName: '  ' }),
    { ...event(), timestamp: 'invalid' }, { ...event(), timestamp: 1 },
  ])('ignores non-MCP or invalid records without name guessing: %j', (value) => {
    expect(mcpCallFromEvent(value)).toBeNull();
  });
});

describe('bounded MCP log reconciliation', () => {
  it('stores only observed identity and checks ownership after reading', async () => {
    const { deps, capture } = fixture();
    await capture.tick();
    expect(deps.usage.recordObserved).toHaveBeenCalledWith({
      featureId: 'f', sessionId: 's', provider: 'agency', server: 'ado',
      callId: '["s","call-1"]', origin: 'unknown', scope: 'feature', recordedAt: timestamp,
    });
    await capture.tick();
    expect(deps.reader.read).toHaveBeenLastCalledWith('s', { offset: 42, skipping: false }, 4096);
    expect(deps.owners.list).toHaveBeenLastCalledWith('', 2);
  });
  it('pages sources, wraps the scan, and bounds the cursor cache', async () => {
    const { deps, capture } = fixture({ maxCachedSources: 1, sourcesPerTick: 1 });
    await capture.tick();
    vi.mocked(deps.owners.list).mockReturnValueOnce([{ key: 'copilot:b', provider: 'copilot', sessionId: 'b' }]);
    await capture.tick();
    expect(deps.owners.list).toHaveBeenLastCalledWith('agency:s', 1);
    await capture.tick();
    expect(deps.reader.read).toHaveBeenLastCalledWith('s', { offset: 0, skipping: false }, 4096);
    vi.mocked(deps.owners.list).mockReturnValueOnce([]);
    await capture.tick();
    await capture.tick();
    expect(deps.owners.list).toHaveBeenLastCalledWith('', 1);
  });
  it('reports malformed, oversized and removed/ambiguous owners without retaining content', async () => {
    const { deps, capture } = fixture();
    vi.mocked(deps.reader.read).mockResolvedValue({ ...page(['secret-invalid-json', '{}', JSON.stringify(event())]), oversized: true });
    vi.mocked(deps.owners.resolve).mockReturnValue(null);
    await capture.tick();
    expect(deps.usage.recordObserved).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith('MCP usage log capture is partial', {
      source: 'agency:s', oversized: true, malformed: 1, unattributed: 1,
    });
    expect(JSON.stringify(vi.mocked(deps.logger.warn).mock.calls)).not.toContain('secret');
  });
  it.each(['oversized', 'malformed', 'unattributed'])('reports each partial source independently: %s', async (kind) => {
    const { deps, capture } = fixture();
    vi.mocked(deps.reader.read).mockResolvedValue({
      ...page(kind === 'malformed' ? ['bad json'] : [JSON.stringify(event())]),
      oversized: kind === 'oversized',
    });
    if (kind === 'unattributed') vi.mocked(deps.owners.resolve).mockReturnValue(null);
    await capture.tick();
    expect(deps.logger.warn).toHaveBeenCalledOnce();
  });
  it('warns once per partial source until it reads cleanly, then re-arms', async () => {
    const { deps, capture } = fixture();
    const oversized = { ...page([JSON.stringify(event())]), oversized: true };
    vi.mocked(deps.reader.read)
      .mockResolvedValueOnce(oversized) // enters partial -> warns
      .mockResolvedValueOnce(oversized) // still partial -> suppressed
      .mockResolvedValueOnce(page()) // clean read -> re-arms
      .mockResolvedValueOnce(oversized); // partial again -> warns
    await capture.tick();
    await capture.tick();
    await capture.tick();
    await capture.tick();
    const partialWarnings = vi.mocked(deps.logger.warn).mock.calls
      .filter(([message]) => message === 'MCP usage log capture is partial');
    expect(partialWarnings).toHaveLength(2);
  });
  it('retries from the last checkpoint after a sink failure, allowing durable deduplication', async () => {
    const { deps, capture } = fixture();
    vi.mocked(deps.usage.recordObserved).mockImplementationOnce(() => { throw new Error('secret'); });
    await capture.tick();
    await capture.tick();
    expect(deps.reader.read).toHaveBeenLastCalledWith('s', { offset: 0, skipping: false }, 4096);
    expect(deps.usage.recordObserved).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(deps.logger.warn).mock.calls)).not.toContain('secret');
  });
  it('logs source enumeration failures and remains retryable', async () => {
    const { deps, capture } = fixture();
    vi.mocked(deps.owners.list).mockImplementationOnce(() => { throw new Error('failure'); });
    await capture.tick();
    expect(deps.logger.warn).toHaveBeenCalledWith('MCP usage source enumeration failed; capture will retry');
    await capture.tick();
    expect(deps.usage.recordObserved).toHaveBeenCalledOnce();
  });
  it('does not overlap ticks or write after shutdown during IO', async () => {
    const { deps, capture } = fixture();
    let resolve!: (value: McpLogPage) => void;
    vi.mocked(deps.reader.read).mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = capture.tick();
    await capture.tick();
    expect(deps.reader.read).toHaveBeenCalledOnce();
    capture.stop();
    resolve(page());
    await pending;
    await capture.tick();
    expect(deps.usage.recordObserved).not.toHaveBeenCalled();
  });
  it('stops before reading the next source', async () => {
    const { deps, capture } = fixture();
    vi.mocked(deps.owners.list).mockImplementation(() => {
      capture.stop();
      return [{ key: 'a', provider: 'agency', sessionId: 's' }];
    });
    await capture.tick();
    expect(deps.reader.read).not.toHaveBeenCalled();
  });
});

describe('MCP usage limits', () => {
  it('exposes bounded defaults', () => {
    expect(MCP_USAGE_NAMESPACE).toBe('mcpUsage');
    expect(mcpUsageConfigSchema.parse(mcpUsageDefaults)).toEqual(mcpUsageDefaults);
  });
  it.each([
    { pollIntervalMs: 0 }, { pollIntervalMs: 60001 }, { sourcesPerTick: 0 },
    { sourcesPerTick: 17 }, { bytesPerSource: 4095 }, { bytesPerSource: 1048577 },
    { maxCachedSources: 15 }, { maxCachedSources: 10001 },
  ])('rejects invalid limits %j', (values) => {
    expect(() => mcpUsageConfigSchema.parse({ ...mcpUsageDefaults, ...values })).toThrow();
  });
});

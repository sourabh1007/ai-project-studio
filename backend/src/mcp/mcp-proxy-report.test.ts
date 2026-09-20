import { describe, it, expect, vi } from 'vitest';
import {
  buildMcpUsageReport,
  postMcpUsage,
  MCP_USAGE_ENDPOINT,
} from './mcp-proxy-report.js';

const snapshot = { calls: 3, inputBytes: 100, outputBytes: 200, durationMs: 40 };

const fullEnv = {
  STUDIO_FEATURE_ID: 'f1',
  STUDIO_SESSION_ID: 's1',
  STUDIO_MCP_SERVER: 'filesystem',
  STUDIO_MCP_PROVIDER: 'copilot',
  STUDIO_API_BASE: 'http://127.0.0.1:9/api',
  STUDIO_CONTROL_TOKEN: 'secret',
};

describe('buildMcpUsageReport', () => {
  it('builds a report from env and snapshot', () => {
    expect(buildMcpUsageReport(fullEnv, snapshot)).toEqual({
      provider: 'copilot',
      server: 'filesystem',
      featureId: 'f1',
      sessionId: 's1',
      calls: 3,
      inputBytes: 100,
      outputBytes: 200,
      durationMs: 40,
    });
  });

  it('returns null when attribution is missing', () => {
    expect(buildMcpUsageReport({ ...fullEnv, STUDIO_FEATURE_ID: '' }, snapshot)).toBeNull();
    expect(buildMcpUsageReport({ ...fullEnv, STUDIO_MCP_SERVER: undefined }, snapshot)).toBeNull();
    expect(buildMcpUsageReport({ ...fullEnv, STUDIO_MCP_PROVIDER: '  ' }, snapshot)).toBeNull();
  });

  it('returns null when nothing happened', () => {
    expect(
      buildMcpUsageReport(fullEnv, { calls: 0, inputBytes: 0, outputBytes: 0, durationMs: 0 }),
    ).toBeNull();
  });

  it('allows a null session id', () => {
    const report = buildMcpUsageReport({ ...fullEnv, STUDIO_SESSION_ID: undefined }, snapshot);
    expect(report?.sessionId).toBeNull();
  });
});

describe('postMcpUsage', () => {
  it('posts the report to the control endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const ok = await postMcpUsage(fetchImpl as unknown as typeof fetch, fullEnv, snapshot);
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://127.0.0.1:9/api${MCP_USAGE_ENDPOINT}`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-studio-control-token': 'secret' }),
      }),
    );
  });

  it('skips posting when the report cannot be built', async () => {
    const fetchImpl = vi.fn();
    const ok = await postMcpUsage(
      fetchImpl as unknown as typeof fetch,
      { ...fullEnv, STUDIO_FEATURE_ID: '' },
      snapshot,
    );
    expect(ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('swallows fetch failures', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
    const ok = await postMcpUsage(fetchImpl as unknown as typeof fetch, fullEnv, snapshot);
    expect(ok).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  checkStudioApiAvailability,
  studioMcpMissingConfigMessage,
  studioMcpUnavailableMessage,
} from './studio-mcp-startup.js';
import { STUDIO_CONTROL_TOKEN_HEADER } from './studio-mcp-tools.js';

function response(status: number, body: unknown) {
  return {
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe('Studio MCP startup diagnostics', () => {
  it('accepts the authenticated current Studio bridge health endpoint', async () => {
    const fetchImpl = vi.fn(async () => response(200, { status: 'ok', server: 'ai-project-studio' }));
    await expect(checkStudioApiAvailability({
      apiBase: 'http://127.0.0.1:60000/api/',
      controlToken: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 123,
    })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:60000/api/mcp/bridge-health', {
      headers: { [STUDIO_CONTROL_TOKEN_HEADER]: 'secret' },
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    response(401, { status: 'ok', server: 'ai-project-studio' }),
    response(200, { status: 'ok', server: 'other' }),
    response(200, null),
  ])('returns the actionable Studio-down message for unverified health %j', async (badResponse) => {
    const result = await checkStudioApiAvailability({
      apiBase: 'http://127.0.0.1:9/api',
      controlToken: 'secret',
      fetch: vi.fn(async () => badResponse) as unknown as typeof fetch,
      timeoutMs: 100,
    });
    expect(result).toEqual({ ok: false, message: studioMcpUnavailableMessage('http://127.0.0.1:9/api') });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('returns the same actionable message when the request fails or JSON is malformed', async () => {
    await expect(checkStudioApiAvailability({
      apiBase: 'http://127.0.0.1:63043/api',
      controlToken: 'secret',
      fetch: vi.fn(async () => { throw new Error('ECONNREFUSED secret'); }) as unknown as typeof fetch,
      timeoutMs: 100,
    })).resolves.toEqual({ ok: false, message: studioMcpUnavailableMessage('http://127.0.0.1:63043/api') });

    const malformed = { status: 200, json: vi.fn(async () => { throw new Error('bad json'); }) } as unknown as Response;
    await expect(checkStudioApiAvailability({
      apiBase: 'http://127.0.0.1:63043/api',
      controlToken: 'secret',
      fetch: vi.fn(async () => malformed) as unknown as typeof fetch,
      timeoutMs: 100,
    })).resolves.toEqual({ ok: false, message: studioMcpUnavailableMessage('http://127.0.0.1:63043/api') });
  });

  it('explains missing launch configuration without throwing an opaque Node stack', () => {
    expect(studioMcpMissingConfigMessage()).toContain('STUDIO_API_BASE or STUDIO_CONTROL_TOKEN');
    expect(studioMcpMissingConfigMessage()).toContain('remove the "ai-project-studio" entry');
  });
});

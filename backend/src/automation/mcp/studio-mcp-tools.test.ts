import { describe, expect, it, vi } from 'vitest';
import {
  STUDIO_CONTROL_TOKEN_HEADER,
  asToolResult,
  createStudioApiClient,
  envOrigin,
  createStudioMcpToolHandlers,
  registerStudioMcpTools,
  type StudioApiRequest,
  type ToolRegistrar,
} from './studio-mcp-tools.js';

function response(body: string, init: ResponseInit = { status: 200 }): Response {
  return new Response(body, init);
}

describe('createStudioApiClient', () => {
  it('builds authenticated JSON requests and parses JSON responses', async () => {
    const fetchMock = vi.fn(async () => response('{"ok":true}'));
    const client = createStudioApiClient({
      baseUrl: 'http://127.0.0.1:4319/api/',
      controlToken: 'token',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      client.request({
        method: 'POST',
        path: '/automations',
        body: { name: 'Monitor' },
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4319/api/automations',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          [STUDIO_CONTROL_TOKEN_HEADER]: 'token',
        },
        body: '{"name":"Monitor"}',
      },
    );
  });

  it('omits the body for GET requests and returns null for empty responses', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      response(''),
    );
    const client = createStudioApiClient({
      baseUrl: 'http://x/api',
      controlToken: 'token',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      client.request({ method: 'GET', path: '/automations' }),
    ).resolves.toBeNull();
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it('throws on non-ok responses', async () => {
    const fetchMock = vi.fn(async () =>
      response('{"error":"bad"}', { status: 400 }),
    );
    const client = createStudioApiClient({
      baseUrl: 'http://x/api',
      controlToken: 'token',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      client.request({ method: 'POST', path: '/automations', body: {} }),
    ).rejects.toThrow(/Studio API 400/);
  });
});

describe('createStudioMcpToolHandlers', () => {
  it('builds a default origin from Studio session environment variables', () => {
    expect(
      envOrigin({ STUDIO_SESSION_ID: ' s1 ', STUDIO_FEATURE_ID: ' f1 ' }),
    ).toEqual({ sessionId: 's1', featureId: 'f1' });
    expect(envOrigin({ STUDIO_SESSION_ID: '', STUDIO_FEATURE_ID: 'f1' })).toEqual(
      { sessionId: null, featureId: 'f1' },
    );
    expect(envOrigin({})).toBeUndefined();
  });

  it('maps each tool to the expected Studio API request', async () => {
    const requests: StudioApiRequest[] = [];
    const handlers = createStudioMcpToolHandlers({
      request: async (input) => {
        requests.push(input);
        return { ok: true };
      },
    }, { sessionId: 's1', featureId: 'f1' });
    const step = { id: 's1', label: 'Start', status: 'pending' as const, detail: null };
    await handlers.createMonitor({
      name: 'Monitor',
      mode: 'short',
      check: { type: 'ai', prompt: 'ready?' },
      condition: { type: 'always' },
      action: { type: 'report', prompt: 'summarize' },
    });
    await handlers.updateMonitorProgress({ id: 'a/b', progress: 'working' });
    await handlers.setPlannedSteps({ automationId: 'a b', steps: [step] });
    await handlers.registerSubagent({
      automationId: 'a1',
      task: 'Task',
      origin: { sessionId: 's1' },
    });
    await handlers.updateSubagentProgress({ id: 'g/1', progress: 'done' });
    await handlers.listAutomations({});
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/automations',
        body: {
          name: 'Monitor',
          mode: 'short',
          check: { type: 'ai', prompt: 'ready?' },
          condition: { type: 'always' },
          action: { type: 'report', prompt: 'summarize' },
          origin: { sessionId: 's1', featureId: 'f1' },
        },
      },
      {
        method: 'POST',
        path: '/automations/a%2Fb/progress',
        body: { progress: 'working' },
      },
      {
        method: 'POST',
        path: '/automations/a%20b/planned-steps',
        body: { steps: [step] },
      },
      {
        method: 'POST',
        path: '/automations/a1/subagents',
        body: { task: 'Task', origin: { sessionId: 's1' } },
      },
      {
        method: 'POST',
        path: '/subagents/g%2F1/progress',
        body: { progress: 'done' },
      },
      { method: 'GET', path: '/automations' },
    ]);
  });

  it('preserves an explicit monitor origin over the default', async () => {
    const requests: StudioApiRequest[] = [];
    const handlers = createStudioMcpToolHandlers(
      {
        request: async (input) => {
          requests.push(input);
          return { ok: true };
        },
      },
      { sessionId: 'default-session', featureId: 'default-feature' },
    );
    await handlers.createMonitor({
      name: 'Monitor',
      mode: 'long',
      origin: { sessionId: 's1' },
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'always' },
      action: { type: 'report', prompt: 'go' },
    });
    expect(requests[0]?.body).toMatchObject({
      origin: { sessionId: 's1' },
    });
  });
});

describe('registerStudioMcpTools', () => {
  it('registers all tools and wraps handler output as MCP text content', async () => {
    const registered = new Map<
      string,
      (args: Record<string, unknown>) => Promise<unknown>
    >();
    const server: ToolRegistrar = {
      registerTool: (name, config, cb) => {
        expect(config.description.length).toBeGreaterThan(0);
        expect(config.inputSchema).toBeDefined();
        registered.set(name, cb);
      },
    };
    registerStudioMcpTools(server, {
      request: async (input) => ({ path: input.path }),
    });
    expect([...registered.keys()]).toEqual([
      'create_monitor',
      'update_monitor_progress',
      'set_planned_steps',
      'register_subagent',
      'update_subagent_progress',
      'list_automations',
    ]);
    await expect(
      registered.get('create_monitor')!({
        name: 'M',
        mode: 'long',
        check: {},
        condition: {},
        action: {},
      }),
    ).resolves.toEqual(asToolResult({ path: '/automations' }));
    await expect(
      registered.get('update_monitor_progress')!({
        id: 'a1',
        progress: 'p',
      }),
    ).resolves.toEqual(asToolResult({ path: '/automations/a1/progress' }));
    await expect(
      registered.get('set_planned_steps')!({
        automationId: 'a1',
        steps: [],
      }),
    ).resolves.toEqual(asToolResult({ path: '/automations/a1/planned-steps' }));
    await expect(
      registered.get('register_subagent')!({
        automationId: 'a1',
        task: 't',
        origin: {},
      }),
    ).resolves.toEqual(asToolResult({ path: '/automations/a1/subagents' }));
    await expect(
      registered.get('update_subagent_progress')!({
        id: 'g1',
        progress: 'p',
      }),
    ).resolves.toEqual(asToolResult({ path: '/subagents/g1/progress' }));
    await expect(registered.get('list_automations')!({})).resolves.toEqual(
      asToolResult({ path: '/automations' }),
    );
  });
});

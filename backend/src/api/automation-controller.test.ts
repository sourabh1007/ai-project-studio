import { describe, it, expect, vi } from 'vitest';
import { createAutomationRoutes } from './automation-controller.js';
import type { AutomationService } from '../automation/automation-service.js';
import type { SubagentService } from '../automation/subagent-service.js';
import type { Route } from './http-contract.js';

function routeMap(routes: Route[]): Map<string, Route> {
  return new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
}

const sampleBody = {
  name: 'Watch CI',
  mode: 'long',
  check: { type: 'shell', command: 'echo' },
  condition: { type: 'exit-code', equals: 0 },
  action: { type: 'report', prompt: 'go' },
};

function services() {
  const automations = {
    list: vi.fn(() => ['A']),
    get: vi.fn(() => 'one'),
    listRuns: vi.fn(() => ['run']),
    create: vi.fn((input) => ({ created: input })),
    pause: vi.fn(() => 'paused'),
    resume: vi.fn(() => 'resumed'),
    cancel: vi.fn(() => 'cancelled'),
    runNow: vi.fn(() => 'ran'),
    updateProgress: vi.fn(() => 'automation-progress'),
    setPlannedSteps: vi.fn(() => 'planned'),
    remove: vi.fn(),
  } as unknown as AutomationService & Record<string, ReturnType<typeof vi.fn>>;
  const subagents = {
    list: vi.fn(() => ['G']),
    listByAutomation: vi.fn(() => ['g1']),
    register: vi.fn(() => 'registered'),
    updateProgress: vi.fn(() => 'subagent-progress'),
    complete: vi.fn(() => 'completed'),
    fail: vi.fn(() => 'failed'),
  } as unknown as SubagentService & Record<string, ReturnType<typeof vi.fn>>;
  return { automations, subagents };
}

describe('createAutomationRoutes', () => {
  it('lists automations and subagents', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get('get /automations')!.handler({
      params: {},
      query: {},
      body: undefined,
    });
    expect(res).toEqual({
      status: 200,
      body: { automations: ['A'], subagents: ['G'] },
    });
  });

  it('reads one automation with its runs and subagents', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get('get /automations/:id')!.handler({
      params: { id: 'a1' },
      query: {},
      body: undefined,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      automation: 'one',
      runs: ['run'],
      subagents: ['g1'],
    });
    expect(automations.get).toHaveBeenCalledWith('a1');
    expect(subagents.listByAutomation).toHaveBeenCalledWith('a1');
  });

  it('creates an automation from a validated body', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get('post /automations')!.handler({
      params: {},
      query: {},
      body: sampleBody,
    });
    expect(res.status).toBe(201);
    expect(automations.create).toHaveBeenCalledTimes(1);
  });

  it('requires the control token when configured', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(
      createAutomationRoutes({
        automations,
        subagents,
        controlToken: 'secret',
      }),
    );
    await expect(
      routes.get('post /automations')!.handler({
        params: {},
        query: {},
        body: sampleBody,
      }),
    ).rejects.toThrow(/control token/);
    const res = await routes.get('post /automations')!.handler({
      params: {},
      query: {},
      headers: { 'x-studio-control-token': 'secret' },
      body: sampleBody,
    });
    expect(res.status).toBe(201);
  });

  it('rejects an invalid create body', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    await expect(
      routes.get('post /automations')!.handler({
        params: {},
        query: {},
        body: { name: '' },
      }),
    ).rejects.toThrow();
  });

  it.each([
    ['post /automations/:id/pause', 'pause'],
    ['post /automations/:id/resume', 'resume'],
    ['post /automations/:id/cancel', 'cancel'],
    ['post /automations/:id/run', 'runNow'],
  ])('drives lifecycle route %s', async (signature, method) => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get(signature)!.handler({
      params: { id: 'a1' },
      query: {},
      body: undefined,
    });
    expect(res.status).toBe(200);
    expect(automations[method]).toHaveBeenCalledWith('a1');
  });

  it('updates automation progress', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get('post /automations/:id/progress')!.handler({
      params: { id: 'a1' },
      query: {},
      body: { progress: 'half done' },
    });
    expect(res).toEqual({ status: 200, body: 'automation-progress' });
    expect(automations.updateProgress).toHaveBeenCalledWith('a1', 'half done');
  });

  it('sets automation planned steps', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const steps = [
      { id: 's1', label: 'Start', status: 'active', detail: null },
    ];
    const res = await routes.get('post /automations/:id/planned-steps')!.handler({
      params: { id: 'a1' },
      query: {},
      body: { steps },
    });
    expect(res).toEqual({ status: 200, body: 'planned' });
    expect(automations.setPlannedSteps).toHaveBeenCalledWith('a1', steps);
  });

  it('registers a subagent under an automation', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get('post /automations/:id/subagents')!.handler({
      params: { id: 'a1' },
      query: {},
      body: { task: 'Investigate', origin: { sessionId: 's1' } },
    });
    expect(res).toEqual({ status: 201, body: 'registered' });
    expect(subagents.register).toHaveBeenCalledWith({
      task: 'Investigate',
      origin: { sessionId: 's1', featureId: null },
      automationId: 'a1',
    });
  });

  it.each([
    ['post /subagents/:id/progress', 'updateProgress', { progress: 'working' }],
    ['post /subagents/:id/complete', 'complete', { result: 'done' }],
    ['post /subagents/:id/fail', 'fail', { error: 'boom' }],
  ])('drives subagent route %s', async (signature, method, body) => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get(signature)!.handler({
      params: { id: 'g1' },
      query: {},
      body,
    });
    expect(res.status).toBe(200);
    expect(subagents[method]).toHaveBeenCalledWith(
      'g1',
      Object.values(body)[0],
    );
  });

  it('deletes an automation and returns its id', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get('delete /automations/:id')!.handler({
      params: { id: 'a1' },
      query: {},
      body: undefined,
    });
    expect(res).toEqual({ status: 200, body: { id: 'a1' } });
    expect(automations.remove).toHaveBeenCalledWith('a1');
  });
});

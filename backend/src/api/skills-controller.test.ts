import { describe, it, expect } from 'vitest';
import { createSkillsRoutes } from './skills-controller.js';
import type { SkillsService } from '../skills/skills-service.js';
import type { Skill, SkillAttachment } from '../skills/skills-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`route ${method} ${path} not found`);
  }
  return route.handler;
}

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

const skill: Skill = {
  id: 'k1',
  name: 'Testing',
  kind: 'instruction',
  instructions: 'Write tests.',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const attachment: SkillAttachment = {
  id: 'a1',
  skillId: 'k1',
  scope: 'feature',
  targetId: 'f1',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function harness(injectSessionSkill?: (sessionId: string, skillId: string) => void) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, ...args: unknown[]) => {
    calls[name] = args;
  };
  const skills = {
    listSkills: () => (record('listSkills'), [skill]),
    createSkill: (input: unknown) => (record('createSkill', input), skill),
    getSkill: (id: string) => (record('getSkill', id), skill),
    updateSkill: (id: string, input: unknown) => (
      record('updateSkill', id, input), skill
    ),
    deleteSkill: (id: string) => record('deleteSkill', id),
    tag: (input: unknown) => (record('tag', input), attachment),
    untag: (id: string) => record('untag', id),
    listForFeature: (id: string) => (record('listForFeature', id), [skill]),
    listForSession: (id: string) => (record('listForSession', id), [skill]),
    exportSkill: (id: string) => (record('exportSkill', id), { name: 'A' }),
    exportAll: () => (record('exportAll'), [{ name: 'A' }]),
    importSkill: (payload: unknown) => (record('importSkill', payload), skill),
  } as unknown as SkillsService;
  return {
    routes: createSkillsRoutes({ skills, injectSessionSkill }),
    calls,
  };
}

describe('skills-controller', () => {
  it('lists skills', async () => {
    const { routes } = harness();
    expect(await pick(routes, 'get', '/skills')(req())).toEqual({
      status: 200,
      body: [skill],
    });
  });

  it('creates a skill', async () => {
    const { routes, calls } = harness();
    const body = { name: 'A', kind: 'instruction', instructions: 'x' };
    const result = await pick(routes, 'post', '/skills')(req({ body }));
    expect(result).toEqual({ status: 201, body: skill });
    expect(calls.createSkill).toEqual([body]);
  });

  it('rejects an invalid create payload', () => {
    const { routes } = harness();
    expect(() =>
      pick(routes, 'post', '/skills')(req({ body: { name: '' } })),
    ).toThrow();
  });

  it('gets a skill', async () => {
    const { routes, calls } = harness();
    const result = await pick(routes, 'get', '/skills/:id')(
      req({ params: { id: 'k1' } }),
    );
    expect(result).toEqual({ status: 200, body: skill });
    expect(calls.getSkill).toEqual(['k1']);
  });

  it('updates a skill', async () => {
    const { routes, calls } = harness();
    const body = { name: 'B', instructions: 'y' };
    const result = await pick(routes, 'put', '/skills/:id')(
      req({ params: { id: 'k1' }, body }),
    );
    expect(result).toEqual({ status: 200, body: skill });
    expect(calls.updateSkill).toEqual(['k1', body]);
  });

  it('rejects an invalid update payload', () => {
    const { routes } = harness();
    expect(() =>
      pick(routes, 'put', '/skills/:id')(req({ params: { id: 'k1' }, body: {} })),
    ).toThrow();
  });

  it('deletes a skill', async () => {
    const { routes, calls } = harness();
    const result = await pick(routes, 'delete', '/skills/:id')(
      req({ params: { id: 'k1' } }),
    );
    expect(result).toEqual({ status: 200, body: { id: 'k1' } });
    expect(calls.deleteSkill).toEqual(['k1']);
  });

  it('tags a skill to a target', async () => {
    const { routes, calls } = harness();
    const body = { scope: 'feature', targetId: 'f1' };
    const result = await pick(routes, 'post', '/skills/:id/attachments')(
      req({ params: { id: 'k1' }, body }),
    );
    expect(result).toEqual({ status: 201, body: attachment });
    expect(calls.tag).toEqual([{ skillId: 'k1', scope: 'feature', targetId: 'f1' }]);
  });

  it('injects a session-scoped skill into its live terminal on tag', async () => {
    const injected: Array<[string, string]> = [];
    const { routes } = harness((sessionId, skillId) =>
      injected.push([sessionId, skillId]),
    );
    await pick(routes, 'post', '/skills/:id/attachments')(
      req({ params: { id: 'k1' }, body: { scope: 'session', targetId: 's1' } }),
    );
    expect(injected).toEqual([['s1', 'k1']]);
  });

  it('does not inject when a skill is tagged to a feature', async () => {
    const injected: Array<[string, string]> = [];
    const { routes } = harness((sessionId, skillId) =>
      injected.push([sessionId, skillId]),
    );
    await pick(routes, 'post', '/skills/:id/attachments')(
      req({ params: { id: 'k1' }, body: { scope: 'feature', targetId: 'f1' } }),
    );
    expect(injected).toEqual([]);
  });

  it('tags a session skill without an injector configured', async () => {
    const { routes } = harness();
    const result = await pick(routes, 'post', '/skills/:id/attachments')(
      req({ params: { id: 'k1' }, body: { scope: 'session', targetId: 's1' } }),
    );
    expect(result).toEqual({ status: 201, body: attachment });
  });

  it('rejects an invalid tag payload', () => {
    const { routes } = harness();
    expect(() =>
      pick(routes, 'post', '/skills/:id/attachments')(
        req({ params: { id: 'k1' }, body: { scope: 'nope', targetId: 'f1' } }),
      ),
    ).toThrow();
  });

  it('untags an attachment', async () => {
    const { routes, calls } = harness();
    const result = await pick(routes, 'delete', '/skills/attachments/:attachmentId')(
      req({ params: { attachmentId: 'a1' } }),
    );
    expect(result).toEqual({ status: 200, body: { id: 'a1' } });
    expect(calls.untag).toEqual(['a1']);
  });

  it('lists skills for a feature and a session', async () => {
    const { routes } = harness();
    expect(
      await pick(routes, 'get', '/features/:featureId/skills')(
        req({ params: { featureId: 'f1' } }),
      ),
    ).toEqual({ status: 200, body: [skill] });
    expect(
      await pick(routes, 'get', '/sessions/:sessionId/skills')(
        req({ params: { sessionId: 's1' } }),
      ),
    ).toEqual({ status: 200, body: [skill] });
  });

  it('exports one skill and all skills', async () => {
    const { routes } = harness();
    expect(
      await pick(routes, 'get', '/skills/:id/export')(req({ params: { id: 'k1' } })),
    ).toEqual({ status: 200, body: { name: 'A' } });
    expect(await pick(routes, 'get', '/skills/export')(req())).toEqual({
      status: 200,
      body: [{ name: 'A' }],
    });
  });

  it('imports a skill', async () => {
    const { routes, calls } = harness();
    const body = { schemaVersion: 1, name: 'A', kind: 'instruction', instructions: 'x' };
    const result = await pick(routes, 'post', '/skills/import')(req({ body }));
    expect(result).toEqual({ status: 201, body: skill });
    expect(calls.importSkill).toEqual([body]);
  });
});

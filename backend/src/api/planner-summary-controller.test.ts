import { describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from './http-contract.js';
import { createPlannerSummaryRoutes } from './planner-summary-controller.js';

function request(partial: Partial<HttpRequest>): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...partial };
}

describe('createPlannerSummaryRoutes', () => {
  it('exposes a POST /planner/summary route', () => {
    const routes = createPlannerSummaryRoutes({
      plannerSummarizer: { summarize: vi.fn() },
    });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'post', path: '/planner/summary' });
  });

  it('summarizes with the parsed scope, date, and prompt', async () => {
    const summarize = vi.fn(async () => ({
      scope: 'day' as const,
      date: '2026-02-10',
      range: '2026-02-10',
      content: 'summary',
      taskCount: 2,
      createdAt: '2026-02-11T00:00:00.000Z',
    }));
    const signal = AbortSignal.abort();
    const [route] = createPlannerSummaryRoutes({
      plannerSummarizer: { summarize },
    });
    const result = await route.handler(
      request({
        body: { scope: 'day', date: '2026-02-10', prompt: 'overview' },
        signal,
      }),
    );
    expect(summarize).toHaveBeenCalledWith({
      scope: 'day',
      date: '2026-02-10',
      prompt: 'overview',
      signal,
    });
    expect(result).toEqual({
      status: 200,
      body: {
        scope: 'day',
        date: '2026-02-10',
        range: '2026-02-10',
        content: 'summary',
        taskCount: 2,
        createdAt: '2026-02-11T00:00:00.000Z',
      },
    });
  });

  it('defaults the prompt to an empty string when omitted', async () => {
    const summarize = vi.fn(async () => ({
      scope: 'month' as const,
      date: '2026-02-10',
      range: '2026-02',
      content: 'c',
      taskCount: 0,
      createdAt: 'now',
    }));
    const [route] = createPlannerSummaryRoutes({
      plannerSummarizer: { summarize },
    });
    await route.handler(request({ body: { scope: 'month', date: '2026-02-10' } }));
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '' }),
    );
  });

  it('rejects an invalid scope', async () => {
    const [route] = createPlannerSummaryRoutes({
      plannerSummarizer: { summarize: vi.fn() },
    });
    await expect(
      route.handler(request({ body: { scope: 'decade', date: '2026-02-10' } })),
    ).rejects.toThrow();
  });
});

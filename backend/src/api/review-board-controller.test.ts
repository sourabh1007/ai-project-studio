import { describe, expect, it, vi } from 'vitest';
import { createReviewBoardRoutes } from './review-board-controller.js';
import type { HttpRequest, HttpResult, Route } from './http-contract.js';
import { ValidationError } from '../kernel/error-types.js';
import type {
  ReviewBoard,
  ReviewBoardService,
} from '../review-board/review-board-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`route ${method} ${path} not found`);
  return route.handler;
}

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

const board = { featureId: 'f1' } as ReviewBoard;

function service(overrides: Partial<ReviewBoardService> = {}): ReviewBoardService {
  return {
    get: (id) => ({ ...board, featureId: id }),
    analyze: vi.fn(async (id) => ({ ...board, featureId: id })),
    analyzePerspective: vi.fn(async (_id, perspectiveId) => ({
      perspectiveId,
      perspective: { id: perspectiveId } as never,
      skipped: false,
      skipReason: null,
      summary: null,
      rationale: [],
      checks: [],
    })),
    chat: vi.fn(async () => ({ answer: 'ok', ratingChange: null })),
    ...overrides,
  };
}

describe('createReviewBoardRoutes', () => {
  it('returns the derived board for a feature', () => {
    const routes = createReviewBoardRoutes({ reviewBoard: service() });
    const handler = pick(routes, 'get', '/features/:featureId/review-board');
    const res = handler(req({ params: { featureId: 'abc' } })) as HttpResult;
    expect(res.status).toBe(200);
    expect((res.body as ReviewBoard).featureId).toBe('abc');
  });

  it('runs the AI analysis and returns the enriched board', async () => {
    const analyze = vi.fn(async (id: string) => ({ ...board, featureId: id }));
    const routes = createReviewBoardRoutes({ reviewBoard: service({ analyze }) });
    const handler = pick(
      routes,
      'post',
      '/features/:featureId/review-board/analyze',
    );
    const res = await handler(req({ params: { featureId: 'abc' } }));
    expect(res.status).toBe(200);
    expect(analyze).toHaveBeenCalledWith('abc');
    expect((res.body as ReviewBoard).featureId).toBe('abc');
  });

  it('routes a per-perspective analysis to the service', async () => {
    const analyzePerspective = vi.fn(async (_id: string, pid: string) => ({
      perspectiveId: pid,
      perspective: { id: pid } as never,
      skipped: true,
      skipReason: 'n/a',
      summary: null,
      rationale: [],
      checks: [],
    }));
    const routes = createReviewBoardRoutes({
      reviewBoard: service({ analyzePerspective }),
    });
    const handler = pick(
      routes,
      'post',
      '/features/:featureId/review-board/perspectives/:perspectiveId/analyze',
    );
    const res = await handler(
      req({ params: { featureId: 'abc', perspectiveId: 'security' } }),
    );
    expect(res.status).toBe(200);
    expect(analyzePerspective).toHaveBeenCalledWith('abc', 'security');
    expect((res.body as { skipped: boolean }).skipped).toBe(true);
  });

  it('routes a chat turn to the agent with a perspective', async () => {
    const chat = vi.fn(async () => ({ answer: 'because', ratingChange: null }));
    const routes = createReviewBoardRoutes({ reviewBoard: service({ chat }) });
    const handler = pick(
      routes,
      'post',
      '/features/:featureId/review-board/chat',
    );
    const res = await handler(
      req({
        params: { featureId: 'abc' },
        body: {
          perspectiveId: 'security',
          messages: [{ role: 'user', content: 'why?' }],
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(chat).toHaveBeenCalledWith(
      'abc',
      'security',
      [{ role: 'user', content: 'why?' }],
      null,
    );
    expect((res.body as { answer: string }).answer).toBe('because');
  });

  it('forwards the analysed-perspective context to the agent', async () => {
    const chat = vi.fn(async () => ({ answer: 'line 42', ratingChange: null }));
    const routes = createReviewBoardRoutes({ reviewBoard: service({ chat }) });
    const handler = pick(
      routes,
      'post',
      '/features/:featureId/review-board/chat',
    );
    const context = {
      status: 'warning',
      risk: 'medium',
      findings: [
        {
          id: 'f1',
          perspectiveId: 'performance',
          title: 'Double materialization',
          detail: 'JObject parsed twice',
          severity: 'medium',
          status: 'warning',
          evidence: [
            { source: 'svc/heartbeat.cs', reason: 'r', confidence: 1, direct: true },
          ],
        },
      ],
    };
    await handler(
      req({
        params: { featureId: 'abc' },
        body: {
          perspectiveId: 'performance',
          messages: [{ role: 'user', content: 'where?' }],
          context,
        },
      }),
    );
    expect(chat).toHaveBeenCalledWith(
      'abc',
      'performance',
      [{ role: 'user', content: 'where?' }],
      context,
    );
  });

  it('drops a malformed chat context to null', async () => {
    const chat = vi.fn(async () => ({ answer: 'ok', ratingChange: null }));
    const routes = createReviewBoardRoutes({ reviewBoard: service({ chat }) });
    const handler = pick(
      routes,
      'post',
      '/features/:featureId/review-board/chat',
    );
    // status missing, findings not an array, and a non-object variant — each
    // path should fall back to null rather than reject.
    for (const bad of [
      { risk: 'low', findings: [] },
      { status: 'warning', risk: 'low', findings: 'nope' },
      'not-an-object',
      null,
    ]) {
      await handler(
        req({
          params: { featureId: 'abc' },
          body: {
            perspectiveId: 'security',
            messages: [{ role: 'user', content: 'hi' }],
            context: bad,
          },
        }),
      );
    }
    for (const call of chat.mock.calls) {
      expect((call as unknown[])[3]).toBeNull();
    }
  });

  it('defaults a missing/omitted perspectiveId to null', async () => {
    const chat = vi.fn(async () => ({ answer: 'ok', ratingChange: null }));
    const routes = createReviewBoardRoutes({ reviewBoard: service({ chat }) });
    const handler = pick(
      routes,
      'post',
      '/features/:featureId/review-board/chat',
    );
    await handler(
      req({
        params: { featureId: 'abc' },
        body: { messages: [{ role: 'user', content: 'hi' }] },
      }),
    );
    expect(chat).toHaveBeenCalledWith(
      'abc',
      null,
      [{ role: 'user', content: 'hi' }],
      null,
    );
  });

  it('accepts an explicit null perspectiveId', async () => {
    const chat = vi.fn(async () => ({ answer: 'ok', ratingChange: null }));
    const routes = createReviewBoardRoutes({ reviewBoard: service({ chat }) });
    const handler = pick(
      routes,
      'post',
      '/features/:featureId/review-board/chat',
    );
    await handler(
      req({
        params: { featureId: 'abc' },
        body: {
          perspectiveId: null,
          messages: [{ role: 'user', content: 'hi' }],
        },
      }),
    );
    expect(chat).toHaveBeenCalledWith(
      'abc',
      null,
      expect.any(Array),
      null,
    );
  });

  it('rejects a non-string perspectiveId', async () => {
    const routes = createReviewBoardRoutes({ reviewBoard: service() });
    const handler = pick(
      routes,
      'post',
      '/features/:featureId/review-board/chat',
    );
    await expect(
      handler(
        req({
          params: { featureId: 'abc' },
          body: { perspectiveId: 7, messages: [{ role: 'user', content: 'hi' }] },
        }),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects an empty messages array', async () => {
    const routes = createReviewBoardRoutes({ reviewBoard: service() });
    const handler = pick(
      routes,
      'post',
      '/features/:featureId/review-board/chat',
    );
    await expect(
      handler(req({ params: { featureId: 'abc' }, body: { messages: [] } })),
    ).rejects.toThrow('non-empty "messages"');
  });

  it('rejects a malformed message entry', async () => {
    const routes = createReviewBoardRoutes({ reviewBoard: service() });
    const handler = pick(
      routes,
      'post',
      '/features/:featureId/review-board/chat',
    );
    await expect(
      handler(
        req({
          params: { featureId: 'abc' },
          body: { messages: [{ role: 'system', content: 'x' }] },
        }),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects when the last message is not from the reviewer', async () => {
    const routes = createReviewBoardRoutes({ reviewBoard: service() });
    const handler = pick(
      routes,
      'post',
      '/features/:featureId/review-board/chat',
    );
    await expect(
      handler(
        req({
          params: { featureId: 'abc' },
          body: {
            messages: [
              { role: 'user', content: 'hi' },
              { role: 'assistant', content: 'hello' },
            ],
          },
        }),
      ),
    ).rejects.toThrow('last message must be from the reviewer');
  });
});

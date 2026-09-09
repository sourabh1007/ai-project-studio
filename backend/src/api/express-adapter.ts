import type { Request, Response, Router } from 'express';
import type { HttpHandler, Route } from './http-contract.js';
import { toErrorResult } from './http-error-mapper.js';

/**
 * Adapts a framework-agnostic {@link HttpHandler} to an Express handler,
 * translating thrown errors into HTTP responses via the error mapper.
 */
export function toExpressHandler(handler: HttpHandler) {
  return async (req: Request, res: Response): Promise<void> => {
    // Long AI routes must stop doing physical work when the caller goes away,
    // so the request lifecycle is published to handlers as an AbortSignal.
    // `close` fires for a normal end too, hence the writableEnded guard: only
    // a close *before* the reply was written means the client disconnected.
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const abortIfUnfinished = (): void => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', abortIfUnfinished);
    try {
      const result = await handler({
        params: req.params as unknown as Record<string, string>,
        query: req.query as unknown as Record<string, string | undefined>,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
      // Writing to a disconnected response throws ERR_STREAM_WRITE_AFTER_END
      // and would replace a real error with a misleading one.
      if (controller.signal.aborted) return;
      res.status(result.status).json(result.body);
    } catch (error) {
      if (controller.signal.aborted) return;
      const result = toErrorResult(error);
      res.status(result.status).json(result.body);
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', abortIfUnfinished);
    }
  };
}

/** Registers every route in the table onto an Express router. */
export function mountRoutes(router: Router, routes: Route[]): void {
  for (const route of routes) {
    router[route.method](route.path, toExpressHandler(route.handler));
  }
}

import type { Request, Response, Router } from 'express';
import type { HttpHandler, Route } from './http-contract.js';
import { toErrorResult } from './http-error-mapper.js';

/**
 * Adapts a framework-agnostic {@link HttpHandler} to an Express handler,
 * translating thrown errors into HTTP responses via the error mapper.
 */
export function toExpressHandler(handler: HttpHandler) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await handler({
        params: req.params as unknown as Record<string, string>,
        query: req.query as unknown as Record<string, string | undefined>,
        body: req.body,
      });
      res.status(result.status).json(result.body);
    } catch (error) {
      const result = toErrorResult(error);
      res.status(result.status).json(result.body);
    }
  };
}

/** Registers every route in the table onto an Express router. */
export function mountRoutes(router: Router, routes: Route[]): void {
  for (const route of routes) {
    router[route.method](route.path, toExpressHandler(route.handler));
  }
}

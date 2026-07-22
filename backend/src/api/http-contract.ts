/** Framework-agnostic HTTP contracts so controllers stay decoupled from Express. */

export type HttpMethod = 'get' | 'post' | 'put' | 'delete';

/** Normalized inbound request passed to a handler. */
export interface HttpRequest {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
}

/** Result a handler returns; the adapter serializes it to the transport. */
export interface HttpResult {
  status: number;
  body: unknown;
}

export type HttpHandler = (
  request: HttpRequest,
) => Promise<HttpResult> | HttpResult;

/** A single mountable route: method + path template + handler. */
export interface Route {
  method: HttpMethod;
  path: string;
  handler: HttpHandler;
}

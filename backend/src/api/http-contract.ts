/** Framework-agnostic HTTP contracts so controllers stay decoupled from Express. */
import type { ApplicationWorkScope } from '../lifecycle/application-work.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'delete';

/** Normalized inbound request passed to a handler. */
export interface HttpRequest {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  body: unknown;
  signal?: AbortSignal;
}

/** Result a handler returns; the adapter serializes it to the transport. */
export interface HttpResult {
  status: number;
  body: unknown;
}

export type HttpHandler = (
  request: HttpRequest,
) => Promise<HttpResult> | HttpResult;

export type HttpWorkScopeResolver = (
  request: HttpRequest,
) => ApplicationWorkScope | Promise<ApplicationWorkScope>;

/** A single mountable route: method + path template + handler. */
export interface Route {
  method: HttpMethod;
  path: string;
  handler: HttpHandler;
  workScope?: HttpWorkScopeResolver;
  workTrackScope?: HttpWorkScopeResolver;
  workAllowBlockedScope?: boolean;
}

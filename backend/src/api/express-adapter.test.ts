import { describe, it, expect } from 'vitest';
import type { Request, Response, Router } from 'express';
import { toExpressHandler, mountRoutes } from './express-adapter.js';
import { NotFoundError } from '../kernel/error-types.js';
import type { HttpHandler, Route } from './http-contract.js';

function fakeRes() {
  const res = {
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
    },
  };
  return res;
}

function fakeReq(): Request {
  return {
    params: { id: 'f1' },
    query: { q: 'x' },
    body: { name: 'Login' },
  } as unknown as Request;
}

describe('toExpressHandler', () => {
  it('serializes a successful result', async () => {
    const handler: HttpHandler = (req) => ({ status: 201, body: req.body });
    const res = fakeRes();
    await toExpressHandler(handler)(fakeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(201);
    expect(res.payload).toEqual({ name: 'Login' });
  });

  it('maps a thrown error to an HTTP response', async () => {
    const handler: HttpHandler = () => {
      throw new NotFoundError('missing');
    };
    const res = fakeRes();
    await toExpressHandler(handler)(fakeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(404);
    expect(res.payload).toEqual({
      error: { kind: 'not_found', message: 'missing' },
    });
  });
});

describe('mountRoutes', () => {
  it('registers each route by method and path', () => {
    const calls: Array<{ method: string; path: string; fn: unknown }> = [];
    const record = (method: string) => (path: string, fn: unknown) => {
      calls.push({ method, path, fn });
    };
    const router = {
      get: record('get'),
      post: record('post'),
    } as unknown as Router;

    const routes: Route[] = [
      { method: 'get', path: '/a', handler: () => ({ status: 200, body: 1 }) },
      { method: 'post', path: '/b', handler: () => ({ status: 201, body: 2 }) },
    ];
    mountRoutes(router, routes);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'get /a',
      'post /b',
    ]);
    expect(typeof calls[0].fn).toBe('function');
  });
});

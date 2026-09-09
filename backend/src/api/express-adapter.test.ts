import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response, Router } from 'express';
import { toExpressHandler, mountRoutes } from './express-adapter.js';
import { NotFoundError } from '../kernel/error-types.js';
import type { HttpHandler, Route } from './http-contract.js';

function fakeRes() {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 0,
    payload: undefined as unknown,
    writableEnded: false,
    destroyed: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      this.writableEnded = true;
    },
  });
  return res;
}

function fakeReq(): Request {
  return Object.assign(new EventEmitter(), {
    params: { id: 'f1' },
    query: { q: 'x' },
    body: { name: 'Login' },
  }) as unknown as Request;
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

  it.each(['aborted', 'close'] as const)(
    'aborts owned work and does not write after the transport emits %s',
    async (event) => {
      let release!: () => void;
      let signal!: AbortSignal;
      const handler: HttpHandler = (request) => {
        signal = request.signal!;
        return new Promise((resolve) => {
          release = () => resolve({ status: 200, body: 'late' });
        });
      };
      const req = fakeReq();
      const res = fakeRes();
      const pending = toExpressHandler(handler)(req, res as unknown as Response);
      if (event === 'aborted') {
        (req as unknown as EventEmitter).emit('aborted');
      } else {
        res.emit('close');
      }
      expect(signal.aborted).toBe(true);
      release();
      await pending;
      expect(res.statusCode).toBe(0);
      expect(res.payload).toBeUndefined();
    },
  );

  it('suppresses a handler error raised after the client disconnected', async () => {
    let fail!: (error: Error) => void;
    const handler: HttpHandler = () => new Promise((_resolve, reject) => {
      fail = reject;
    });
    const req = fakeReq();
    const res = fakeRes();
    const pending = toExpressHandler(handler)(req, res as unknown as Response);
    res.emit('close');
    fail(new NotFoundError('missing'));
    await pending;
    expect(res.statusCode).toBe(0);
    expect(res.payload).toBeUndefined();
  });

  it('still responds when the transport closes after the reply was written', async () => {
    const handler: HttpHandler = () => ({ status: 200, body: 'ok' });
    const res = fakeRes();
    await toExpressHandler(handler)(fakeReq(), res as unknown as Response);
    res.emit('close');
    expect(res.statusCode).toBe(200);
    expect(res.payload).toBe('ok');
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

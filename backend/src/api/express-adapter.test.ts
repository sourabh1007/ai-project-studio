import { describe, it, expect, vi } from 'vitest';
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

  describe('fault reporting', () => {
    function faultLogger() {
      const error = vi.fn();
      return { error, fault: { logger: { error }, method: 'get', path: '/skills' } };
    }

    it('logs the real fault that the generic 500 hides from the client', async () => {
      const boom = new Error('SQLITE_BUSY: database is locked');
      const { error, fault } = faultLogger();
      const res = fakeRes();
      await toExpressHandler(() => {
        throw boom;
      }, fault)(fakeReq(), res as unknown as Response);

      expect(res.statusCode).toBe(500);
      expect(res.payload).toEqual({
        error: { kind: 'internal', message: 'Internal server error' },
      });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toBe('Unhandled error while serving request');
      expect(error.mock.calls[0][1]).toMatchObject({
        method: 'get',
        path: '/skills',
        message: 'SQLITE_BUSY: database is locked',
      });
    });

    it('does not report an expected app error as a fault', async () => {
      const { error, fault } = faultLogger();
      const res = fakeRes();
      await toExpressHandler(() => {
        throw new NotFoundError('missing');
      }, fault)(fakeReq(), res as unknown as Response);

      expect(res.statusCode).toBe(404);
      expect(error).not.toHaveBeenCalled();
    });

    it('reports the fault even when the caller already disconnected', async () => {
      // The work still ran and still broke; losing the diagnosis because the
      // user navigated away is how these faults stayed invisible.
      const { error, fault } = faultLogger();
      const req = fakeReq();
      const res = fakeRes();
      const pending = toExpressHandler(async () => {
        await Promise.resolve();
        throw new Error('late failure');
      }, fault)(req, res as unknown as Response);
      res.emit('close');
      await pending;

      expect(res.statusCode).toBe(0);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][1]).toMatchObject({ message: 'late failure' });
    });

    it('still serves when no fault logger is wired', async () => {
      const res = fakeRes();
      await toExpressHandler(() => {
        throw new Error('boom');
      })(fakeReq(), res as unknown as Response);
      expect(res.statusCode).toBe(500);
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

  it('gives every mounted route a fault reporter identifying it', async () => {
    const mounted: Array<(req: Request, res: Response) => Promise<void>> = [];
    const router = {
      get: (_path: string, fn: (req: Request, res: Response) => Promise<void>) => {
        mounted.push(fn);
      },
    } as unknown as Router;
    const error = vi.fn();

    mountRoutes(router, [{
      method: 'get',
      path: '/features/:id/sessions',
      handler: () => {
        throw new Error('boom');
      },
    }], { error });
    await mounted[0](fakeReq(), fakeRes() as unknown as Response);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][1]).toMatchObject({
      method: 'get',
      path: '/features/:id/sessions',
      message: 'boom',
    });
  });
});

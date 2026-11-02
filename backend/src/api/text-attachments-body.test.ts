import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import express from 'express';
import { createTextAttachmentBody } from './text-attachments-body.js';

vi.mock('express', () => ({ default: { raw: vi.fn(() => vi.fn()) } }));
afterEach(() => vi.useRealTimers());

function setup(maxBytes = 4194304) {
  const middleware = createTextAttachmentBody(maxBytes);
  const parse = vi.mocked(express.raw).mock.results.at(-1)!.value;
  const request = (type = true) => Object.assign(new EventEmitter(), {
    is: vi.fn(() => type),
    headers: {},
    destroy: vi.fn(),
  }) as unknown as Request;
  const response = () => {
    const res = Object.assign(new EventEmitter(), {
      status: vi.fn(), json: vi.fn(), destroyed: false, writableEnded: false,
    });
    res.status.mockReturnValue(res);
    return res as unknown as Response;
  };
  const call = (req = request(), res = response()) => {
    const next = vi.fn();
    middleware(req, res, next);
    return { req, res, next };
  };
  return { middleware, parse, request, response, call };
}

describe('text attachment body admission', () => {
  it('bounds uncompressed raw UTF-8 bytes without widening JSON parsing', () => {
    const { call, parse } = setup();
    expect(express.raw).toHaveBeenLastCalledWith({ type: 'text/plain', limit: 4194304, inflate: false });
    const { req, res, next } = call();
    parse.mock.calls[0][2]();
    expect(next).toHaveBeenCalledOnce();
    res.emit('finish');
    expect(req.listenerCount('aborted')).toBe(0);
    res.emit('close');
  });

  it('rejects unsupported content types before buffering', () => {
    const { call, request, parse } = setup();
    const { res } = call(request(false));
    expect(res.status).toHaveBeenCalledWith(415);
    expect(parse).not.toHaveBeenCalled();
  });

  it.each([
    ['text/plain; charset=utf-16', false],
    ['text/plain; charset="iso-8859-1"', false],
    ['text/plain; charset=""', false],
    ['text/plain; charset=utf-8; charset=utf-16', false],
    ['text/plain; charset=UTF-8', true],
    ['text/plain; charset="utf-8"', true],
  ])('enforces declared UTF-8 charset %s', (type, allowed) => {
    const { call, request, parse } = setup();
    const req = request();
    req.headers['content-type'] = type;
    const { res } = call(req);
    expect(parse).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (!allowed) expect(res.status).toHaveBeenCalledWith(415);
    res.emit('finish');
  });

  it('never queues concurrent bodies and releases on abort and response close', () => {
    const { call, parse } = setup();
    const first = call();
    const second = call();
    expect(second.res.status).toHaveBeenCalledWith(429);
    expect(parse).toHaveBeenCalledTimes(1);
    const release = first.req.listeners('aborted')[0];
    release();
    release();
    first.res.emit('close');
    const third = call();
    expect(parse).toHaveBeenCalledTimes(2);
    third.res.emit('close');
  });

  it.each([
    [{ type: 'entity.too.large', body: 'private' }, 413],
    [{ type: 'encoding.unsupported', body: 'private' }, 400],
    [{}, 400],
  ])('sanitizes parser errors %o', (error, status) => {
    const { call, parse } = setup();
    const { res, next } = call();
    parse.mock.calls[0][2](error);
    expect(res.status).toHaveBeenCalledWith(status);
    expect(JSON.stringify(vi.mocked(res.json).mock.calls)).not.toContain('private');
    expect(next).not.toHaveBeenCalled();
    res.emit('finish');
  });

  it.each(['destroyed', 'writableEnded'])('does not continue on a %s response', (field) => {
    const { call, parse } = setup();
    const { res, next } = call();
    Object.assign(res, { [field]: true });
    parse.mock.calls[0][2]();
    expect(next).not.toHaveBeenCalled();
    res.emit('close');
  });

  it('times out receiving/processing, aborts the route, and does not continue parsing', () => {
    vi.useFakeTimers();
    const { call, parse } = setup();
    const { req, res, next } = call();
    const abort = vi.fn();
    req.once('aborted', abort);
    vi.advanceTimersByTime(15_000);
    expect(abort).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(408);
    expect(req.destroy).toHaveBeenCalledOnce();
    parse.mock.calls[0][2]();
    expect(next).not.toHaveBeenCalled();
  });

  it('rate limits repeated small requests and recovers after the minute window', () => {
    vi.useFakeTimers();
    const { call } = setup();
    for (let i = 0; i < 30; i++) call().res.emit('finish');
    expect(call().res.status).toHaveBeenCalledWith(429);
    vi.advanceTimersByTime(60_000);
    const later = call();
    expect(later.res.status).not.toHaveBeenCalled();
    later.res.emit('finish');
  });
});

import express, { type RequestHandler } from 'express';

/** Admission precedes buffering; no queued large requests or compressed-body expansion. */
export function createTextAttachmentBody(maxBytes: number): RequestHandler {
  const parse = express.raw({ type: 'text/plain', limit: maxBytes, inflate: false });
  let active = false;
  const admissions: number[] = [];
  return (req, res, next) => {
    const reject = (status: number, code: string) => {
      res.status(status).json({ error: { kind: 'text_attachment', code, message: 'Text attachment could not be saved.' } });
    };
    if (!req.is('text/plain')) return reject(415, 'content-type');
    const charsets = [...(req.headers['content-type'] ?? '').matchAll(/;\s*charset\s*=\s*(?:"([^"]*)"|([^;]*))/gi)];
    if (charsets.some((match) => (match[1] ?? match[2]).trim().toLowerCase() !== 'utf-8')) return reject(415, 'charset');
    const now = Date.now();
    while (admissions.length && admissions[0] <= now - 60_000) admissions.shift();
    if (active || admissions.length >= 30) return reject(429, 'busy');
    active = true;
    admissions.push(now);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active = false;
      clearTimeout(timer);
      req.removeListener('aborted', release);
      res.removeListener('finish', release);
      res.removeListener('close', release);
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      req.emit('aborted');
      reject(408, 'timeout');
      req.destroy();
    }, 15_000);
    timer.unref();
    req.once('aborted', release);
    res.once('finish', release);
    res.once('close', release);
    parse(req, res, (error?: { type?: string }) => {
      if (timedOut || res.destroyed || res.writableEnded) return;
      if (error) return reject(error.type === 'entity.too.large' ? 413 : 400, 'invalid-body');
      next();
    });
  };
}

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  combineSinks,
  createFileLogSink,
  formatLogLine,
} from './log-file-sink.js';
import type { LogRecord } from '../kernel/logger.js';

const at = new Date('2026-08-03T00:00:00.000Z');

describe('formatLogLine', () => {
  it('serializes a record without data', () => {
    const line = formatLogLine({ level: 'info', message: 'hello' }, at);
    expect(JSON.parse(line)).toEqual({
      ts: '2026-08-03T00:00:00.000Z',
      level: 'info',
      message: 'hello',
    });
    expect(line.endsWith('\n')).toBe(true);
  });

  it('includes data when present', () => {
    const record: LogRecord = {
      level: 'error',
      message: 'boom',
      data: { code: 5 },
    };
    expect(JSON.parse(formatLogLine(record, at))).toMatchObject({
      data: { code: 5 },
    });
  });
});

describe('createFileLogSink', () => {
  it('creates the directory once and appends formatted lines', () => {
    const dirs: string[] = [];
    const writes: Array<[string, string]> = [];
    const sink = createFileLogSink({
      filePath: '/logs/app.log',
      now: () => at,
      ensureDir: (dir) => dirs.push(dir),
      append: (path, line) => writes.push([path, line]),
    });
    sink({ level: 'info', message: 'one' });
    sink({ level: 'info', message: 'two' });
    expect(dirs).toEqual(['/logs']);
    expect(writes).toHaveLength(2);
    expect(writes[0][0]).toBe('/logs/app.log');
    expect(JSON.parse(writes[0][1]).message).toBe('one');
  });

  it('swallows write failures so logging never crashes the app', () => {
    const sink = createFileLogSink({
      filePath: '/logs/app.log',
      ensureDir: () => {
        throw new Error('permission denied');
      },
      append: () => {
        throw new Error('should not reach');
      },
    });
    expect(() => sink({ level: 'error', message: 'x' })).not.toThrow();
  });

  it('writes to a real file using the default fs helpers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-sink-'));
    const filePath = join(dir, 'nested', 'app.log');
    try {
      const sink = createFileLogSink({ filePath });
      sink({ level: 'info', message: 'persisted' });
      const contents = readFileSync(filePath, 'utf8');
      expect(JSON.parse(contents.trim()).message).toBe('persisted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('combineSinks', () => {
  it('fans a record out to every sink', () => {
    const a: LogRecord[] = [];
    const b: LogRecord[] = [];
    const sink = combineSinks(
      (r) => a.push(r),
      (r) => b.push(r),
    );
    const record: LogRecord = { level: 'debug', message: 'hi' };
    sink(record);
    expect(a).toEqual([record]);
    expect(b).toEqual([record]);
  });
});

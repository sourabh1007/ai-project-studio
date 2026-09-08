import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDailyLogPathStrategy } from './config.js';
import {
  combineSinks,
  createFileLogSink,
  defaultLogFileLstat,
  defaultLogFileStat,
  deriveLegacyDailyLogPathStrategy,
  formatLogLine,
  logFailureName,
  parseManagedLogFileName,
} from './log-file-sink.js';
import type { FileLogSinkFailure } from './log-file-sink.js';
import type { LogRecord } from '../kernel/logger.js';

const at = new Date('2026-08-03T00:00:00.000Z');
const unitLogDir = join(tmpdir(), 'studio-logging-unit');
const tempDirs: string[] = [];

function ownedTempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('formatLogLine', () => {
  it('never exposes values behind array or inherited custom serializers', () => {
    class Base {
      toJSON() { return 'redacted'; }
    }
    class Child extends Base {
      secret = 'fixture-secret';
    }
    const array = Object.assign(['fixture-secret'], { toJSON: vi.fn(() => []) });
    const getter = vi.fn(() => 0);
    const date = new Date('2026-08-04T01:02:03.000Z');
    date.getTime = getter;
    date.toISOString = vi.fn(() => 'fixture-secret');
    const line = formatLogLine({
      level: 'info', message: 'safe',
      data: { inherited: new Child(), array, date },
    }, at);
    expect(line).not.toContain('fixture-secret');
    expect(JSON.parse(line).data).toEqual({
      inherited: 'custom-tojson-omitted',
      array: 'custom-tojson-omitted',
      date: '2026-08-04T01:02:03.000Z',
    });
    expect(array.toJSON).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(date.toISOString).not.toHaveBeenCalled();
  });

  it('bounds prototype inspection and rejects impossible serialization budgets', () => {
    let object: object = {};
    for (let index = 0; index < 20; index++) object = Object.create(object) as object;
    expect(formatLogLine({ level: 'info', message: 'deep', data: { object } }, at))
      .toContain('custom-tojson-omitted');
    for (const budget of [0, -1, Infinity, NaN, 1.5]) {
      expect(() => formatLogLine({ level: 'info', message: 'x' }, at, budget)).toThrow();
    }
    const large = { level: 'info' as const, message: 'x'.repeat(1000) };
    expect(JSON.parse(formatLogLine(large, at, 64))).toEqual({ message: 'log record omitted' });
    expect(() => formatLogLine(large, at, 1)).toThrow('omission marker');
  });

  it('serializes a simple JSONL record', () => {
    const line = formatLogLine({ level: 'info', message: 'hello' }, at);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      ts: '2026-08-03T00:00:00.000Z',
      level: 'info',
      message: 'hello',
    });
  });

  it('preserves normal Date output and omits custom toJSON objects without exposing secrets', () => {
    const secret = { secret: 'fixture-secret', toJSON: () => 'safe' };
    const line = formatLogLine(
      {
        level: 'debug',
        message: 'dates',
        data: {
          when: new Date('2026-08-04T01:02:03.000Z'),
          masked: secret,
        },
      },
      at,
    );
    expect(line).not.toContain('fixture-secret');
    expect(JSON.parse(line)).toEqual({
      ts: '2026-08-03T00:00:00.000Z',
      level: 'debug',
      message: 'dates',
      data: {
        when: '2026-08-04T01:02:03.000Z',
        masked: 'custom-tojson-omitted',
      },
    });
  });

  it('serializes invalid dates as null', () => {
    const line = formatLogLine(
      { level: 'info', message: 'invalid-date', data: { when: new Date(Number.NaN) } },
      at,
    );

    expect(JSON.parse(line)).toEqual({
      ts: '2026-08-03T00:00:00.000Z',
      level: 'info',
      message: 'invalid-date',
      data: { when: null },
    });
  });

  it('avoids invoking accessors, bounds traversal, and preserves normal object and array semantics', () => {
    let getterCalls = 0;
    const data: Record<string, unknown> = {
      ok: 1,
      bool: false,
      weird: Number.NaN,
      count: 1n,
      list: [1, , 3],
    };
    for (let index = 0; index < 200; index += 1) {
      Object.defineProperty(data, `hidden${index}`, {
        enumerable: true,
        get() {
          getterCalls += 1;
          return index;
        },
      });
    }
    const line = formatLogLine({ level: 'info', message: 'obj', data }, at, 4096);
    const parsed = JSON.parse(line) as { data: Record<string, unknown> };
    expect(getterCalls).toBe(0);
    expect(parsed.data.ok).toBe(1);
    expect(parsed.data.bool).toBe(false);
    expect(parsed.data.weird).toBeNull();
    expect(parsed.data.count).toBe('1n');
    expect(parsed.data.list).toEqual([1, null, 3]);
    expect(parsed.data.__omitted__).toBe('property-limit');
  });

  it('handles cyclic and deep arrays without recursing forever', () => {
    const loop: unknown[] = [1];
    loop.push(loop);
    const deep = [[[[[[['x']]]]]]];
    const line = formatLogLine(
      {
        level: 'warn',
        message: 'arrays',
        data: {
          loop,
          deep,
          many: Array.from({ length: 100 }, (_, index) => index),
        },
      },
      at,
      4096,
    );
    const parsed = JSON.parse(line) as {
      ts: string;
      level: string;
      message: string;
      data: { loop: unknown[]; deep: unknown; many: unknown[] };
    };
    expect(parsed.ts).toBe('2026-08-03T00:00:00.000Z');
    expect(parsed.level).toBe('warn');
    expect(parsed.message).toBe('arrays');
    expect(parsed.data.loop).toEqual([1, 'circular']);
    expect(JSON.stringify(parsed.data.deep)).toContain('depth-limit');
    expect(parsed.data.many).toEqual([
      ...Array.from({ length: 64 }, (_, index) => index),
      'array-limit',
    ]);
  });

  it('emits a bounded truncation record using code-unit metadata instead of rescanning bytes', () => {
    const line = formatLogLine(
      {
        level: 'error',
        message: '😀'.repeat(400),
        data: { giant: 'x'.repeat(10_000) },
      },
      at,
      256,
    );
    expect(utf8Bytes(line)).toBeLessThanOrEqual(256);
    expect(JSON.parse(line)).toMatchObject({
      ts: '2026-08-03T00:00:00.000Z',
      level: 'error',
      data: {
        truncated: true,
        maxRecordBytes: 256,
        originalMessageCodeUnits: 800,
      },
    });
  });

  it('falls back to an omission record when even detailed truncation metadata would overflow', () => {
    const line = formatLogLine(
      { level: 'error', message: 'x'.repeat(10_000), data: null },
      at,
      128,
    );
    expect(utf8Bytes(line)).toBeLessThanOrEqual(128);
    expect(JSON.parse(line)).toEqual({
      ts: '2026-08-03T00:00:00.000Z',
      level: 'error',
      message: 'log record omitted',
      data: { truncated: true, maxRecordBytes: 128 },
    });
  });

  it('covers serializer edge cases without exposing hidden content', () => {
    const protoToJson = Object.create({
      get toJSON() {
        return () => 'hidden';
      },
    }) as Record<string, unknown>;
    protoToJson.visible = true;
    const circular: Record<string, unknown> = { label: 'self' };
    circular.self = circular;
    const nodeHeavy = Array.from({ length: 64 }, () =>
      Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`k${index}`, index])),
    );

    const line = formatLogLine(
      {
        level: 'info',
        message: 'edge',
        data: {
          nil: null,
          fn: () => 'x',
          sym: Symbol('x'),
          protoToJson,
          circular,
          nodeHeavy,
        },
      },
      at,
      64 * 1024,
    );

    const parsed = JSON.parse(line) as { data: Record<string, unknown> };
    expect(parsed.data.nil).toBeNull();
    expect(parsed.data.fn).toBeUndefined();
    expect(parsed.data.sym).toBeUndefined();
    expect(parsed.data.protoToJson).toBe('custom-tojson-omitted');
    expect(parsed.data.circular).toEqual({ label: 'self', self: 'circular' });
    expect(JSON.stringify(parsed.data.nodeHeavy)).toContain('node-limit');
  });

  it('ignores inherited properties and serializes undefined/function/symbol array values as null', () => {
    const base = { inherited: 'skip-me' };
    const data = Object.create(base) as Record<string, unknown>;
    data.own = [undefined, () => 'x', Symbol('x')];

    const line = formatLogLine({ level: 'info', message: 'array-edge', data }, at);
    const parsed = JSON.parse(line) as { data: Record<string, unknown> };

    expect(parsed.data.inherited).toBeUndefined();
    expect(parsed.data.own).toEqual([null, null, null]);
  });

  it('surfaces unexpected serializer errors for the sink to report', () => {
    const broken = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(broken, 'boom', {
      enumerable: true,
      get() {
        throw new RangeError('bad getter');
      },
    });
    const record = {
      level: 'info',
      message: 'broken',
      get data() {
        throw new RangeError('outer getter');
      },
    } as unknown as LogRecord;
    expect(() => formatLogLine(record, at)).toThrow('outer getter');
    expect(() =>
      formatLogLine({ level: 'info', message: 'broken', data: broken }, at),
    ).not.toThrow();
    expect(() =>
      formatLogLine(
        {
          level: 'info',
          message: 'proxy',
          data: new Proxy(
            {},
            {
              ownKeys() {
                throw new Error('proxy failed');
              },
            },
          ) as Record<string, unknown>,
        },
        at,
      ),
    ).toThrow('proxy failed');
  });
});

describe('logging helpers', () => {
  it('parses managed names and legacy strategies', () => {
    expect(parseManagedLogFileName('app-2026-08-03.2.log')).toEqual({
      fileName: 'app-2026-08-03.2.log',
      filePath: 'app-2026-08-03.2.log',
      dateKey: '2026-08-03',
      rotation: 2,
      size: 0,
    });
    expect(parseManagedLogFileName('notes.txt')).toBeNull();
    const strategy = deriveLegacyDailyLogPathStrategy(
      join(unitLogDir, 'app-2026-08-03.log'),
    );
    expect(strategy?.resolve(at, 1)).toBe(join(unitLogDir, 'app-2026-08-03.1.log'));
    expect(deriveLegacyDailyLogPathStrategy(join(unitLogDir, 'app.log'))).toBeNull();
  });

  it('reports fallback failure names and default stat helpers', () => {
    expect(logFailureName(new TypeError('x'))).toBe('TypeError');
    expect(logFailureName('x')).toBe('Error');
    const dir = ownedTempDir('log-stat');
    const filePath = join(dir, 'entry.log');
    writeFileSync(filePath, 'hello');
    expect(defaultLogFileLstat(filePath)).toEqual({
      size: 5,
      isFile: true,
      isSymbolicLink: false,
    });
    expect(defaultLogFileStat(filePath)).toEqual({
      size: 5,
      isFile: true,
      isSymbolicLink: false,
    });
    expect(defaultLogFileLstat(join(dir, 'missing.log'))).toBeNull();
    expect(defaultLogFileStat(join(dir, 'missing.log'))).toBeNull();
  });

  it('rethrows non-ENOENT helper failures', () => {
    expect(() => defaultLogFileLstat(`C:\\invalid\u0000path`)).toThrow();
    expect(() => defaultLogFileStat(`C:\\invalid\u0000path`)).toThrow();
  });
});

describe('createFileLogSink', () => {
  it('prunes all necessary old files without skipping entries', () => {
    const dir = ownedTempDir('logging-bulk-prune');
    const date = new Date('2026-08-09T00:00:00Z');
    const strategy = createDailyLogPathStrategy(dir, 'app');
    for (let day = 1; day <= 8; day++) {
      writeFileSync(join(dir, `app-2026-08-0${day}.log`), 'old');
    }
    const current = strategy.resolve(date, 0);
    writeFileSync(current, 'x'.repeat(1400));
    const sink = createFileLogSink({
      filePath: current, pathStrategy: strategy, now: () => date,
      maxFileBytes: 1024, maxRecordBytes: 256, retainedFileCount: 2,
    });
    sink({ level: 'info', message: 'fresh' });
    expect(readdirSync(dir).sort()).toEqual(['app-2026-08-09.1.log', 'app-2026-08-09.log']);
    expect(readJsonLines(current)[0].message).toBe('fresh');
  });

  it('does not rescan retained history for ordinary writes', () => {
    const dir = ownedTempDir('logging-scan-budget');
    const strategy = createDailyLogPathStrategy(dir, 'app');
    const listDir = vi.fn(() => readdirSync(dir));
    const sink = createFileLogSink({
      filePath: strategy.resolve(at, 0), pathStrategy: strategy,
      now: () => at, listDir,
    });
    for (let index = 0; index < 100; index++) sink({ level: 'info', message: `record-${index}` });
    expect(listDir).toHaveBeenCalledTimes(1);
    expect(readJsonLines(strategy.resolve(at, 0))).toHaveLength(100);
  });

  it('protects the active file after clock rollback while pruning ordered archives', () => {
    const dir = ownedTempDir('logging-clock-prune');
    const strategy = createDailyLogPathStrategy(dir, 'app');
    const current = strategy.resolve(at, 0);
    writeFileSync(current, '');
    for (const name of [
      'app-2026-08-03.1.log', 'app-2026-08-03.2.log',
      'app-2026-08-04.log', 'app-2026-08-05.log',
    ]) writeFileSync(join(dir, name), 'old');
    const sink = createFileLogSink({
      filePath: current, pathStrategy: strategy, now: () => at, retainedFileCount: 2,
    });
    sink({ level: 'info', message: 'current' });
    expect(readdirSync(dir).sort()).toEqual(['app-2026-08-03.log', 'app-2026-08-05.log']);
    expect(readJsonLines(current)[0].message).toBe('current');
  });

  it('leaves nonregular and disappeared directory entries out of managed retention', () => {
    const dir = ownedTempDir('logging-nonregular');
    const strategy = createDailyLogPathStrategy(dir, 'app');
    const ignored = join(dir, 'app-2026-08-01.log');
    writeFileSync(ignored, 'do not remove');
    const sink = createFileLogSink({
      filePath: strategy.resolve(at, 0), pathStrategy: strategy, now: () => at,
      retainedFileCount: 1,
      listDir: () => [...readdirSync(dir), 'app-2026-08-02.log'],
      lstat: (path) => path === ignored
        ? { size: 0, isFile: false, isSymbolicLink: true }
        : defaultLogFileLstat(path),
    });
    sink({ level: 'info', message: 'fresh' });
    expect(readFileSync(ignored, 'utf8')).toBe('do not remove');
    expect(readJsonLines(strategy.resolve(at, 0))[0].message).toBe('fresh');
  });

  it.each(['recreated', 'unreadable'])(
    'blocks a one-file rollover when the removed target becomes %s, then recovers',
    (mode) => {
      const dir = ownedTempDir('logging-rollover-race');
      const strategy = createDailyLogPathStrategy(dir, 'app');
      const current = strategy.resolve(at, 0);
      writeFileSync(current, 'x'.repeat(1400));
      const failures: FileLogSinkFailure[] = [];
      let interfere = true;
      let removed = false;
      const sink = createFileLogSink({
        filePath: current, pathStrategy: strategy, now: () => at,
        maxFileBytes: 1024, maxRecordBytes: 256, retainedFileCount: 1,
        lstat: (path) => {
          if (interfere && removed && mode === 'unreadable') throw new Error('unreadable');
          return defaultLogFileLstat(path);
        },
        removeFile: (path) => {
          rmSync(path);
          removed = true;
          if (interfere && mode === 'recreated') writeFileSync(path, 'x'.repeat(1400));
        },
        onFailure: (failure) => failures.push(failure),
      });
      sink({ level: 'info', message: 'blocked' });
      expect(failures).toContainEqual(expect.objectContaining({
        kind: 'failure', operation: 'retention-blocked',
      }));
      interfere = false;
      sink({ level: 'info', message: 'recovered' });
      expect(readJsonLines(current).map((record) => record.message)).toEqual(['recovered']);
      expect(failures).toContainEqual(expect.objectContaining({
        kind: 'recovered', operation: 'retention-blocked',
      }));
    },
  );

  it('bounds recovery callback reentry even when the nested write fails again', () => {
    const dir = ownedTempDir('logging-reentry');
    let failing = true;
    const events: FileLogSinkFailure[] = [];
    let sink: ReturnType<typeof createFileLogSink>;
    sink = createFileLogSink({
      filePath: join(dir, 'fixed.log'),
      append: () => { if (failing) throw new Error('unavailable'); },
      onFailure: (event) => {
        events.push(event);
        if (event.kind === 'recovered' && events.length < 10) {
          failing = true;
          sink({ level: 'warn', message: 'nested' });
        }
      },
    });
    sink({ level: 'warn', message: 'first' });
    failing = false;
    sink({ level: 'info', message: 'retry' });
    expect(events.map((event) => event.kind)).toEqual(['failure', 'recovered']);
  });

  it('remains nonfatal when both reporting channels fail', () => {
    const sink = createFileLogSink({
      filePath: join(tmpdir(), 'unused.log'),
      ensureDir: () => { throw new Error('unavailable'); },
      onFailure: () => { throw new Error('callback failed'); },
      writeFailureLine: () => { throw new Error('stderr failed'); },
    });
    expect(() => sink({ level: 'error', message: 'failure' })).not.toThrow();
  });

  it('creates the directory once and appends to the fixed legacy file path', () => {
    const dirs: string[] = [];
    const writes: Array<[string, string]> = [];
    const sink = createFileLogSink({
      filePath: join(unitLogDir, 'app.log'),
      now: () => at,
      ensureDir: (dir) => dirs.push(dir),
      append: (filePath, line) => writes.push([filePath, line]),
      lstat: () => null,
      stat: () => null,
    });

    sink({ level: 'info', message: 'one' });
    sink({ level: 'info', message: 'two' });

    expect(dirs).toEqual([unitLogDir]);
    expect(writes).toHaveLength(2);
    expect(writes[0][0]).toBe(join(unitLogDir, 'app.log'));
  });

  it('rolls over by the current write date in long-running processes', () => {
    const dir = ownedTempDir('logging-rollover');
    const strategy = createDailyLogPathStrategy(dir, 'app');
    const dates = [
      new Date('2026-08-03T23:59:59.000Z'),
      new Date('2026-08-04T00:00:00.000Z'),
      new Date('2026-08-03T12:00:00.000Z'),
    ];
    const sink = createFileLogSink({
      filePath: strategy.resolve(at, 0),
      now: () => dates.shift() as Date,
    });

    sink({ level: 'info', message: 'before' });
    sink({ level: 'info', message: 'after' });
    sink({ level: 'info', message: 'back' });

    expect(readJsonLines(join(dir, 'app-2026-08-03.log')).map((line) => line.message))
      .toEqual(['before', 'back']);
    expect(readJsonLines(join(dir, 'app-2026-08-04.log')).map((line) => line.message))
      .toEqual(['after']);
  });

  it('rotates an oversized managed file by rename and preserves unrelated files', () => {
    const dir = ownedTempDir('logging-rotate');
    const strategy = createDailyLogPathStrategy(dir, 'app');
    const currentPath = strategy.resolve(at, 0);
    writeFileSync(currentPath, 'x'.repeat(1400));
    writeFileSync(join(dir, 'app-2026-08-01.log'), 'old');
    writeFileSync(join(dir, 'keep.txt'), 'keep');
    const sink = createFileLogSink({
      filePath: currentPath,
      pathStrategy: strategy,
      now: () => at,
      maxFileBytes: 1024,
      retainedFileCount: 3,
      maxRecordBytes: 256,
    });

    sink({ level: 'info', message: 'fresh' });

    expect(readJsonLines(currentPath).map((line) => line.message)).toEqual(['fresh']);
    expect(readFileSync(join(dir, 'app-2026-08-03.1.log'), 'utf8')).toHaveLength(1400);
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('uses the default managed-file remover when pruning old files', () => {
    const dir = ownedTempDir('logging-default-remove');
    const strategy = createDailyLogPathStrategy(dir, 'app');
    const currentPath = strategy.resolve(at, 0);
    writeFileSync(currentPath, 'x'.repeat(1400));
    writeFileSync(join(dir, 'app-2026-08-01.log'), 'old');
    const sink = createFileLogSink({
      filePath: currentPath,
      pathStrategy: strategy,
      now: () => at,
      maxFileBytes: 1024,
      retainedFileCount: 2,
      maxRecordBytes: 256,
    });

    sink({ level: 'info', message: 'fresh' });

    expect(() => readFileSync(join(dir, 'app-2026-08-01.log'), 'utf8')).toThrow();
    expect(readFileSync(join(dir, 'app-2026-08-03.1.log'), 'utf8')).toHaveLength(1400);
  });

  it('uses default metadata-only failure reporting, deduplicates repeats, and reports recovery', () => {
    const notices: FileLogSinkFailure[] = [];
    let allowWrites = false;
    const sink = createFileLogSink({
      filePath: join(unitLogDir, 'app.log'),
      ensureDir: () => {
        if (!allowWrites) {
          throw new Error('denied');
        }
      },
      append: () => undefined,
      lstat: () => null,
      stat: () => null,
      writeFailureLine: (line) => notices.push(JSON.parse(line) as FileLogSinkFailure),
    });

    sink({ level: 'error', message: 'a' });
    sink({ level: 'error', message: 'b' });
    allowWrites = true;
    sink({ level: 'error', message: 'c' });

    expect(notices.map((notice) => [notice.kind, notice.operation, notice.suppressedCount]))
      .toEqual([
        ['failure', 'ensure-dir', 0],
        ['recovered', 'ensure-dir', 1],
      ]);
  });

  it('swallows default stderr reporter failures without crashing', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('stderr blocked');
    });
    try {
      const sink = createFileLogSink({
        filePath: join(unitLogDir, 'app.log'),
        ensureDir: () => {
          throw new Error('denied');
        },
        lstat: () => null,
        stat: () => null,
      });

      expect(() => sink({ level: 'error', message: 'a' })).not.toThrow();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('guards against recursive failure callbacks and falls back when the callback throws', () => {
    const fallback: FileLogSinkFailure[] = [];
    let callbackCalls = 0;
    let sink!: ReturnType<typeof createFileLogSink>;
    sink = createFileLogSink({
      filePath: join(unitLogDir, 'app.log'),
      ensureDir: () => {
        throw new Error('denied');
      },
      lstat: () => null,
      stat: () => null,
      onFailure: () => {
        callbackCalls += 1;
        if (callbackCalls === 1) {
          sink({
            level: 'error',
            message: 'nested',
            get data() {
              throw new Error('nested serialize');
            },
          } as unknown as LogRecord);
        }
        throw new Error('callback failed');
      },
      writeFailureLine: (line) => fallback.push(JSON.parse(line) as FileLogSinkFailure),
    });

    expect(() => sink({ level: 'error', message: 'outer' })).not.toThrow();
    expect(callbackCalls).toBe(1);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({ kind: 'failure', operation: 'ensure-dir' });
  });

  it('reports serializer failures without attempting filesystem writes', () => {
    const failures: FileLogSinkFailure[] = [];
    const writes: string[] = [];
    const sink = createFileLogSink({
      filePath: join(unitLogDir, 'app.log'),
      ensureDir: () => undefined,
      append: (_filePath, line) => writes.push(line),
      lstat: () => null,
      stat: () => null,
      onFailure: (failure) => failures.push(failure),
    });

    sink({
      level: 'error',
      message: 'broken',
      get data() {
        throw new Error('bad data');
      },
    } as unknown as LogRecord);

    expect(writes).toEqual([]);
    expect(failures).toContainEqual(
      expect.objectContaining({ kind: 'failure', operation: 'serialize' }),
    );

    sink({ level: 'info', message: 'recovered' });

    expect(writes).toHaveLength(1);
    expect(failures).toContainEqual(
      expect.objectContaining({ kind: 'recovered', operation: 'serialize' }),
    );
  });

  it('rejects invalid direct limit overrides instead of silently expanding them', () => {
    expect(() =>
      createFileLogSink({ filePath: join(unitLogDir, 'app.log'), maxRecordBytes: 255 }),
    ).toThrow();
    expect(() =>
      createFileLogSink({
        filePath: join(unitLogDir, 'app.log'),
        maxFileBytes: 1024,
        maxRecordBytes: 2048,
      }),
    ).toThrow();
  });

  it('revalidates the active target each write and refuses a later symlink or non-regular target', () => {
    const writes: string[] = [];
    let state: 'missing' | 'regular' | 'symlink' = 'missing';
    const sink = createFileLogSink({
      filePath: join(unitLogDir, 'app.log'),
      ensureDir: () => undefined,
      lstat: () => {
        if (state === 'missing') return null;
        if (state === 'regular') {
          return { size: writes.reduce((sum, line) => sum + utf8Bytes(line), 0), isFile: true, isSymbolicLink: false };
        }
        return { size: 0, isFile: false, isSymbolicLink: true };
      },
      stat: () => ({
        size: writes.reduce((sum, line) => sum + utf8Bytes(line), 0),
        isFile: true,
        isSymbolicLink: false,
      }),
      append: (_filePath, line) => {
        writes.push(line);
        state = 'regular';
      },
    });

    sink({ level: 'info', message: 'first' });
    state = 'symlink';
    sink({ level: 'info', message: 'second' });

    expect(writes).toHaveLength(1);
  });

  it('reports stat read failures and recovers on a later successful write', () => {
    const failures: FileLogSinkFailure[] = [];
    const writes: string[] = [];
    let broken = true;
    const sink = createFileLogSink({
      filePath: join(unitLogDir, 'app.log'),
      ensureDir: () => undefined,
      lstat: () => {
        if (broken) {
          throw new Error('stat failed');
        }
        return null;
      },
      stat: () => null,
      append: (_filePath, line) => writes.push(line),
      onFailure: (failure) => failures.push(failure),
    });

    sink({ level: 'info', message: 'blocked' });
    broken = false;
    sink({ level: 'info', message: 'recovered' });

    expect(writes).toHaveLength(1);
    expect(failures).toContainEqual(
      expect.objectContaining({ kind: 'failure', operation: 'stat' }),
    );
    expect(failures).toContainEqual(
      expect.objectContaining({ kind: 'recovered', operation: 'stat' }),
    );
  });

  it('refuses non-regular targets when stat disagrees with lstat', () => {
    const failures: FileLogSinkFailure[] = [];
    const writes: string[] = [];
    const sink = createFileLogSink({
      filePath: join(unitLogDir, 'app.log'),
      ensureDir: () => undefined,
      lstat: () => ({ size: 10, isFile: true, isSymbolicLink: false }),
      stat: () => ({ size: 10, isFile: false, isSymbolicLink: false }),
      append: (_filePath, line) => writes.push(line),
      onFailure: (failure) => failures.push(failure),
    });

    sink({ level: 'info', message: 'blocked' });

    expect(writes).toEqual([]);
    expect(failures).toContainEqual(
      expect.objectContaining({ kind: 'failure', operation: 'stat', errorName: 'NonRegularFileError' }),
    );
  });

  it('evicts old failure keys when many unique failures accumulate', () => {
    const failures: FileLogSinkFailure[] = [];
    const dates = Array.from({ length: 20 }, (_, index) =>
      new Date(Date.UTC(2026, 7, index + 1)),
    );
    const strategy = createDailyLogPathStrategy(unitLogDir, 'app');
    const sink = createFileLogSink({
      filePath: strategy.resolve(at, 0),
      pathStrategy: strategy,
      now: () => dates.shift() as Date,
      ensureDir: () => undefined,
      lstat: () => {
        throw new Error('broken');
      },
      stat: () => null,
      onFailure: (failure) => failures.push(failure),
    });

    for (let index = 0; index < 20; index += 1) {
      sink({ level: 'error', message: `m${index}` });
    }

    expect(failures.filter((failure) => failure.kind === 'failure')).toHaveLength(20);
  });

  it('respects external size growth when enforcing unmanaged file caps', () => {
    const failures: FileLogSinkFailure[] = [];
    const writes: string[] = [];
    let statSize = 0;
    const sink = createFileLogSink({
      filePath: join(unitLogDir, 'fixed.log'),
      ensureDir: () => undefined,
      lstat: () => ({ size: statSize, isFile: true, isSymbolicLink: false }),
      stat: () => ({ size: statSize, isFile: true, isSymbolicLink: false }),
      append: (_filePath, line) => {
        writes.push(line);
        statSize += utf8Bytes(line);
      },
      maxFileBytes: 1024,
      maxRecordBytes: 256,
      onFailure: (failure) => failures.push(failure),
    });

    sink({ level: 'info', message: 'ok' });
    statSize = 1020;
    sink({ level: 'info', message: 'blocked' });

    expect(writes).toHaveLength(1);
    expect(failures.at(-1)).toMatchObject({ operation: 'cap', kind: 'failure' });
  });

  it.each(['retention-list', 'retention-stat', 'retention-remove'] as const)(
    'blocks new managed files across many rotations when %s persists, then recovers once the fault clears',
    (mode) => {
      const dir = ownedTempDir(`logging-${mode}`);
      writeFileSync(join(dir, 'app-2026-08-01.log'), 'old-1');
      writeFileSync(join(dir, 'app-2026-08-02.log'), 'old-2');
      writeFileSync(join(dir, 'keep.txt'), 'keep');
      const strategy = createDailyLogPathStrategy(dir, 'app');
      const failures: FileLogSinkFailure[] = [];
      let broken = true;
      const dates = [
        new Date('2026-08-03T00:00:00.000Z'),
        new Date('2026-08-04T00:00:00.000Z'),
        new Date('2026-08-05T00:00:00.000Z'),
        new Date('2026-08-06T00:00:00.000Z'),
      ];
      const sink = createFileLogSink({
        filePath: strategy.resolve(at, 0),
        pathStrategy: strategy,
        now: () => dates.shift() as Date,
        maxFileBytes: 1024,
        retainedFileCount: 2,
        maxRecordBytes: 256,
        listDir: () => {
          if (mode === 'retention-list' && broken) {
            throw new Error('list failed');
          }
          return ['app-2026-08-01.log', 'app-2026-08-02.log', 'keep.txt'];
        },
        lstat: (filePath) => {
          const fileName = basename(filePath);
          if (mode === 'retention-stat' && broken && fileName === 'app-2026-08-01.log') {
            throw new Error('stat failed');
          }
          return defaultLogFileLstat(filePath);
        },
        stat: (filePath) => {
          const fileName = basename(filePath);
          if (mode === 'retention-stat' && broken && fileName === 'app-2026-08-01.log') {
            throw new Error('stat failed');
          }
          return defaultLogFileStat(filePath);
        },
        removeFile: (filePath) => {
          if (mode === 'retention-remove' && broken) {
            throw new Error('remove failed');
          }
          rmSync(filePath, { force: true });
        },
        onFailure: (failure) => failures.push(failure),
      });

      sink({ level: 'info', message: 'a' });
      sink({ level: 'info', message: 'b' });
      sink({ level: 'info', message: 'c' });
      expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('keep');
      expect(readFileSync(join(dir, 'app-2026-08-01.log'), 'utf8')).toBe('old-1');
      expect(readFileSync(join(dir, 'app-2026-08-02.log'), 'utf8')).toBe('old-2');
      expect(() => readFileSync(join(dir, 'app-2026-08-03.log'), 'utf8')).toThrow();
      expect(() => readFileSync(join(dir, 'app-2026-08-04.log'), 'utf8')).toThrow();
      expect(() => readFileSync(join(dir, 'app-2026-08-05.log'), 'utf8')).toThrow();
      broken = false;
      sink({ level: 'info', message: 'recovered' });

      expect(readJsonLines(join(dir, 'app-2026-08-06.log')).map((line) => line.message))
        .toEqual(['recovered']);
      expect(failures.some((failure) => failure.kind === 'failure' && failure.operation === mode))
        .toBe(true);
      expect(failures.some((failure) => failure.kind === 'recovered')).toBe(true);
    },
  );

  it('rotates with a one-file budget without requiring manual cleanup', () => {
    const dir = ownedTempDir('logging-retention-blocked');
    const strategy = createDailyLogPathStrategy(dir, 'app');
    const currentPath = strategy.resolve(at, 0);
    writeFileSync(currentPath, 'x'.repeat(1400));
    const failures: FileLogSinkFailure[] = [];
    const dates = [at, new Date('2026-08-04T00:00:00.000Z')];
    const sink = createFileLogSink({
      filePath: currentPath,
      pathStrategy: strategy,
      now: () => dates.shift() as Date,
      maxFileBytes: 1024,
      retainedFileCount: 1,
      maxRecordBytes: 256,
      onFailure: (failure) => failures.push(failure),
    });

    sink({ level: 'info', message: 'rotated' });
    expect(readJsonLines(currentPath)[0].message).toBe('rotated');

    sink({ level: 'info', message: 'recovered' });

    expect(readJsonLines(strategy.resolve(new Date('2026-08-04T00:00:00.000Z'), 0)).map((line) => line.message))
      .toEqual(['recovered']);
    expect(readdirSync(dir)).toEqual(['app-2026-08-04.log']);
    expect(failures).toEqual([]);
  });

  it('ignores custom strategy matches that are not valid managed log filenames', () => {
    const dir = ownedTempDir('logging-invalid-managed');
    writeFileSync(join(dir, 'not-a-log-name'), 'legacy');
    const writes: string[] = [];
    const sink = createFileLogSink({
      filePath: join(dir, 'current.log'),
      pathStrategy: {
        directory: dir,
        resolve: () => join(dir, 'current.log'),
        isManagedFile: () => true,
      },
      now: () => at,
      listDir: () => ['not-a-log-name'],
      lstat: (filePath) => defaultLogFileLstat(filePath),
      stat: (filePath) => defaultLogFileStat(filePath),
      append: (_filePath, line) => writes.push(line),
      maxFileBytes: 1024,
      retainedFileCount: 2,
      maxRecordBytes: 256,
    });

    sink({ level: 'info', message: 'ok' });

    expect(writes).toHaveLength(1);
  });

  it('recovers directory-scoped retention failures on a later healthy append', () => {
    const dir = ownedTempDir('logging-directory-recover');
    const strategy = createDailyLogPathStrategy(dir, 'app');
    const currentPath = strategy.resolve(at, 0);
    writeFileSync(currentPath, 'seed');
    const failures: FileLogSinkFailure[] = [];
    let broken = true;
    const sink = createFileLogSink({
      filePath: currentPath,
      pathStrategy: strategy,
      now: () => at,
      maxFileBytes: 1024,
      retainedFileCount: 3,
      maxRecordBytes: 256,
      listDir: () => {
        if (broken) {
          throw new Error('list failed');
        }
        return ['app-2026-08-03.log'];
      },
      lstat: defaultLogFileLstat,
      stat: defaultLogFileStat,
      onFailure: (failure) => failures.push(failure),
    });

    writeFileSync(currentPath, 'x'.repeat(1000));
    sink({ level: 'info', message: 'blocked' });
    broken = false;
    writeFileSync(currentPath, 'seed');
    sink({ level: 'info', message: 'ok' });

    expect(failures).toContainEqual(
      expect.objectContaining({ kind: 'failure', operation: 'retention-list' }),
    );
    expect(failures).toContainEqual(
      expect.objectContaining({ kind: 'recovered', operation: 'retention-list' }),
    );
  });

  it('fails closed when rollover cannot enumerate archive slots after retention succeeds', () => {
    const dir = ownedTempDir('logging-archive-list');
    const strategy = createDailyLogPathStrategy(dir, 'app');
    const currentPath = strategy.resolve(at, 0);
    writeFileSync(currentPath, 'x'.repeat(1400));
    const failures: FileLogSinkFailure[] = [];
    let listCalls = 0;
    const sink = createFileLogSink({
      filePath: currentPath,
      pathStrategy: strategy,
      now: () => at,
      maxFileBytes: 1024,
      retainedFileCount: 4,
      maxRecordBytes: 256,
      listDir: () => {
        listCalls += 1;
        if (listCalls === 1) {
          return ['app-2026-08-03.log'];
        }
        throw new Error('list failed');
      },
      lstat: defaultLogFileLstat,
      stat: defaultLogFileStat,
      onFailure: (failure) => failures.push(failure),
    });

    sink({ level: 'info', message: 'blocked' });

    expect(readFileSync(currentPath, 'utf8')).toHaveLength(1400);
    expect(() => readFileSync(strategy.resolve(at, 1), 'utf8')).toThrow();
    expect(failures).toContainEqual(
      expect.objectContaining({ kind: 'failure', operation: 'retention-list' }),
    );
  });

  it('reports rename and append failures without claiming success', () => {
    const failures: FileLogSinkFailure[] = [];
    const strategy = createDailyLogPathStrategy(unitLogDir, 'app');
    const renameSink = createFileLogSink({
      filePath: join(unitLogDir, 'app-2026-08-03.log'),
      pathStrategy: strategy,
      now: () => at,
      maxFileBytes: 1024,
      maxRecordBytes: 256,
      ensureDir: () => undefined,
      listDir: () => ['app-2026-08-03.log'],
      lstat: () => ({ size: 1400, isFile: true, isSymbolicLink: false }),
      stat: () => ({ size: 1400, isFile: true, isSymbolicLink: false }),
      rename: () => {
        throw new Error('rename failed');
      },
      onFailure: (failure) => failures.push(failure),
    });
    renameSink({ level: 'info', message: 'x' });
    expect(failures.at(-1)).toMatchObject({ operation: 'rename', kind: 'failure' });

    let failAppend = true;
    const appendSink = createFileLogSink({
      filePath: join(unitLogDir, 'app.log'),
      ensureDir: () => undefined,
      lstat: () => null,
      stat: () => null,
      append: () => {
        if (failAppend) {
          failAppend = false;
          throw new Error('disk full');
        }
      },
      onFailure: (failure) => failures.push(failure),
    });
    appendSink({ level: 'info', message: 'first' });
    appendSink({ level: 'info', message: 'second' });
    expect(failures.some((failure) => failure.operation === 'append')).toBe(true);
    expect(failures.some((failure) => failure.kind === 'recovered' && failure.operation === 'append'))
      .toBe(true);
  });

  it('writes to the real filesystem with default helpers', () => {
    const dir = ownedTempDir('logging-real');
    const strategy = createDailyLogPathStrategy(dir, 'app');
    const sink = createFileLogSink({
      filePath: strategy.resolve(at, 0),
      pathStrategy: strategy,
      now: () => at,
    });

    sink({ level: 'info', message: 'persisted' });

    expect(readJsonLines(strategy.resolve(at, 0))[0]?.message).toBe('persisted');
  });
});

describe('combineSinks', () => {
  it('fans a record out to every sink', () => {
    const a: LogRecord[] = [];
    const b: LogRecord[] = [];
    const sink = combineSinks(
      (record) => a.push(record),
      (record) => b.push(record),
    );
    const record: LogRecord = { level: 'debug', message: 'hi' };
    sink(record);
    expect(a).toEqual([record]);
    expect(b).toEqual([record]);
  });
});

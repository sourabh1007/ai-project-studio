import { describe, it, expect, vi } from 'vitest';
import {
  createLogger, createStderrSinkFailureReporter, failureErrorName, guardSink,
  type LogRecord, type LogSinkFailure,
} from './logger.js';

describe('logger', () => {
  it('emits records at or below the configured level', () => {
    const records: LogRecord[] = [];
    const log = createLogger('info', (r) => records.push(r));
    log.error('e');
    log.warn('w');
    log.info('i', { k: 1 });
    log.debug('d');
    expect(records.map((r) => r.level)).toEqual(['error', 'warn', 'info']);
    expect(records[2].data).toEqual({ k: 1 });
  });

  it('suppresses everything at level none', () => {
    const records: LogRecord[] = [];
    const log = createLogger('none', (r) => records.push(r));
    log.error('e');
    log.debug('d');
    expect(records).toHaveLength(0);
  });

  it('emits all levels at debug', () => {
    const records: LogRecord[] = [];
    const log = createLogger('debug', (r) => records.push(r));
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    expect(records).toHaveLength(4);
  });
});

describe('sink fault containment', () => {
  const record: LogRecord = { level: 'error', message: 'm' };

  it('never throws into the caller and reports the first failure, then powers of two', () => {
    const reports: LogSinkFailure[] = [];
    const log = createLogger('error', () => { throw new TypeError('EPIPE'); }, { onSinkFailure: (f) => reports.push(f) });
    for (let i = 0; i < 9; i += 1) expect(() => log.error('x')).not.toThrow();
    expect(reports).toEqual([1, 2, 4, 8].map((failures) => ({ sink: 'logger', errorName: 'TypeError', failures })));
  });

  it('names non-error throws generically and survives a throwing reporter', () => {
    expect(failureErrorName('x')).toBe('Error');
    const nameless = new Error('x');
    nameless.name = '';
    expect(failureErrorName(nameless)).toBe('Error');
    const sink = guardSink(() => { throw 'x'; }, 's', () => { throw new Error('reporter'); });
    expect(() => sink(record)).not.toThrow();
  });

  it('forwards healthy records untouched', () => {
    const seen: LogRecord[] = [];
    guardSink((r) => seen.push(r), 's')(record);
    expect(seen).toEqual([record]);
  });

  it('writes a name-only stderr line by default without leaking messages', () => {
    const lines: string[] = [];
    createStderrSinkFailureReporter((line) => lines.push(line))({ sink: 's', errorName: 'E', failures: 1 });
    expect(JSON.parse(lines[0])).toEqual({ component: 'log-sink', kind: 'failure', sink: 's', errorName: 'E', failures: 1 });
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    guardSink(() => { throw new Error('secret-token'); }, 's')(record);
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).not.toContain('secret-token');
    spy.mockRestore();
  });
});

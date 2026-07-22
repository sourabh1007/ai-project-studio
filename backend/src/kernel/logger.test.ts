import { describe, it, expect } from 'vitest';
import { createLogger, type LogRecord } from './logger.js';

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

import { describe, expect, it, vi } from 'vitest';
import { loggingDefaults } from './config.js';
import { createQueuedFileLogging } from './queued-file-logging.js';
import type { LogWriterPort } from './queued-log-sink.js';

describe('createQueuedFileLogging', () => {
  it('formats records with the configured byte budget and posts them to the writer', async () => {
    const posted: string[] = [];
    let ack: (a: { id: number }) => void = () => {};
    const port: LogWriterPort = {
      post: (b) => { posted.push(...b.entries.map((e) => e.line)); queueMicrotask(() => ack({ id: b.id })); },
      onAck: (h) => { ack = h; },
      onDown: vi.fn(),
      close: async () => true,
    };
    const q = createQueuedFileLogging({ config: { ...loggingDefaults, maxRecordBytes: 512 }, spawnWriter: () => port });
    q.sink({ level: 'info', message: 'hello', data: { a: 1 } });
    expect(await q.flush(1000)).toBe(true);
    expect(JSON.parse(posted[0]!)).toMatchObject({ level: 'info', message: 'hello' });
    expect(q.stats().written).toBe(1);
    expect(await q.close(1000)).toBe(true);
  });
});

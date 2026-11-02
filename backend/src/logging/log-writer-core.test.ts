import { describe, expect, it, vi } from 'vitest';
import { createLogWriterCore, type LogWriterResponse } from './log-writer-core.js';

const failure = (kind: 'failure' | 'recovered') => ({
  kind, operation: 'append' as const, errorName: 'Error', managed: true, fileName: 'f.log', suppressedCount: 0,
});

describe('log writer core', () => {
  it('writes batch entries in order and acks with failed=false', () => {
    const lines: string[] = [];
    const replies: LogWriterResponse[] = [];
    const core = createLogWriterCore({ writeLine: (l, at) => { lines.push(`${l}@${at.getTime()}`); }, reply: (r) => replies.push(r), stop: vi.fn() });
    core.handle({ type: 'batch', id: 7, entries: [{ line: 'a', at: 1 }, { line: 'b', at: 2 }] });
    expect(lines).toEqual(['a@1', 'b@2']);
    expect(replies).toEqual([{ type: 'ack', id: 7, failed: false }]);
  });

  it('flags a batch as failed only for failure events and resets per batch', () => {
    const replies: LogWriterResponse[] = [];
    let ok = false;
    const core = createLogWriterCore({ writeLine: () => ok, reply: (r) => replies.push(r), stop: vi.fn() });
    core.handle({ type: 'batch', id: 1, entries: [{ line: 'a', at: 1 }, { line: 'b', at: 2 }] });
    core.onFailure(failure('failure'));
    core.onFailure(failure('recovered'));
    ok = true;
    core.handle({ type: 'batch', id: 3, entries: [{ line: 'a', at: 1 }] });
    const quiet = createLogWriterCore({ writeLine: () => undefined, reply: (r) => replies.push(r), stop: vi.fn() });
    quiet.onFailure(failure('recovered'));
    quiet.handle({ type: 'batch', id: 2, entries: [] });
    expect(replies.filter((r) => r.type === 'ack')).toEqual([
      { type: 'ack', id: 1, failed: true },
      { type: 'ack', id: 3, failed: false },
      { type: 'ack', id: 2, failed: false },
    ]);
    expect(replies.filter((r) => r.type === 'failure')).toHaveLength(3);
  });

  it('acknowledges close and stops', () => {
    const stop = vi.fn();
    const replies: LogWriterResponse[] = [];
    createLogWriterCore({ writeLine: vi.fn(), reply: (r) => replies.push(r), stop }).handle({ type: 'close' });
    expect(replies).toEqual([{ type: 'closed' }]);
    expect(stop).toHaveBeenCalledOnce();
  });
});

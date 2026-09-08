import { describe, it, expect } from 'vitest';
import { decodeClientMessage, encodeServerMessage } from './terminal-protocol.js';

describe('terminal protocol v2', () => {
  it('serializes server frames and parses ordered input and resize', () => {
    const state = { type: 'state', version: 2, generation: 1, state: 'ready', inputLimit: 16 } as const;
    expect(JSON.parse(encodeServerMessage(state))).toEqual(state);
    for (const frame of [
      { type: 'input', data: 'ls\r', generation: 1, seq: 1 },
      { type: 'resize', cols: 80, rows: 24, generation: 0 },
    ]) expect(decodeClientMessage(JSON.stringify(frame))).toEqual(frame);
  });

  it('rejects malformed, unversioned, stale-shaped and invalid dimension frames', () => {
    for (const raw of ['not json', '42', 'null']) expect(decodeClientMessage(raw)).toBeNull();
    for (const frame of [
      {}, { generation: -1 }, { generation: 1, type: 'other' },
      { generation: 1, type: 'input', data: 5, seq: 1 },
      { generation: 1, type: 'input', data: '', seq: 1.5 },
      { generation: 1, type: 'input', data: '', seq: 0 },
      { generation: 1, type: 'resize', cols: 'a', rows: 1 },
      { generation: 1, type: 'resize', cols: 0, rows: 1 },
      { generation: 1, type: 'resize', cols: 1, rows: 'b' },
      { generation: 1, type: 'resize', cols: 1, rows: -1 },
    ]) expect(decodeClientMessage(JSON.stringify(frame))).toBeNull();
  });
});

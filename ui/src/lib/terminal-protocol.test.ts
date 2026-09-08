import { describe, it, expect } from 'vitest';
import { decodeServerMessage, encodeClientMessage } from './terminal-protocol.js';

describe('terminal protocol v2', () => {
  it('encodes input and resize with generation ownership', () => {
    for (const frame of [
      { type: 'input', data: 'ls\r', generation: 1, seq: 1 } as const,
      { type: 'resize', cols: 80, rows: 24, generation: 1 } as const,
    ]) expect(JSON.parse(encodeClientMessage(frame))).toEqual(frame);
  });
  const state = { type: 'state', version: 2, generation: 1, state: 'ready', inputLimit: 16 };
  const ack = { type: 'ack', generation: 1, seq: 1, outcome: 'written', reason: '' };
  it('decodes all server messages', () => {
    for (const frame of [
      state, ack, { type: 'output', data: 'hi' }, { type: 'resize', cols: 80, rows: 24 },
      { type: 'exit', code: 0 }, { type: 'exit', code: null },
    ]) expect(decodeServerMessage(JSON.stringify(frame))).toEqual(frame);
  });
  it('rejects malformed and unsupported messages', () => {
    for (const raw of ['not json', '42', 'null']) expect(decodeServerMessage(raw)).toBeNull();
    for (const frame of [
      { ...state, generation: undefined }, { ...state, generation: -1 },
      { ...state, version: 1 }, { ...state, state: 'unknown' },
      { ...state, inputLimit: 1.5 }, { ...state, inputLimit: 0 },
      { ...ack, seq: 1.5 }, { ...ack, seq: 0 }, { ...ack, outcome: 'unknown' }, { ...ack, reason: 0 },
      { type: 'output', data: 1 }, { type: 'resize', cols: 'x', rows: 1 },
      { type: 'resize', cols: 1, rows: 'x' }, { type: 'exit', code: 'x' }, { type: 'other' },
    ]) expect(decodeServerMessage(JSON.stringify(frame))).toBeNull();
  });
});

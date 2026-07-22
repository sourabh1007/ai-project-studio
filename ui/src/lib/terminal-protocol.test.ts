import { describe, it, expect } from 'vitest';
import {
  decodeServerMessage,
  encodeClientMessage,
} from './terminal-protocol.js';

describe('encodeClientMessage', () => {
  it('serializes input and resize frames', () => {
    expect(encodeClientMessage({ type: 'input', data: 'ls\n' })).toBe(
      '{"type":"input","data":"ls\\n"}',
    );
    expect(
      encodeClientMessage({ type: 'resize', cols: 80, rows: 24 }),
    ).toBe('{"type":"resize","cols":80,"rows":24}');
  });
});

describe('decodeServerMessage', () => {
  it('parses ready, output and exit frames', () => {
    expect(decodeServerMessage('{"type":"ready","sessionId":"s1"}')).toEqual({
      type: 'ready',
      sessionId: 's1',
    });
    expect(decodeServerMessage('{"type":"output","data":"hi"}')).toEqual({
      type: 'output',
      data: 'hi',
    });
    expect(decodeServerMessage('{"type":"exit","code":0}')).toEqual({
      type: 'exit',
      code: 0,
    });
    expect(decodeServerMessage('{"type":"exit","code":null}')).toEqual({
      type: 'exit',
      code: null,
    });
  });

  it('rejects invalid JSON and non-objects', () => {
    expect(decodeServerMessage('nope')).toBeNull();
    expect(decodeServerMessage('7')).toBeNull();
  });

  it('rejects frames with wrong field types', () => {
    expect(decodeServerMessage('{"type":"ready","sessionId":1}')).toBeNull();
    expect(decodeServerMessage('{"type":"output","data":1}')).toBeNull();
    expect(decodeServerMessage('{"type":"exit","code":"x"}')).toBeNull();
  });

  it('rejects unknown types', () => {
    expect(decodeServerMessage('{"type":"other"}')).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import {
  decodeClientMessage,
  encodeServerMessage,
} from './terminal-protocol.js';

describe('encodeServerMessage', () => {
  it('serializes each server message variant', () => {
    expect(encodeServerMessage({ type: 'ready', sessionId: 's1' })).toBe(
      '{"type":"ready","sessionId":"s1"}',
    );
    expect(encodeServerMessage({ type: 'output', data: 'hi' })).toBe(
      '{"type":"output","data":"hi"}',
    );
    expect(encodeServerMessage({ type: 'exit', code: 0 })).toBe(
      '{"type":"exit","code":0}',
    );
  });
});

describe('decodeClientMessage', () => {
  it('parses a valid input message', () => {
    expect(decodeClientMessage('{"type":"input","data":"ls\\n"}')).toEqual({
      type: 'input',
      data: 'ls\n',
    });
  });

  it('parses a valid resize message', () => {
    expect(decodeClientMessage('{"type":"resize","cols":80,"rows":24}')).toEqual(
      { type: 'resize', cols: 80, rows: 24 },
    );
  });

  it('rejects invalid JSON', () => {
    expect(decodeClientMessage('not json')).toBeNull();
  });

  it('rejects non-object frames', () => {
    expect(decodeClientMessage('42')).toBeNull();
    expect(decodeClientMessage('null')).toBeNull();
  });

  it('rejects input without a string data field', () => {
    expect(decodeClientMessage('{"type":"input","data":5}')).toBeNull();
  });

  it('rejects resize with non-numeric dimensions', () => {
    expect(decodeClientMessage('{"type":"resize","cols":"a","rows":1}')).toBeNull();
    expect(
      decodeClientMessage('{"type":"resize","cols":1,"rows":"b"}'),
    ).toBeNull();
  });

  it('rejects unknown message types', () => {
    expect(decodeClientMessage('{"type":"nope"}')).toBeNull();
  });
});

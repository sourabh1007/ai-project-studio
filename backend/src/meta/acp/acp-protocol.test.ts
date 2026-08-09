import { describe, it, expect } from 'vitest';
import {
  encodeRequest,
  parseMessage,
  textFromUpdate,
  stopReasonOf,
  sessionIdOf,
} from './acp-protocol.js';

describe('acp-protocol', () => {
  it('encodes a newline-terminated JSON-RPC request', () => {
    const line = encodeRequest(7, 'session/new', { cwd: 'C:\\repo' });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/new',
      params: { cwd: 'C:\\repo' },
    });
  });

  it('parses a successful response with a numeric id', () => {
    const msg = parseMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } }),
    );
    expect(msg).toEqual({
      kind: 'response',
      id: 3,
      result: { stopReason: 'end_turn' },
      error: null,
    });
  });

  it('parses an error response and defaults missing code/message', () => {
    const withFields = parseMessage(
      JSON.stringify({ id: 1, error: { code: -32000, message: 'boom' } }),
    );
    expect(withFields).toEqual({
      kind: 'response',
      id: 1,
      result: null,
      error: { code: -32000, message: 'boom' },
    });

    const defaulted = parseMessage(JSON.stringify({ id: 2, error: {} }));
    expect(defaulted).toEqual({
      kind: 'response',
      id: 2,
      result: null,
      error: { code: -1, message: 'ACP error' },
    });

    // A non-object error is treated as "no error".
    const noError = parseMessage(JSON.stringify({ id: 4, error: 'nope', result: {} }));
    expect(noError).toMatchObject({ kind: 'response', id: 4, error: null });
  });

  it('parses a notification with a method', () => {
    const msg = parseMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { a: 1 } }),
    );
    expect(msg).toEqual({
      kind: 'notification',
      method: 'session/update',
      params: { a: 1 },
    });
  });

  it('returns null for blank, non-JSON, non-object, and shapeless messages', () => {
    expect(parseMessage('')).toBeNull();
    expect(parseMessage('   ')).toBeNull();
    expect(parseMessage('not json')).toBeNull();
    expect(parseMessage('[1,2,3]')).toBeNull();
    expect(parseMessage('42')).toBeNull();
    expect(parseMessage(JSON.stringify({ jsonrpc: '2.0' }))).toBeNull();
  });

  it('extracts assistant text only from agent_message_chunk text content', () => {
    const chunk = textFromUpdate({
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    });
    expect(chunk).toBe('hi');

    expect(
      textFromUpdate({ update: { sessionUpdate: 'usage_update', used: 1 } }),
    ).toBeNull();
    expect(
      textFromUpdate({
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } },
      }),
    ).toBeNull();
    expect(
      textFromUpdate({
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 42 } },
      }),
    ).toBeNull();
    expect(textFromUpdate({ update: 'nope' })).toBeNull();
    expect(textFromUpdate(null)).toBeNull();
  });

  it('reads stop reason and session id defensively', () => {
    expect(stopReasonOf({ stopReason: 'end_turn' })).toBe('end_turn');
    expect(stopReasonOf({ stopReason: 5 })).toBeNull();
    expect(stopReasonOf(null)).toBeNull();

    expect(sessionIdOf({ sessionId: 'abc' })).toBe('abc');
    expect(sessionIdOf({ sessionId: '' })).toBeNull();
    expect(sessionIdOf({ sessionId: 9 })).toBeNull();
    expect(sessionIdOf(null)).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { isRecoverableSessionError } from './recoverable-error.js';

describe('isRecoverableSessionError', () => {
  it('treats shared transient upstream blips as recoverable', () => {
    expect(isRecoverableSessionError('HTTP 503 service unavailable')).toBe(true);
    expect(isRecoverableSessionError('read ECONNRESET')).toBe(true);
    expect(isRecoverableSessionError('rate limit exceeded (429)')).toBe(true);
  });

  it('treats a corrupted-conversation 400 as recoverable', () => {
    expect(isRecoverableSessionError('Error: 400 Bad Request')).toBe(true);
    expect(isRecoverableSessionError('request rejected (400)')).toBe(true);
    expect(isRecoverableSessionError('invalid request: history too large')).toBe(
      true,
    );
  });

  it('treats context-length overflow as recoverable', () => {
    expect(
      isRecoverableSessionError('maximum context length exceeded'),
    ).toBe(true);
    expect(isRecoverableSessionError('context_length_exceeded')).toBe(true);
    expect(isRecoverableSessionError('too many tokens in request')).toBe(true);
  });

  it('treats a slow MCP handshake / connection loss as recoverable', () => {
    expect(
      isRecoverableSessionError(
        'MCP server is taking longer than expected to connect',
      ),
    ).toBe(true);
    expect(isRecoverableSessionError('failed to connect to MCP server')).toBe(
      true,
    );
    expect(isRecoverableSessionError('connection closed unexpectedly')).toBe(
      true,
    );
    expect(isRecoverableSessionError('stream error while reading')).toBe(true);
    expect(isRecoverableSessionError('the session is corrupted')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isRecoverableSessionError('BAD REQUEST (400)')).toBe(true);
  });

  it('leaves genuine, non-recoverable output alone', () => {
    expect(isRecoverableSessionError('All tests passed')).toBe(false);
    expect(isRecoverableSessionError('file not found: foo.ts')).toBe(false);
    expect(isRecoverableSessionError('')).toBe(false);
  });
});

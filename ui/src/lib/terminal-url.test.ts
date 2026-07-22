import { describe, it, expect } from 'vitest';
import { buildTerminalWsUrl } from './terminal-url.js';

describe('buildTerminalWsUrl', () => {
  it('builds a ws URL from a relative base on an http origin', () => {
    expect(
      buildTerminalWsUrl('/api', 's 1', {
        protocol: 'http:',
        host: '127.0.0.1:4319',
      }),
    ).toBe('ws://127.0.0.1:4319/api/terminal?sessionId=s%201');
  });

  it('uses wss on an https origin', () => {
    expect(
      buildTerminalWsUrl('/api', 's1', {
        protocol: 'https:',
        host: 'app.example.com',
      }),
    ).toBe('wss://app.example.com/api/terminal?sessionId=s1');
  });

  it('maps an absolute http base to ws and appends /terminal', () => {
    expect(
      buildTerminalWsUrl('http://localhost:4319/api', 's1', {
        protocol: 'http:',
        host: 'ignored',
      }),
    ).toBe('ws://localhost:4319/api/terminal?sessionId=s1');
  });

  it('maps an absolute https base to wss', () => {
    expect(
      buildTerminalWsUrl('https://api.example.com/base/', 's1', {
        protocol: 'http:',
        host: 'ignored',
      }),
    ).toBe('wss://api.example.com/base/terminal?sessionId=s1');
  });
});

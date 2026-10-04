import { describe, it, expect } from 'vitest';
import { createCopilotRestartScanner } from './copilot-restart-scanner.js';

describe('createCopilotRestartScanner', () => {
  it('detects the MCP-reconfigured restart request and captures the reason', () => {
    const scanner = createCopilotRestartScanner();
    expect(
      scanner.feed('MCP server is modified, session needs to restart\n'),
    ).toEqual([{ reason: 'MCP server is modified' }]);
  });

  it('requests a restart only once even when the CLI repeats the line', () => {
    const scanner = createCopilotRestartScanner();
    const chunk =
      'session needs to restart\nsession needs to restart\n';
    expect(scanner.feed(chunk)).toHaveLength(1);
    // A later chunk repeating the request is suppressed.
    expect(scanner.feed('session needs to restart\n')).toEqual([]);
  });

  it('matches wording variants without a leading reason clause', () => {
    expect(
      createCopilotRestartScanner().feed('The session must be restarted\n'),
    ).toEqual([{ reason: '' }]);
    expect(
      createCopilotRestartScanner().feed('This session needs restarting.\n'),
    ).toEqual([{ reason: '' }]);
  });

  it('strips ANSI escapes before matching', () => {
    const scanner = createCopilotRestartScanner();
    expect(
      scanner.feed('\x1b[33mMCP server is modified, session needs to restart\x1b[0m\n'),
    ).toEqual([{ reason: 'MCP server is modified' }]);
  });

  it('buffers an unterminated tail until its newline arrives', () => {
    const scanner = createCopilotRestartScanner();
    expect(scanner.feed('session needs to')).toEqual([]);
    expect(scanner.feed(' restart\n')).toEqual([{ reason: '' }]);
  });

  it('ignores unrelated output', () => {
    const scanner = createCopilotRestartScanner();
    expect(scanner.feed('restarting is not needed here\n')).toEqual([]);
    expect(scanner.feed('some other log line\n')).toEqual([]);
  });

  it('bounds the internal buffer under a long line with no terminator', () => {
    const scanner = createCopilotRestartScanner();
    expect(scanner.feed('x'.repeat(200_000))).toEqual([]);
    // Still functions after truncation.
    expect(
      scanner.feed('\nMCP server is modified, session needs to restart\n'),
    ).toEqual([{ reason: 'MCP server is modified' }]);
  });
});

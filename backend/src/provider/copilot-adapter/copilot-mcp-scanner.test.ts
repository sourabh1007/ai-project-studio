import { describe, it, expect } from 'vitest';
import { createCopilotMcpScanner } from './copilot-mcp-scanner.js';

describe('createCopilotMcpScanner', () => {
  it('parses a quoted server name and reason from the CLI failure line', () => {
    const scanner = createCopilotMcpScanner();
    const errors = scanner.feed(
      '! Failed to connect to MCP server "Azure": failed to initialize MCP client: connection closed\n',
    );
    expect(errors).toEqual([
      {
        server: 'Azure',
        reason: 'failed to initialize MCP client: connection closed',
      },
    ]);
  });

  it('reports each server only once even when the CLI repeats the line', () => {
    const scanner = createCopilotMcpScanner();
    const chunk =
      'Failed to connect to MCP server "Azure": boom\nFailed to connect to MCP server "Azure": boom\n';
    expect(scanner.feed(chunk)).toHaveLength(1);
    // A later chunk repeating the same server is also suppressed.
    expect(
      scanner.feed('Failed to connect to MCP server "Azure": boom\n'),
    ).toEqual([]);
  });

  it('captures a bare (unquoted) server name with no reason', () => {
    const scanner = createCopilotMcpScanner();
    expect(
      scanner.feed('Failed to connect to MCP server github\n'),
    ).toEqual([{ server: 'github', reason: '' }]);
  });

  it('skips a match whose server name is only whitespace', () => {
    const scanner = createCopilotMcpScanner();
    expect(scanner.feed('Failed to connect to MCP server "   ": boom\n')).toEqual(
      [],
    );
  });

  it('truncates the reason at box-drawing/control chrome the TUI appends', () => {
    const scanner = createCopilotMcpScanner();
    expect(
      scanner.feed('Failed to connect to MCP server "Db": timed out \u2500\u2500\n'),
    ).toEqual([{ server: 'Db', reason: 'timed out' }]);
  });

  it('strips ANSI escapes and trailing punctuation/chrome from the reason', () => {
    const scanner = createCopilotMcpScanner();
    const errors = scanner.feed(
      '\x1b[31m! Failed to connect to MCP server "Db": initialize response.\x1b[0m\n',
    );
    expect(errors).toEqual([{ server: 'Db', reason: 'initialize response' }]);
  });

  it('buffers an unterminated tail until its newline arrives', () => {
    const scanner = createCopilotMcpScanner();
    expect(scanner.feed('Failed to connect to MCP server "Slow": still')).toEqual(
      [],
    );
    expect(scanner.feed(' going\n')).toEqual([
      { server: 'Slow', reason: 'still going' },
    ]);
  });

  it('ignores unrelated output', () => {
    const scanner = createCopilotMcpScanner();
    expect(scanner.feed('Connected to MCP server "Azure"\n')).toEqual([]);
    expect(scanner.feed('some other log line\n')).toEqual([]);
  });

  it('bounds the internal buffer under a long line with no terminator', () => {
    const scanner = createCopilotMcpScanner();
    expect(scanner.feed('x'.repeat(200_000))).toEqual([]);
    // Still functions after truncation.
    expect(
      scanner.feed('\nFailed to connect to MCP server "After": nope\n'),
    ).toEqual([{ server: 'After', reason: 'nope' }]);
  });
});

import { describe, expect, it } from 'vitest';
import { mcpCommandPreview } from './mcp-command-preview.js';

describe('redacted native command previews', () => {
  it('displays actual native executable and argv without adding a shell or duplicating the builtin', () => {
    expect(mcpCommandPreview({ command: 'C:\\Program Files\\Agency\\agency.exe', args: ['mcp', 'ado', '--organization', 'org', '--legacy'] }))
      .toBe('"C:\\Program Files\\Agency\\agency.exe" mcp ado --organization org --legacy');
    expect(mcpCommandPreview({ command: 'agency.exe', args: ['value "quoted"', 'a&b', 'line\u001bvalue'] }))
      .toBe('agency.exe "value \\"quoted\\"" "a&b" "line?value"');
  });
  it('redacts connection strings, secret flags, URL credentials and query tokens', () => {
    const preview = mcpCommandPreview({ command: 'agency.exe', args: [
      'mcp', 'logger', '--connection-string', 'private-connection', '--token=private-token',
      'https://user:password@example.test/path?sig=private-signature&other=visible',
      '[{"service_uri":"https://example.test?access_token=private-json","description":"visible"}]',
    ] })!;
    expect(preview).toContain('--connection-string');
    expect(preview).toContain('<redacted>');
    expect(preview).toContain('visible');
    expect(preview).not.toMatch(/private-|user:password/);
  });
  it.each([{}, { command: 1, args: [] }, { command: 'x' }, { command: 'x', args: [1] }])('does not invent a command for invalid launch data', (spec) => {
    expect(mcpCommandPreview(spec)).toBeUndefined();
  });
});

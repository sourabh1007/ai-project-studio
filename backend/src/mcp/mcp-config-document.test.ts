import { describe, expect, it } from 'vitest';
import { parseMcpConfigDocument } from './mcp-config-document.js';
import { ValidationError } from '../kernel/error-types.js';

describe('parseMcpConfigDocument', () => {
  it.each(['', ' \r\n\t', '\uFEFF', '\uFEFF \r\n'])('treats empty files as unconfigured (%j)', (raw) => {
    expect(parseMcpConfigDocument(raw, 'config.json')).toEqual({});
  });
  it('accepts BOM-prefixed JSON and preserves unrelated settings and server specs', () => {
    const document = { theme: 'dark', mcpServers: { example: { command: 'server', custom: true } } };
    expect(parseMcpConfigDocument('\uFEFF' + JSON.stringify(document), 'config.json')).toEqual(document);
    expect(parseMcpConfigDocument('{"theme":"dark"}', 'config.json')).toEqual({ theme: 'dark' });
  });
  it.each(['{', '{"token":"private-value",', '// comments'])('reports syntax errors without quoting content (%j)', (raw) => {
    expect(() => parseMcpConfigDocument(raw, 'C:\\config.json')).toThrow(ValidationError);
    expect(() => parseMcpConfigDocument(raw, 'C:\\config.json')).toThrow('C:\\config.json');
    expect(() => parseMcpConfigDocument(raw, 'C:\\config.json')).toThrow('Fix the file and retry');
    try { parseMcpConfigDocument(raw, 'config.json'); } catch (error) {
      expect((error as Error).message).not.toContain('private-value');
    }
  });
  it.each(['null', '[]', '42', '"text"', '{"mcpServers":null}', '{"mcpServers":[]}', '{"mcpServers":true}'])(
    'rejects invalid document shapes without treating them as empty (%s)', (raw) => {
      expect(() => parseMcpConfigDocument(raw, 'config.json')).toThrow('must be a JSON object');
    });
});

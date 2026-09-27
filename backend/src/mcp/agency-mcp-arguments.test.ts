import { describe, expect, it } from 'vitest';
import { normalizeAgencyMcpArguments } from './agency-mcp-arguments.js';

describe('native nested specification quoting', () => {
  it('removes UI JSON quote syntax without losing literal quotes, backslashes or shell metacharacters', () => {
    const value = 'org-"quoted"-C:\\folder\\file&value';
    expect(normalizeAgencyMcpArguments(` --organization ${JSON.stringify(value)} --legacy `))
      .toBe(`--organization ${value} --legacy`);
    expect(normalizeAgencyMcpArguments("--organization 'org'")).toBe('--organization org');
    expect(normalizeAgencyMcpArguments('--organization=org')).toBe('--organization=org');
    expect(normalizeAgencyMcpArguments(' \t ')).toBe('');
  });
  it.each(['agency mcp ado --organization org', 'agency config set --global --mcp ado', 'ado --organization org', '"C:\\\\Program Files\\\\agency.exe" mcp ado'])('rejects a pasted command/name rather than doubling the prefix: %s', (input) => {
    expect(() => normalizeAgencyMcpArguments(input)).toThrow(/options only/);
  });
  it.each(['--organization "org space"', '--organization ""', '--organization "\\u0000"', '--organization "\\t"'])('rejects values that the installed whitespace-splitting setter cannot preserve', (input) => {
    expect(() => normalizeAgencyMcpArguments(input)).toThrow(/cannot preserve whitespace/);
  });
  it.each(['--organization "unterminated', "--organization 'unterminated", '--organization "bad\\q"', '--organization "org"suffix', '--organization="org"'])('rejects ambiguous quoting before any mutation', (input) => {
    expect(() => normalizeAgencyMcpArguments(input)).toThrow();
  });
  it.each(['--help', '-h', '--version', '-V', '--transport=http', '--no-aec', '--entra-client-id foo'])('rejects controls not belonging to builtin configuration', (input) => {
    expect(() => normalizeAgencyMcpArguments(input)).toThrow(/proxy-level controls/);
  });
});

import { ValidationError } from '../kernel/error-types.js';

const RESERVED = new Set(['--help', '-h', '--version', '-V', '--transport', '--port', '--entra-client-id', '--no-aec', '--no-config-cache']);

/**
 * The installed --mcp setter splits its nested specification on whitespace.
 * Decode UI JSON-quoted tokens first; never persist quote syntax as option data.
 */
export function normalizeAgencyMcpArguments(input: string): string {
  const tokens: string[] = [];
  let at = 0;
  while (at < input.length) {
    if (/\s/.test(input[at])) { at += 1; continue; }
    if (input[at] === '"' || input[at] === "'") {
      const start = at;
      const quote = input[at++];
      while (at < input.length && input[at] !== quote) {
        if (quote === '"' && input[at] === '\\') at += 1;
        at += 1;
      }
      if (at >= input.length) throw new ValidationError('An option value has an unterminated quote. Use the option suggestions to quote values.');
      at += 1;
      let token: string;
      try { token = quote === '"' ? JSON.parse(input.slice(start, at)) as string : input.slice(start + 1, at - 1); }
      catch { throw new ValidationError('Use JSON-quoted option values, with escaped quotes and doubled backslashes for Windows paths.'); }
      if (at < input.length && !/\s/.test(input[at])) throw new ValidationError('Separate option values with whitespace; quote concatenation is not supported.');
      tokens.push(token);
    } else {
      const start = at;
      while (at < input.length && !/\s/.test(input[at])) at += 1;
      const token = input.slice(start, at);
      if (/^--[^=]+=["']/.test(token)) throw new ValidationError('Use separate flags and quoted values, not an inline quoted assignment.');
      tokens.push(token);
    }
  }
  if (tokens.length && !tokens[0].startsWith('-')) {
    throw new ValidationError('Enter server options only. The app supplies agency config set --global --mcp and the built-in name; do not paste a full command or repeat the name.');
  }
  if (tokens.some((token) => !token || /[\s\u0000-\u001f]/.test(token))) {
    throw new ValidationError('This installed Agency --mcp setter cannot preserve whitespace inside an option value. No configuration was written. Use a value without whitespace or configure that value with a native mechanism that preserves it.');
  }
  if (tokens.some((token) => RESERVED.has(token.split('=')[0]))) {
    throw new ValidationError('Help, version and proxy-level controls are not built-in configuration options. The app owns the command and stdio transport.');
  }
  return tokens.join(' ');
}

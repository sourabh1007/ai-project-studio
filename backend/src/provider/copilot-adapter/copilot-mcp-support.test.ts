import { describe, expect, it } from 'vitest';
import {
  COPILOT_MCP_CONFIG_FILENAME,
  createCopilotMcpSupport,
  parseCopilotMcpConfigPath,
} from './copilot-mcp-support.js';

describe('parseCopilotMcpConfigPath', () => {
  it('extracts a plain posix path', () => {
    expect(parseCopilotMcpConfigPath('/home/me/.copilot/mcp-config.json')).toBe(
      '/home/me/.copilot/mcp-config.json',
    );
  });

  it('extracts a windows path', () => {
    expect(
      parseCopilotMcpConfigPath('C:\\Users\\me\\.copilot\\mcp-config.json'),
    ).toBe('C:\\Users\\me\\.copilot\\mcp-config.json');
  });

  it('strips wrapping quotes and backticks and surrounding prose', () => {
    const reply = 'The file is here: `/root/.copilot/mcp-config.json`.';
    expect(parseCopilotMcpConfigPath(reply)).toBe(
      '/root/.copilot/mcp-config.json',
    );
  });

  it('uses the last matching token when several are present', () => {
    const reply = 'old /a/mcp-config.json now /b/mcp-config.json';
    expect(parseCopilotMcpConfigPath(reply)).toBe('/b/mcp-config.json');
  });

  it('returns null when no config path is present', () => {
    expect(parseCopilotMcpConfigPath('I do not know')).toBeNull();
  });

  it('strips wrapping quotes from a bare filename match', () => {
    expect(parseCopilotMcpConfigPath('"mcp-config.json"')).toBe(
      'mcp-config.json',
    );
  });
});

describe('createCopilotMcpSupport', () => {
  it('exposes a discovery prompt naming the config filename', () => {
    const support = createCopilotMcpSupport();
    expect(support.configPathPrompt).toContain(COPILOT_MCP_CONFIG_FILENAME);
  });

  it('delegates path parsing to parseCopilotMcpConfigPath', () => {
    const support = createCopilotMcpSupport();
    expect(support.parseConfigPath('/x/mcp-config.json')).toBe(
      '/x/mcp-config.json',
    );
  });

  it('defaults to the copilot home config file', () => {
    const support = createCopilotMcpSupport();
    const path = support.defaultConfigPath();
    expect(path.endsWith(COPILOT_MCP_CONFIG_FILENAME)).toBe(true);
    expect(path).toContain('.copilot');
  });
});

import { describe, it, expect } from 'vitest';
import { mcpConfigSchema, mcpDefaults, MCP_NAMESPACE } from './config.js';

describe('mcp config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(MCP_NAMESPACE).toBe('mcp');
    expect(() => mcpConfigSchema.parse(mcpDefaults)).not.toThrow();
  });

  it('requires a positive integer discovery timeout', () => {
    expect(() =>
      mcpConfigSchema.parse({ enabled: true, discoveryTimeoutMs: 0 }),
    ).toThrow();
    expect(() =>
      mcpConfigSchema.parse({ enabled: true, discoveryTimeoutMs: 1.5 }),
    ).toThrow();
  });
});

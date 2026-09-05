import { describe, it, expect } from 'vitest';
import {
  buildCopilotArgs,
  buildCopilotCommand,
  buildCopilotInteractiveArgs,
} from './copilot-cmd-builder.js';
import { copilotDefaults, type CopilotConfig } from './config.js';
import type { SessionSpec } from '../provider-contract.js';

const spec: SessionSpec = {
  sessionId: 'sess-1',
  featureId: 'feat-1',
  prompt: 'do the thing',
  model: 'gpt-5.4',
  kind: 'dev',
  otelFilePath: '/tmp/o.jsonl',
};

describe('copilot-cmd-builder', () => {
  it('builds core args with tools + silent by default', () => {
    const args = buildCopilotArgs(spec, copilotDefaults);
    expect(args).toEqual([
      '-p',
      'do the thing',
      '--model',
      'gpt-5.4',
      '--session-id',
      'sess-1',
      '--output-format',
      'json',
      '--no-color',
      '--allow-all-tools',
      '-s',
    ]);
  });

  it('omits tool/silent flags when disabled and appends extraArgs', () => {
    const config: CopilotConfig = {
      ...copilotDefaults,
      allowAllTools: false,
      silent: false,
      extraArgs: ['--effort', 'high'],
    };
    const args = buildCopilotArgs(spec, config);
    expect(args).not.toContain('--allow-all-tools');
    expect(args).not.toContain('-s');
    expect(args.slice(-2)).toEqual(['--effort', 'high']);
  });

  it('maps initial attachments to repeated documented flags without inlining content', () => {
    const attachmentContent = 'x'.repeat(40_000);
    const args = buildCopilotArgs(
      {
        ...spec,
        prompt: 'Analyze the attached request.',
        attachments: ['C:\\Temp\\aps-a\\p.md', 'C:\\Temp\\aps-b\\p.md'],
      },
      copilotDefaults,
    );

    expect(args).toContain('Analyze the attached request.');
    expect(args).toEqual(
      expect.arrayContaining([
        '--attachment',
        'C:\\Temp\\aps-a\\p.md',
        'C:\\Temp\\aps-b\\p.md',
      ]),
    );
    expect(args.filter((arg) => arg === '--attachment')).toHaveLength(2);
    expect(attachmentContent.length).toBeGreaterThan(32_768);
    expect(args.every((arg) => !arg.includes(attachmentContent))).toBe(true);
  });

  it('restricts to zero tools and skips allow-all when noTools is set', () => {
    const args = buildCopilotArgs({ ...spec, noTools: true }, copilotDefaults);
    expect(args).toContain('--available-tools');
    expect(args).not.toContain('--allow-all-tools');
  });

  it('disables built-in and user MCP servers for meta sessions', () => {
    const args = buildCopilotArgs(
      { ...spec, kind: 'meta' },
      copilotDefaults,
      ['github', 'azure'],
    );
    expect(args).toContain('--disable-builtin-mcps');
    expect(args).toEqual(
      expect.arrayContaining([
        '--disable-mcp-server',
        'github',
        '--disable-mcp-server',
        'azure',
      ]),
    );
    expect(args.filter((a) => a === '--disable-mcp-server')).toHaveLength(2);
  });

  it('leaves MCP servers enabled for interactive dev sessions', () => {
    const args = buildCopilotArgs(spec, copilotDefaults, ['github']);
    expect(args).not.toContain('--disable-builtin-mcps');
    expect(args).not.toContain('--disable-mcp-server');
  });

  it('disables only the built-in MCP server for meta sessions with no user servers', () => {
    const args = buildCopilotArgs({ ...spec, kind: 'meta' }, copilotDefaults);
    expect(args).toContain('--disable-builtin-mcps');
    expect(args).not.toContain('--disable-mcp-server');
  });

  it('buildCopilotCommand pairs executable with args', () => {
    const config = { ...copilotDefaults, executable: '/opt/copilot' };
    const cmd = buildCopilotCommand(spec, config);
    expect(cmd.command).toBe('/opt/copilot');
    expect(cmd.args[0]).toBe('-p');
  });

  it('builds interactive args without -p/json and with tools by default', () => {
    const args = buildCopilotInteractiveArgs(spec, copilotDefaults);
    expect(args).toEqual([
      '--model',
      'gpt-5.4',
      '--session-id',
      'sess-1',
      '--allow-all-tools',
    ]);
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--output-format');
    expect(args).not.toContain('--no-color');
  });

  it('interactive args omit tools when disabled and append extraArgs', () => {
    const config: CopilotConfig = {
      ...copilotDefaults,
      allowAllTools: false,
      extraArgs: ['--banner'],
    };
    const args = buildCopilotInteractiveArgs(spec, config);
    expect(args).not.toContain('--allow-all-tools');
    expect(args.at(-1)).toBe('--banner');
  });

  it('includes initial attachments in interactive args', () => {
    const args = buildCopilotInteractiveArgs(
      { ...spec, attachments: ['C:\\Temp\\aps-a\\p.md'] },
      copilotDefaults,
    );
    expect(args).toContain('--attachment');
    expect(args).toContain('C:\\Temp\\aps-a\\p.md');
  });
});

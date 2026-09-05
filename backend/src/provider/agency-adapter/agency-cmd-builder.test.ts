import { describe, it, expect } from 'vitest';
import { buildAgencyCommand } from './agency-cmd-builder.js';
import { agencyDefaults, type AgencyConfig } from './config.js';
import type { SessionSpec } from '../provider-contract.js';

const spec: SessionSpec = {
  sessionId: 'sess-1',
  featureId: 'feat-1',
  prompt: 'do the thing',
  model: 'claude-sonnet-4.5',
  kind: 'dev',
  otelFilePath: '/tmp/o.jsonl',
};

describe('agency-cmd-builder', () => {
  it('wraps the copilot passthrough after `<subcommand> --`', () => {
    const cmd = buildAgencyCommand(spec, agencyDefaults);
    expect(cmd.command).toBe('agency');
    expect(cmd.args.slice(0, 2)).toEqual(['copilot', '--']);
    expect(cmd.args).toContain('--allow-all-tools');
    expect(cmd.args).toContain('-s');
    expect(cmd.args.slice(2, 8)).toEqual([
      '-p',
      'do the thing',
      '--model',
      'claude-sonnet-4.5',
      '--session-id',
      'sess-1',
    ]);
  });

  it('honours custom executable/subcommand and disabled flags', () => {
    const config: AgencyConfig = {
      ...agencyDefaults,
      executable: '/opt/agency',
      subcommand: 'copilot',
      allowAllTools: false,
      silent: false,
      extraArgs: ['--effort', 'high'],
    };
    const cmd = buildAgencyCommand(spec, config);
    expect(cmd.command).toBe('/opt/agency');
    expect(cmd.args).not.toContain('--allow-all-tools');
    expect(cmd.args).not.toContain('-s');
    expect(cmd.args.slice(-2)).toEqual(['--effort', 'high']);
  });

  it('passes repeated attachment flags through without a large prompt argument', () => {
    const attachmentContent = 'repository evidence '.repeat(2_000);
    const cmd = buildAgencyCommand(
      {
        ...spec,
        prompt: 'Analyze the attached request.',
        attachments: ['C:\\Temp\\aps-a\\p.md', 'C:\\Temp\\aps-b\\p.md'],
      },
      agencyDefaults,
    );

    expect(cmd.args.filter((arg) => arg === '--attachment')).toHaveLength(2);
    expect(cmd.args).toContain('C:\\Temp\\aps-a\\p.md');
    expect(cmd.args).toContain('C:\\Temp\\aps-b\\p.md');
    expect(attachmentContent.length).toBeGreaterThan(32_768);
    expect(cmd.args.every((arg) => !arg.includes(attachmentContent))).toBe(true);
  });

  it('disables MCP servers in the copilot passthrough for meta sessions', () => {
    const cmd = buildAgencyCommand({ ...spec, kind: 'meta' }, agencyDefaults, [
      'github',
    ]);
    expect(cmd.args.slice(0, 2)).toEqual(['copilot', '--']);
    expect(cmd.args).toContain('--disable-builtin-mcps');
    expect(cmd.args).toEqual(
      expect.arrayContaining(['--disable-mcp-server', 'github']),
    );
  });
});

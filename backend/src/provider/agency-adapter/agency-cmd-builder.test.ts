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
});

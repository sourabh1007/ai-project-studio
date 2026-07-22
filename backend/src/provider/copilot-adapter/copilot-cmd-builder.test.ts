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
});

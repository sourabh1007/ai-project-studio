import { describe, it, expect } from 'vitest';
import { buildPlanUsageProbeCommand } from './plan-usage-command.js';

const base = {
  model: 'auto',
  sessionId: 'sid-123',
  copilot: { executable: 'copilot' },
  agency: { executable: 'agency', subcommand: 'copilot' },
};

describe('buildPlanUsageProbeCommand', () => {
  it('boots the Copilot TUI directly for the copilot provider', () => {
    expect(
      buildPlanUsageProbeCommand({ ...base, providerId: 'copilot' }),
    ).toEqual({
      command: 'copilot',
      args: ['--model', 'auto', '--session-id', 'sid-123'],
    });
  });

  it.each(['something-else', 'claude'])('rejects unsupported quota providers without launching Copilot: %s', (providerId) => {
    expect(() =>
      buildPlanUsageProbeCommand({ ...base, providerId }),
    ).toThrow(`Plan AI-credit quota is unavailable for provider '${providerId}'`);
  });

  it('wraps the probe through the Agency CLI for the agency provider', () => {
    expect(
      buildPlanUsageProbeCommand({ ...base, providerId: 'agency' }),
    ).toEqual({
      command: 'agency',
      args: ['copilot', '--', '--model', 'auto', '--session-id', 'sid-123'],
    });
  });

  it('pins the requested model and session id into the Agency passthrough', () => {
    expect(
      buildPlanUsageProbeCommand({
        ...base,
        providerId: 'agency',
        model: 'claude-opus',
        sessionId: 'uuid-9',
        agency: { executable: '/opt/agency', subcommand: 'gh-copilot' },
      }),
    ).toEqual({
      command: '/opt/agency',
      args: [
        'gh-copilot',
        '--',
        '--model',
        'claude-opus',
        '--session-id',
        'uuid-9',
      ],
    });
  });
});

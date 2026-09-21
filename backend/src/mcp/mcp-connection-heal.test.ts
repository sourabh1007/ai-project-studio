import { describe, expect, it, vi } from 'vitest';
import {
  healMcpConnection,
  type McpProbeOutcome,
} from './mcp-connection-heal.js';

/** A probe that returns each queued outcome in order, repeating the last. */
function scriptedProbe(outcomes: McpProbeOutcome[]) {
  let index = 0;
  return vi.fn(async () => {
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;
    return outcome;
  });
}

const connected: McpProbeOutcome = { kind: 'connected', toolCount: 3 };
const authRequired: McpProbeOutcome = {
  kind: 'auth-required',
  authUrl: 'https://login.example.com',
  message: 'Sign in required',
};
function errorOutcome(message: string | null): McpProbeOutcome {
  return { kind: 'error', message, output: ['line one', 'line two'] };
}

describe('healMcpConnection', () => {
  it('returns immediately with no attempts when the first probe connects', async () => {
    const probe = scriptedProbe([connected]);
    const result = await healMcpConnection({ probe });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.outcome).toEqual(connected);
    expect(result.attempts).toEqual([]);
  });

  it('does not self-heal an auth-required outcome', async () => {
    const probe = scriptedProbe([authRequired]);
    const diagnose = vi.fn(async () => 'unused');
    const result = await healMcpConnection({ probe, diagnose });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(diagnose).not.toHaveBeenCalled();
    expect(result.outcome).toEqual(authRequired);
    expect(result.attempts).toEqual([]);
  });

  it('recovers on retry and records the recovered step', async () => {
    const probe = scriptedProbe([errorOutcome('boom'), connected]);
    const result = await healMcpConnection({ probe });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(result.outcome).toEqual(connected);
    expect(result.attempts).toEqual([
      {
        action: 'Probed the live server connection',
        outcome: 'failed',
        detail: 'boom',
      },
      { action: 'Retried the connection', outcome: 'recovered', detail: null },
    ]);
  });

  it('falls back on a null error message and runs a diagnosis when retries fail', async () => {
    const probe = scriptedProbe([errorOutcome(null), errorOutcome('still down')]);
    const diagnose = vi.fn(async () => '  The command path is missing.  ');
    const result = await healMcpConnection({ probe, diagnose });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(diagnose).toHaveBeenCalledWith('still down', ['line one', 'line two']);
    expect(result.outcome.kind).toBe('error');
    expect(result.attempts).toEqual([
      {
        action: 'Probed the live server connection',
        outcome: 'failed',
        detail: 'The server exited before tool discovery completed.',
      },
      {
        action: 'Retried the connection',
        outcome: 'failed',
        detail: 'still down',
      },
      {
        action: 'Ran an AI self-healing diagnosis',
        outcome: 'info',
        detail: 'The command path is missing.',
      },
    ]);
  });

  it('marks the diagnosis failed when it returns only whitespace', async () => {
    const probe = scriptedProbe([errorOutcome('boom')]);
    const diagnose = vi.fn(async () => '   ');
    const result = await healMcpConnection({ probe, diagnose, retries: 0 });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.attempts.at(-1)).toEqual({
      action: 'Ran an AI self-healing diagnosis',
      outcome: 'failed',
      detail: 'The self-healing diagnosis was unavailable.',
    });
  });

  it('marks the diagnosis failed when it returns null', async () => {
    const probe = scriptedProbe([errorOutcome('boom')]);
    const diagnose = vi.fn(async () => null);
    const result = await healMcpConnection({ probe, diagnose, retries: 0 });
    expect(result.attempts.at(-1)?.outcome).toBe('failed');
  });

  it('treats a thrown diagnosis as unavailable', async () => {
    const probe = scriptedProbe([errorOutcome('boom')]);
    const diagnose = vi.fn(async () => {
      throw new Error('meta down');
    });
    const result = await healMcpConnection({ probe, diagnose, retries: 0 });
    expect(result.attempts.at(-1)).toEqual({
      action: 'Ran an AI self-healing diagnosis',
      outcome: 'failed',
      detail: 'The self-healing diagnosis was unavailable.',
    });
  });

  it('omits the diagnosis detail when no diagnoser is supplied', async () => {
    const probe = scriptedProbe([errorOutcome('boom')]);
    const result = await healMcpConnection({ probe, retries: 0 });
    expect(result.attempts).toEqual([
      {
        action: 'Probed the live server connection',
        outcome: 'failed',
        detail: 'boom',
      },
      {
        action: 'Ran an AI self-healing diagnosis',
        outcome: 'failed',
        detail: 'The self-healing diagnosis was unavailable.',
      },
    ]);
  });
});

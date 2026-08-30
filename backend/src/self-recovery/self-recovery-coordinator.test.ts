import { describe, it, expect, vi } from 'vitest';
import {
  createSelfRecoveryCoordinator,
  type SelfRecoveryCoordinatorDeps,
} from './self-recovery-coordinator.js';

function make(overrides: Partial<SelfRecoveryCoordinatorDeps> = {}): {
  deps: SelfRecoveryCoordinatorDeps;
  notify: ReturnType<typeof vi.fn>;
  report: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
} {
  const notify = vi.fn<(text: string) => void>();
  const report = vi.fn<(message: string) => void>();
  const restart = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const deps: SelfRecoveryCoordinatorDeps = {
    useMetaAnalysis: true,
    restart,
    notify,
    report,
    ...overrides,
  };
  return { deps, notify, report, restart };
}

describe('createSelfRecoveryCoordinator', () => {
  it('surfaces a metasession diagnosis then restarts, no report on success', async () => {
    const analyze = vi
      .fn<(text: string) => Promise<string | null>>()
      .mockResolvedValue('  History is too large — a restart will clear it.  ');
    const { deps, notify, report, restart } = make({ analyze });

    await createSelfRecoveryCoordinator(deps).escalate('400 Bad Request');

    expect(analyze).toHaveBeenCalledWith('400 Bad Request');
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        'History is too large — a restart will clear it.',
      ),
    );
    expect(restart).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it('skips the diagnosis notice when analysis has nothing to add', async () => {
    const analyze = vi
      .fn<(text: string) => Promise<string | null>>()
      .mockResolvedValue('   ');
    const { deps, notify } = make({ analyze });

    await createSelfRecoveryCoordinator(deps).escalate('boom');

    // Only the "restarting…" notice, never an empty diagnosis line.
    expect(
      notify.mock.calls.some(([text]) =>
        (text as string).includes('restarting'),
      ),
    ).toBe(true);
    expect(
      notify.mock.calls.some(([text]) =>
        (text as string).includes('undefined'),
      ),
    ).toBe(false);
  });

  it('handles a null diagnosis without notifying', async () => {
    const analyze = vi
      .fn<(text: string) => Promise<string | null>>()
      .mockResolvedValue(null);
    const { deps, report } = make({ analyze });

    await createSelfRecoveryCoordinator(deps).escalate('boom');

    expect(report).not.toHaveBeenCalled();
  });

  it('skips analysis entirely when useMetaAnalysis is off', async () => {
    const analyze = vi.fn<(text: string) => Promise<string | null>>();
    const { deps, restart } = make({ useMetaAnalysis: false, analyze });

    await createSelfRecoveryCoordinator(deps).escalate('boom');

    expect(analyze).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('skips analysis when no analyzer is provided', async () => {
    const { deps, restart } = make({ analyze: undefined });

    await createSelfRecoveryCoordinator(deps).escalate('boom');

    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('reports a plain failure when the restart could not run', async () => {
    const analyze = vi
      .fn<(text: string) => Promise<string | null>>()
      .mockResolvedValue('cause');
    const restart = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const { deps, report } = make({ analyze, restart });

    await createSelfRecoveryCoordinator(deps).escalate('boom');

    expect(report).toHaveBeenCalledWith(
      'Automatic recovery failed. Restart the session to continue.',
    );
  });

  it('reports that analysis was unavailable when the metasession could not start', async () => {
    const analyze = vi
      .fn<(text: string) => Promise<string | null>>()
      .mockRejectedValue(new Error('meta down'));
    const restart = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const { deps, report } = make({ analyze, restart });

    await createSelfRecoveryCoordinator(deps).escalate('boom');

    expect(report).toHaveBeenCalledWith(
      'Automatic recovery failed and the analysis session could not start. Restart the session to continue.',
    );
  });

  it('does not report when analysis failed but the restart recovered', async () => {
    const analyze = vi
      .fn<(text: string) => Promise<string | null>>()
      .mockRejectedValue(new Error('meta down'));
    const { deps, report } = make({ analyze });

    await createSelfRecoveryCoordinator(deps).escalate('boom');

    expect(report).not.toHaveBeenCalled();
  });

  it('treats a thrown restart as a failed recovery', async () => {
    const restart = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValue(new Error('spawn failed'));
    const { deps, report } = make({ useMetaAnalysis: false, restart });

    await createSelfRecoveryCoordinator(deps).escalate('boom');

    expect(report).toHaveBeenCalledWith(
      'Automatic recovery failed. Restart the session to continue.',
    );
  });
});

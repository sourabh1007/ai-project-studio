import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../session/session-contract.js';
import { createSessionLaunchCwdResolver } from './session-launch-cwd.js';
import { createApplicationWork } from '../lifecycle/application-work.js';

const session: Session = {
  id: 's1', featureId: 'f1', name: null, provider: 'copilot', requestedModel: 'auto',
  resolvedModel: null, status: 'created', kind: 'dev', prompt: '', usageFilePath: '',
  createdAt: '', startedAt: null, endedAt: null, exitCode: null,
};
const checkout = { worktreePath: 'C:\\isolated', branch: 'master' };
function fixture() {
  const deps = {
    getSession: vi.fn((id: string): Session | null => ({ ...session, id })),
    pathExists: vi.fn(async () => true),
    resolveTarget: vi.fn(async () => ({ repoLocalPath: 'C:\\repo', ref: 'master' }) as { repoLocalPath: string; ref: string } | null),
    fallbackCwd: vi.fn(() => 'C:\\scratch'),
    prepare: vi.fn(async (_session: Session, _target: unknown, report: (message: string) => void) => {
      report('Checking branch');
      return 'C:\\repo';
    }),
  };
  return { deps, resolve: createSessionLaunchCwdResolver(deps) };
}
describe('session launch cwd', () => {
  it('keeps branch preparation owned even if every view disconnects', async () => {
    const f = fixture();
    const work = createApplicationWork();
    let finish!: () => void;
    f.deps.prepare.mockImplementation(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return 'C:\\repo';
    });
    const resolve = createSessionLaunchCwdResolver({
      ...f.deps, own: (value, prepare) => work.own(prepare, { sessionId: value.id, featureId: value.featureId }),
    });
    const controller = new AbortController();
    const waiting = resolve(session, undefined, controller.signal);
    const abandoned = expect(waiting).rejects.toThrow('closed');
    await vi.waitFor(() => expect(f.deps.prepare).toHaveBeenCalledOnce());
    controller.abort(new Error('closed')); await abandoned;
    expect(await work.quiesceFeature(session.featureId, 1)).toBe(false);
    finish();
    expect(await work.waitForIdle(1000)).toBe(true);
    await vi.waitFor(() => expect(resolve(session)).rejects.toThrow('blocked'));
  });
  it('reuses the latest persisted session checkout, without resetting its branch', async () => {
    const f = fixture();
    f.deps.getSession.mockReturnValue({ ...session, ...checkout });
    await expect(f.resolve(session)).resolves.toBe(checkout.worktreePath);
    expect(f.deps.resolveTarget).not.toHaveBeenCalled();
    expect(f.deps.prepare).not.toHaveBeenCalled();
  });
  it('uses the shared checkout for missing paths and accepts a session snapshot', async () => {
    const f = fixture();
    f.deps.pathExists.mockResolvedValue(false);
    await expect(f.resolve({ ...session, ...checkout })).resolves.toBe('C:\\repo');
    f.deps.getSession.mockReturnValue(null);
    await expect(f.resolve({ ...session, ...checkout })).resolves.toBe('C:\\repo');
    expect(f.deps.fallbackCwd).not.toHaveBeenCalled();
  });
  it('uses legacy cwd only for repository-less sessions', async () => {
    const f = fixture();
    f.deps.resolveTarget.mockResolvedValue(null);
    await expect(f.resolve(session)).resolves.toBe('C:\\scratch');
    expect(f.deps.prepare).not.toHaveBeenCalled();
  });
  it('fans out progress and coalesces reconnects without duplicating branch preparation', async () => {
    const f = fixture();
    let finish!: () => void;
    let progress!: (message: string) => void;
    f.deps.prepare.mockImplementation(async (_session, _target, report) => {
      progress = report;
      report('Checking branch');
      await new Promise<void>((resolve) => { finish = resolve; });
      return 'C:\\repo';
    });
    const controller = new AbortController();
    const first = vi.fn();
    const one = f.resolve(session, first, controller.signal);
    const abandoned = expect(one).rejects.toThrow('view closed');
    await vi.waitFor(() => expect(f.deps.prepare).toHaveBeenCalledOnce());
    const second = vi.fn();
    const two = f.resolve(session, second);
    expect(second).toHaveBeenCalledWith('Checking branch');
    controller.abort(new Error('view closed'));
    await abandoned;
    const count = first.mock.calls.length;
    progress('Updating files: 50%');
    expect(first).toHaveBeenCalledTimes(count);
    expect(second).toHaveBeenLastCalledWith('Updating files: 50%');
    finish();
    await expect(two).resolves.toBe('C:\\repo');
    expect(f.deps.prepare).toHaveBeenCalledOnce();
  });
  it('tracks separate session waits and tolerates a reporter whose socket closed', async () => {
    const f = fixture();
    await Promise.all([
      f.resolve(session, () => { throw new Error('socket closed'); }),
      f.resolve({ ...session, id: 's2' }),
    ]);
    expect(f.deps.prepare).toHaveBeenCalledTimes(2);
    expect(f.deps.prepare.mock.calls.map(([value]) => value.id)).toEqual(['s1', 's2']);
  });
  it('never falls back on preparation failures and permits a subsequent retry', async () => {
    const f = fixture();
    f.deps.prepare.mockRejectedValueOnce(new Error('checkout timed out'));
    await expect(f.resolve(session)).rejects.toThrow('checkout timed out');
    expect(f.deps.fallbackCwd).not.toHaveBeenCalled();
    await expect(f.resolve(session)).resolves.toBe('C:\\repo');
  });
  it('rejects an already disconnected client before provisioning', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error('closed'));
    await expect(f.resolve(session, undefined, controller.signal)).rejects.toThrow('closed');
    expect(f.deps.getSession).not.toHaveBeenCalled();
  });
});

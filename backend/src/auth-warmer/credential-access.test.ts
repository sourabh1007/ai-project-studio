import { describe, expect, it, vi } from 'vitest';
import type { CredentialRead } from '../kernel/credential-read.js';
import { createCredentialRefresh } from './credential-refresh.js';
import { readAccountCredential, readAccountStatus, readFirstCredential } from './credential-access.js';

describe('account status and child credential synchronization', () => {
  it('publishes the current native credential before acknowledging an external sign-in', async () => {
    const apply = vi.fn();
    const refresh = createCredentialRefresh<string | null>({ read: async () => 'external login', apply });
    const status = { authenticated: true, login: 'current account' };
    expect(await readAccountStatus(refresh, async () => status)).toBe(status);
    expect(apply).toHaveBeenCalledWith('external login');
  });

  it('does not clear another target credential when this target is signed out', async () => {
    const read = vi.fn(async () => null);
    const apply = vi.fn();
    const refresh = createCredentialRefresh<string | null>({ read, apply });
    expect(await readAccountStatus(refresh, async () => ({ authenticated: false }))).toEqual({ authenticated: false });
    expect(read).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('reports an unavailable credential refresh without acknowledging stale child credentials', async () => {
    const apply = vi.fn();
    const refresh = createCredentialRefresh<string | null>({
      read: async () => { throw new Error('keyring unavailable'); }, apply,
    });
    await expect(readAccountStatus(refresh, async () => ({ authenticated: true }))).rejects.toThrow('keyring unavailable');
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects a stale account status without starting a refresh', async () => {
    const read = vi.fn(async () => 'new account');
    const refresh = createCredentialRefresh<string | null>({ read, apply: vi.fn() });
    let complete!: (status: { authenticated: boolean }) => void;
    const result = readAccountStatus(refresh, () => new Promise<{ authenticated: boolean }>((resolve) => { complete = resolve; }));
    await Promise.resolve();
    refresh.invalidate();
    complete({ authenticated: true });
    await expect(result).rejects.toMatchObject({ kind: 'conflict' });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a sign-in status when sign-out starts while its child credential is refreshing', async () => {
    let complete!: (token: string | null) => void;
    const read = vi.fn(() => new Promise<string | null>((resolve) => { complete = resolve; }));
    const apply = vi.fn();
    const refresh = createCredentialRefresh<string | null>({ read, apply });
    const result = readAccountStatus(refresh, async () => ({ authenticated: true }));
    const outcome = expect(result).rejects.toMatchObject({ kind: 'conflict' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const suspended = refresh.suspend(null);
    complete('old account');
    const resume = await suspended;
    await outcome;
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(null);
    resume();
  });

  it('does not run account status checks while sign-out owns the credential cache', async () => {
    const refresh = createCredentialRefresh<string | null>({ read: async () => null, apply: vi.fn() });
    const resume = await refresh.suspend(null);
    const read = vi.fn(async () => ({ authenticated: true }));
    await expect(readAccountStatus(refresh, read)).rejects.toMatchObject({ kind: 'conflict' });
    expect(read).not.toHaveBeenCalled();
    resume();
  });
});

describe('account credential access', () => {
  function setup() {
    let snapshot: string | null = 'last good';
    const refresh = createCredentialRefresh<string | null>({
      read: async () => null, apply: (value) => { snapshot = value; },
    });
    return { refresh, snapshot: () => snapshot };
  }

  it('publishes and returns a usable credential', async () => {
    const s = setup();
    expect(await readAccountCredential(s.refresh, async () => ({ state: 'ready', token: 'current' }))).toBe('current');
    expect(s.snapshot()).toBe('current');
  });

  it.each(['signed-out', 'interaction-required'] as const)('preserves the consumer sign-in path for %s without clearing another target snapshot', async (state) => {
    const s = setup();
    expect(await readAccountCredential(s.refresh, async () => ({ state }))).toBeNull();
    expect(s.snapshot()).toBe('last good');
  });

  it('reports an unavailable lookup rather than incorrectly requiring sign-in or clearing the snapshot', async () => {
    const s = setup();
    await expect(readAccountCredential(s.refresh, async () => ({ state: 'unavailable' }))).rejects.toMatchObject({ kind: 'unavailable' });
    expect(s.snapshot()).toBe('last good');
  });

  it('rejects consumer requests during sign-out without executing a native read', async () => {
    const s = setup();
    const resume = await s.refresh.suspend(null);
    const read = vi.fn(async (): Promise<CredentialRead> => ({ state: 'ready', token: 'old account' }));
    await expect(readAccountCredential(s.refresh, read)).rejects.toMatchObject({ kind: 'conflict' });
    expect(read).not.toHaveBeenCalled();
    expect(s.snapshot()).toBeNull();
    resume();
  });

  it('never returns or publishes a credential if the account changed during its lookup', async () => {
    const s = setup();
    let complete!: (result: CredentialRead) => void;
    const result = readAccountCredential(s.refresh, () => new Promise<CredentialRead>((resolve) => { complete = resolve; }));
    await Promise.resolve();
    s.refresh.invalidate();
    s.refresh.publish(s.refresh.generation(), 'new account');
    complete({ state: 'ready', token: 'old account' });
    await expect(result).rejects.toMatchObject({ kind: 'conflict' });
    expect(s.snapshot()).toBe('new account');
  });
});

describe('remembered account target refresh', () => {
  it.each<{ results: CredentialRead[]; expected: CredentialRead }>([
    { results: [], expected: { state: 'signed-out' } },
    { results: [{ state: 'signed-out' }], expected: { state: 'signed-out' } },
    { results: [{ state: 'signed-out' }, { state: 'interaction-required' }, { state: 'signed-out' }], expected: { state: 'interaction-required' } },
    { results: [{ state: 'unavailable' }, { state: 'interaction-required' }, { state: 'signed-out' }], expected: { state: 'unavailable' } },
    { results: [{ state: 'interaction-required' }, { state: 'unavailable' }], expected: { state: 'unavailable' } },
    { results: [{ state: 'unavailable' }, { state: 'ready', token: 'later organization' }], expected: { state: 'ready', token: 'later organization' } },
    { results: [{ state: 'interaction-required' }, { state: 'ready', token: 'current' }], expected: { state: 'ready', token: 'current' } },
    { results: [{ state: 'ready', token: 'first' }, { state: 'unavailable' }], expected: { state: 'ready', token: 'first' } },
  ])('continues past unavailable targets and preserves uncertainty when no target is usable: $results', async ({ results, expected }) => {
    const read = vi.fn(async (index: number) => results[index]);
    expect(await readFirstCredential(results.keys(), read)).toEqual(expected);
    const firstReady = results.findIndex((result) => result.state === 'ready');
    expect(read).toHaveBeenCalledTimes(firstReady < 0 ? results.length : firstReady + 1);
  });
});

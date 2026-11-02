import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpAuthenticationJobs } from './mcp-authentication-jobs.js';
import type { McpServerEntry } from './mcp-contract.js';

function setup(maxConcurrent = 1, maxRetained = 20) {
  let id = 0;
  const jobs = createMcpAuthenticationJobs({
    id: () => `job-${++id}`, now: () => 1000, timeoutMs: 5000, maxConcurrent, maxRetained,
  });
  const active: Array<{
    signal: AbortSignal; progress: (output: readonly string[]) => void;
    resolve: (entry: McpServerEntry) => void; reject: (error: Error) => void;
  }> = [];
  const run = vi.fn((signal: AbortSignal, progress: (output: readonly string[]) => void) =>
    new Promise<McpServerEntry>((resolve, reject) => { active.push({ signal, progress, resolve, reject }); }));
  return { jobs, run, active };
}
const good: McpServerEntry = { name: 'native:ado', spec: {}, toolDiscovery: { status: 'ok', output: [], message: null }, tools: [] };
afterEach(() => vi.useRealTimers());

describe('bounded explicit native authentication jobs', () => {
  it('does not report completed sign-in when inventory arrives while a native challenge remains unverified', async () => {
    const s = setup();
    const job = s.jobs.start({ owner: 'agency/native:ado', serverName: 'native:ado', run: s.run });
    expect(job).toMatchObject({ id: 'job-1', status: 'pending', authUrl: null, deviceCode: null, expiresAt: '1970-01-01T00:00:06.000Z' });
    expect(s.run).not.toHaveBeenCalled();
    await Promise.resolve();
    s.active[0].progress(['Starting native fixture']);
    expect(s.jobs.get('agency/native:ado', job.id).authUrl).toBeNull();
    s.active[0].progress(['Authentication required']);
    expect(s.jobs.get('agency/native:ado', job.id).message).toContain('no safe embedded challenge');
    s.active[0].progress(['To sign in, open https://microsoft.com/devicelogin and enter the code ABCD12345']);
    expect(s.active[0].signal.aborted).toBe(false);
    expect(s.jobs.get('agency/native:ado', job.id)).toMatchObject({ status: 'pending', authUrl: 'https://microsoft.com/devicelogin', deviceCode: 'ABCD12345' });
    s.active[0].resolve(good);
    await vi.waitFor(() => expect(s.jobs.get('agency/native:ado', job.id).status).toBe('failed'));
    expect(s.jobs.get('agency/native:ado', job.id)).toMatchObject({ authUrl: null, deviceCode: null, server: good });
    expect(s.jobs.get('agency/native:ado', job.id).message).toContain('before sign-in completion or credential caching could be confirmed');
    expect(s.active[0].signal.aborted).toBe(true);
    s.active[0].progress(['To sign in, open https://microsoft.com/devicelogin and enter the code STALE999']);
    expect(s.jobs.get('agency/native:ado', job.id).authUrl).toBeNull();
    expect(s.jobs.cancel('agency/native:ado', job.id).status).toBe('failed');
  });

  it('completes inventory only when no live authentication challenge was observed', async () => {
    const s = setup();
    const job = s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run });
    await Promise.resolve();
    s.active[0].resolve(good);
    await vi.waitFor(() => expect(s.jobs.get('a', job.id).status).toBe('completed'));
    expect(s.jobs.get('a', job.id).message).toContain('has not been verified');
    expect(s.jobs.cancel('a', job.id).status).toBe('completed');
    s.jobs.close();
  });

  it('rejects a native interrupted-challenge marker even when progress is no longer retained', async () => {
    const s = setup();
    const job = s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run });
    await Promise.resolve();
    s.active[0].resolve({ ...good, toolDiscovery: { ...good.toolDiscovery!, authenticationInterrupted: true } });
    await vi.waitFor(() => expect(s.jobs.get('a', job.id).status).toBe('failed'));
    expect(s.jobs.get('a', job.id).message).toContain('Complete service sign-in in the native CLI');
    s.jobs.close();
  });

  it('cancels before launch without starting a native process', async () => {
    const s = setup();
    const job = s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run });
    expect(s.jobs.cancel('a', job.id).status).toBe('cancelled');
    await Promise.resolve();
    expect(s.run).not.toHaveBeenCalled();
  });

  it('expires stalled native work but retains capacity until cancellation acknowledgement', async () => {
    vi.useFakeTimers();
    const s = setup();
    const job = s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run });
    await Promise.resolve();
    s.active[0].progress(['To sign in, open https://microsoft.com/devicelogin and enter the code ABCD12345']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.active[0].signal.aborted).toBe(true);
    expect(s.jobs.get('a', job.id)).toMatchObject({ status: 'pending', authUrl: null, deviceCode: null });
    expect(() => s.jobs.start({ owner: 'b', serverName: 'ado', run: s.run })).toThrow(/capacity/);
    s.active[0].progress(['To sign in, open https://microsoft.com/devicelogin and enter the code STALE999']);
    expect(s.jobs.get('a', job.id).authUrl).toBeNull();
    s.active[0].resolve(good);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.jobs.get('a', job.id).status).toBe('failed');
    const second = s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run });
    s.jobs.cancel('a', second.id);
  });

  it('cancels an active job and cannot expose its challenge afterwards', async () => {
    const s = setup();
    const job = s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run });
    await Promise.resolve();
    s.active[0].progress(['To sign in, open https://microsoft.com/devicelogin']);
    expect(s.jobs.cancel('a', job.id)).toMatchObject({ status: 'pending', authUrl: null, deviceCode: null });
    expect(s.active[0].signal.aborted).toBe(true);
    expect(s.jobs.cancel('a', job.id).status).toBe('pending');
    s.active[0].resolve(good);
    await vi.waitFor(() => expect(s.jobs.get('a', job.id).status).toBe('cancelled'));
  });

  it('bounds concurrent work and rejects duplicate-owner work even with spare capacity', () => {
    const s = setup(2);
    const one = s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run });
    expect(() => s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run })).toThrow(/pending or at capacity/);
    const two = s.jobs.start({ owner: 'b', serverName: 'other', run: s.run });
    expect(() => s.jobs.start({ owner: 'c', serverName: 'other', run: s.run })).toThrow(/pending or at capacity/);
    s.jobs.cancel('a', one.id);
    s.jobs.cancel('b', two.id);
  });

  it('keeps ownership scoped and returns snapshots rather than mutable state', () => {
    const s = setup();
    const job = s.jobs.start({ owner: 'agency/ado', serverName: 'ado', run: s.run });
    expect(() => s.jobs.get('copilot/ado', job.id)).toThrow(/unavailable/);
    expect(() => s.jobs.cancel('agency/other', job.id)).toThrow(/unavailable/);
    expect(() => s.jobs.get('agency/ado', 'missing')).toThrow(/unavailable/);
    job.message = 'mutated';
    const snapshot = s.jobs.get('agency/ado', job.id);
    expect(snapshot.message).not.toBe('mutated');
    snapshot.status = 'failed';
    expect(s.jobs.get('agency/ado', job.id).status).toBe('pending');
    s.jobs.close();
  });

  it.each([undefined, { status: 'failed' as const, output: [], message: 'safe' }])('records failed discovery without pretending authentication succeeded', async (toolDiscovery) => {
    const s = setup();
    const job = s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run });
    await Promise.resolve();
    s.active[0].resolve({ name: 'ado', spec: {}, toolDiscovery });
    await vi.waitFor(() => expect(s.jobs.get('a', job.id).status).toBe('failed'));
    expect(s.jobs.get('a', job.id).authUrl).toBeNull();
  });

  it('redacts native exceptions and never retries', async () => {
    const s = setup();
    const job = s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run });
    await Promise.resolve();
    s.active[0].reject(new Error('access_token=private'));
    await vi.waitFor(() => expect(s.jobs.get('a', job.id).status).toBe('failed'));
    expect(JSON.stringify(s.jobs.get('a', job.id))).not.toContain('private');
    expect(s.run).toHaveBeenCalledOnce();
  });

  it('bounds retained jobs while preserving active ones', () => {
    const s = setup(2, 2);
    const active = s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run });
    const old = s.jobs.start({ owner: 'b', serverName: 'other', run: s.run });
    s.jobs.cancel('b', old.id);
    const latest = s.jobs.start({ owner: 'b', serverName: 'other', run: s.run });
    expect(() => s.jobs.get('b', old.id)).toThrow(/unavailable/);
    expect(s.jobs.get('a', active.id).status).toBe('pending');
    expect(s.jobs.get('b', latest.id).status).toBe('pending');
    s.jobs.close();
  });

  it('shutdown cancels pending processes and rejects new authentication starts', async () => {
    const s = setup();
    const job = s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run });
    await Promise.resolve();
    s.jobs.close();
    expect(s.active[0].signal.aborted).toBe(true);
    expect(s.jobs.get('a', job.id).status).toBe('pending');
    expect(() => s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run })).toThrow(/shutting down/);
    s.jobs.close();
  });
  it('pins capacity when native cleanup could not be verified and never exposes a stale challenge', async () => {
    const s = setup();
    const job = s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run });
    await Promise.resolve();
    s.jobs.cancel('a', job.id);
    s.active[0].resolve({ ...good, toolDiscovery: { ...good.toolDiscovery!, status: 'failed', cleanupUnconfirmed: true } });
    await vi.waitFor(() => expect(s.jobs.get('a', job.id).message).toContain('restart'));
    expect(() => s.jobs.start({ owner: 'b', serverName: 'ado', run: s.run })).toThrow(/capacity/);
    expect(s.jobs.get('a', job.id).authUrl).toBeNull();
  });
  it('does not treat a rejected run as proof of native process termination', async () => {
    const s = setup();
    const job = s.jobs.start({ owner: 'a', serverName: 'ado', run: s.run });
    await Promise.resolve();
    s.jobs.cancel('a', job.id);
    s.active[0].reject(new Error('aborted'));
    await vi.waitFor(() => expect(s.jobs.get('a', job.id).status).toBe('failed'));
    expect(() => s.jobs.start({ owner: 'b', serverName: 'ado', run: s.run })).toThrow(/capacity/);
  });
});

import { describe, expect, it } from 'vitest';
import { createApplicationWork } from './application-work.js';

describe('application work ownership', () => {
  it('reports scoped admission through accepts', () => {
    const work = createApplicationWork();
    expect(work.accepts({ featureId: 'f1' })).toBe(true);
    void work.quiesceFeature('f1', 0);
    expect(work.accepts({ featureId: 'f1' })).toBe(false);
    expect(work.accepts({ featureId: 'other' })).toBe(true);
  });

  it('closes matching feature/session admission synchronously while unrelated work stays usable', async () => {
    const work = createApplicationWork();
    let finish!: () => void;
    let matching!: AbortSignal;
    let unrelated!: AbortSignal;
    const running = work.own(async (signal) => {
      matching = signal;
      await new Promise<void>((resolve) => { finish = resolve; });
    }, { featureIds: ['f1', 'f2'], sessionId: 's1' });
    await Promise.resolve();

    const quiet = work.quiesceFeature('f2', 100);

    await expect(work.own(async () => undefined, { featureId: 'f2' })).rejects.toMatchObject({
      kind: 'conflict',
    });
    await work.own(async (signal) => {
      unrelated = signal;
    }, { featureId: 'other', sessionId: 'other-session' });

    expect(matching.aborted).toBe(true);
    expect(unrelated.aborted).toBe(false);

    finish();
    await running;
    await expect(quiet).resolves.toBe(true);
  });

  it('matches plural session scopes when quiescing a session', async () => {
    const work = createApplicationWork();
    let finish!: () => void;
    let signal!: AbortSignal;
    const running = work.own(async (owned) => {
      signal = owned;
      await new Promise<void>((resolve) => { finish = resolve; });
    }, { sessionIds: ['s1', 's2'] });
    await Promise.resolve();

    const quiet = work.quiesceSession('s2', 100);

    expect(signal.aborted).toBe(true);
    await expect(work.own(async () => undefined, { sessionId: 's2' })).rejects.toMatchObject({
      kind: 'conflict',
    });

    finish();
    await running;
    await expect(quiet).resolves.toBe(true);
  });

  it('retains scope blocks after an unconfirmed quiesce', async () => {
    const work = createApplicationWork();
    let finish!: () => void;
    const running = work.own(
      async () => new Promise<void>((resolve) => { finish = resolve; }),
      { featureId: 'f1' },
    );
    await Promise.resolve();

    await expect(work.quiesceFeature('f1', 1)).resolves.toBe(false);
    await expect(work.own(async () => undefined, { featureId: 'f1' })).rejects.toMatchObject({
      kind: 'conflict',
    });

    finish();
    await running;
  });

  it('allows delete retries to bypass a retained scope block', async () => {
    const work = createApplicationWork();
    let finish!: () => void;
    const running = work.own(
      async () => new Promise<void>((resolve) => { finish = resolve; }),
      { featureId: 'f1' },
    );
    await Promise.resolve();

    await expect(work.quiesceFeature('f1', 1)).resolves.toBe(false);
    await expect(work.own(
      async () => 'retried delete',
      { featureId: 'f1' },
      { trackScope: {}, allowBlockedScope: true },
    )).resolves.toBe('retried delete');

    finish();
    await running;
    await expect(work.own(async () => undefined, { featureId: 'f1' })).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('rechecks admission scope for admit-only ownership before a callback starts', async () => {
    const work = createApplicationWork();
    const owned = work.own(
      async () => undefined,
      { featureId: 'f1' },
      { trackScope: {} },
    );

    await expect(work.quiesceFeature('f1', 0)).resolves.toBe(true);
    await expect(owned).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('still rejects bypassed scope work after global shutdown', async () => {
    const work = createApplicationWork();
    work.shutdown();
    await expect(work.own(
      async () => undefined,
      { featureId: 'f1' },
      { trackScope: {}, allowBlockedScope: true },
    )).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('owns final persistence after a nested operation has returned', async () => {
    const work = createApplicationWork();
    let finish!: () => void;
    let persisted = false;
    const running = work.own(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      persisted = true;
      return 'result';
    });
    await Promise.resolve();
    work.shutdown();
    expect(work.accepting).toBe(false);
    expect(await work.waitForIdle(1)).toBe(false);
    expect(persisted).toBe(false);
    finish();
    expect(await running).toBe('result');
    expect(await work.waitForIdle(100)).toBe(true);
  });

  it('does not start queued or newly submitted requests after closing admission', async () => {
    const work = createApplicationWork();
    expect(work.accepting).toBe(true);
    let started = false;
    const queued = work.own(() => { started = true; });
    work.shutdown();
    await expect(queued).rejects.toMatchObject({ kind: 'conflict' });
    await expect(work.own(() => { started = true; })).rejects.toMatchObject({ kind: 'conflict' });
    expect(started).toBe(false);
    expect(await work.waitForIdle(100)).toBe(true);
  });

  it('releases ownership and preserves a handler failure', async () => {
    const work = createApplicationWork();
    const error = new Error('handler failed');
    await expect(work.own(() => { throw error; })).rejects.toBe(error);
    expect(await work.waitForIdle(100)).toBe(true);
  });
});

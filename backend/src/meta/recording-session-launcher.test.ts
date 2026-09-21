import { describe, expect, it, vi } from 'vitest';
import { createRecordingSessionLauncher } from './recording-session-launcher.js';
import type {
  LaunchedSession,
  SessionLauncher,
} from '../session/session-launcher.js';
import type { Session, StartSessionRequest } from '../session/session-contract.js';
import type { MetaOperation } from './meta-operation-contract.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    featureId: 'feat-1',
    name: null,
    provider: 'agency',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'running',
    kind: 'meta',
    prompt: 'summarize',
    usageFilePath: '/tmp/usage',
    createdAt: 't0',
    startedAt: 't0',
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function launched(
  completion: Promise<Session>,
  overrides: Partial<Session> = {},
): LaunchedSession {
  return {
    session: session(overrides),
    running: {} as LaunchedSession['running'],
    completion,
  };
}

function recorder() {
  const created: MetaOperation[] = [];
  const updated: MetaOperation[] = [];
  const completed: MetaOperation[] = [];
  return {
    ops: {
      create: vi.fn((op: MetaOperation) => created.push({ ...op })),
      update: vi.fn((op: MetaOperation) => {
        updated.push({ ...op });
        return true;
      }),
      complete: vi.fn((op: MetaOperation) => {
        completed.push({ ...op });
        return true;
      }),
    },
    created,
    updated,
    completed,
  };
}

const clock = { isoNow: () => '2026-01-01T00:00:00.000Z', now: () => 0 };

function request(overrides: Partial<StartSessionRequest> = {}): StartSessionRequest {
  return {
    featureId: 'feat-1',
    providerId: 'agency',
    model: 'auto',
    prompt: 'summarize',
    kind: 'meta',
    purpose: 'feature-summary',
    label: 'Feature summary',
    ...overrides,
  };
}

describe('createRecordingSessionLauncher', () => {
  it('passes non-meta launches straight through without recording', async () => {
    const rec = recorder();
    const done = Promise.resolve(session({ status: 'completed' }));
    const base: SessionLauncher = { start: vi.fn(async () => launched(done)) };
    const runner = createRecordingSessionLauncher({
      base,
      operations: rec.ops,
      clock,
      newOperationId: () => 'op-1',
    });
    await runner.start(request({ kind: 'dev' }));
    expect(rec.ops.create).not.toHaveBeenCalled();
    expect(base.start).toHaveBeenCalledTimes(1);
  });

  it('treats a launch with no kind as non-meta (default dev) and does not record', async () => {
    const rec = recorder();
    const done = Promise.resolve(session({ status: 'completed' }));
    const base: SessionLauncher = { start: vi.fn(async () => launched(done)) };
    const runner = createRecordingSessionLauncher({
      base,
      operations: rec.ops,
      clock,
      newOperationId: () => 'op-1',
    });
    const req = request();
    delete req.kind;
    await runner.start(req);
    expect(rec.ops.create).not.toHaveBeenCalled();
  });

  it('defaults optional identity/label metadata to null on the pending record', async () => {
    const rec = recorder();
    const ended = session({ status: 'completed', exitCode: 0 });
    const base: SessionLauncher = {
      start: vi.fn(async () => launched(Promise.resolve(ended))),
    };
    const runner = createRecordingSessionLauncher({
      base,
      operations: rec.ops,
      clock,
      newOperationId: () => 'op-1',
    });
    await (
      await runner.start({
        featureId: 'feat-1',
        prompt: 'summarize',
        kind: 'meta',
      })
    ).completion;
    expect(rec.created[0]).toMatchObject({
      providerId: null,
      requestedModel: null,
      purpose: null,
      label: null,
    });
  });

  it('records a completed metasession as create → running → completed', async () => {
    const rec = recorder();
    const ended = session({ status: 'completed', exitCode: 0 });
    const base: SessionLauncher = {
      start: vi.fn(async () => launched(Promise.resolve(ended))),
    };
    const runner = createRecordingSessionLauncher({
      base,
      operations: rec.ops,
      clock,
      newOperationId: () => 'op-1',
    });
    const handle = await runner.start(request());
    await expect(handle.completion).resolves.toBe(ended);

    expect(rec.created[0]).toMatchObject({
      operationId: 'op-1',
      state: 'pending',
      purpose: 'feature-summary',
      label: 'Feature summary',
    });
    expect(rec.updated[0]).toMatchObject({
      state: 'running',
      sessionId: 'sess-1',
      providerId: 'agency',
      requestedModel: 'auto',
      sessionIds: ['sess-1'],
    });
    expect(rec.completed[0]).toMatchObject({
      state: 'completed',
      outcome: 'returned',
      finishedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('records a non-zero exit as a failed operation', async () => {
    const rec = recorder();
    const ended = session({ status: 'failed', exitCode: 1 });
    const base: SessionLauncher = {
      start: vi.fn(async () => launched(Promise.resolve(ended))),
    };
    const runner = createRecordingSessionLauncher({
      base,
      operations: rec.ops,
      clock,
      newOperationId: () => 'op-1',
    });
    await (await runner.start(request())).completion;
    expect(rec.updated.at(-1)).toMatchObject({
      state: 'failed',
      outcome: 'unknown',
      errorMessage: 'The meta session exited with code 1.',
    });
    expect(rec.ops.complete).not.toHaveBeenCalled();
  });

  it('records a cancelled run without an exit code as interrupted', async () => {
    const rec = recorder();
    const ended = session({ status: 'cancelled', exitCode: null });
    const base: SessionLauncher = {
      start: vi.fn(async () => launched(Promise.resolve(ended))),
    };
    const runner = createRecordingSessionLauncher({
      base,
      operations: rec.ops,
      clock,
      newOperationId: () => 'op-1',
    });
    await (await runner.start(request())).completion;
    expect(rec.updated.at(-1)).toMatchObject({
      state: 'interrupted',
      errorMessage: 'The meta session ended without an exit code.',
    });
  });

  it('records a rejected completion as failed and re-throws', async () => {
    const rec = recorder();
    const base: SessionLauncher = {
      start: vi.fn(async () =>
        launched(Promise.reject(new Error('save\nfailed'))),
      ),
    };
    const runner = createRecordingSessionLauncher({
      base,
      operations: rec.ops,
      clock,
      newOperationId: () => 'op-1',
    });
    const handle = await runner.start(request());
    await expect(handle.completion).rejects.toThrow(/save/);
    expect(rec.updated.at(-1)).toMatchObject({
      state: 'failed',
      errorMessage: 'save failed',
    });
  });

  it('records an aborted rejected completion as interrupted', async () => {
    const rec = recorder();
    const controller = new AbortController();
    controller.abort();
    const base: SessionLauncher = {
      start: vi.fn(async () => launched(Promise.reject('gone'))),
    };
    const runner = createRecordingSessionLauncher({
      base,
      operations: rec.ops,
      clock,
      newOperationId: () => 'op-1',
    });
    const handle = await runner.start(request({ signal: controller.signal }));
    await expect(handle.completion).rejects.toBe('gone');
    expect(rec.updated.at(-1)).toMatchObject({
      state: 'interrupted',
      errorMessage: 'Meta session failed',
    });
  });

  it('marks the operation failed when the launch itself throws', async () => {
    const rec = recorder();
    const base: SessionLauncher = {
      start: vi.fn(async () => {
        throw new Error('no capacity');
      }),
    };
    const runner = createRecordingSessionLauncher({
      base,
      operations: rec.ops,
      clock,
      newOperationId: () => 'op-1',
    });
    await expect(runner.start(request())).rejects.toThrow('no capacity');
    expect(rec.updated.at(-1)).toMatchObject({
      state: 'failed',
      outcome: 'unknown',
      errorMessage: 'no capacity',
    });
  });

  it('marks an aborted failed launch as interrupted', async () => {
    const rec = recorder();
    const controller = new AbortController();
    controller.abort();
    const base: SessionLauncher = {
      start: vi.fn(async () => {
        throw new Error('cancelled');
      }),
    };
    const runner = createRecordingSessionLauncher({
      base,
      operations: rec.ops,
      clock,
      newOperationId: () => 'op-1',
    });
    await expect(
      runner.start(request({ signal: controller.signal })),
    ).rejects.toThrow('cancelled');
    expect(rec.updated.at(-1)).toMatchObject({ state: 'interrupted' });
  });

  it('falls back to a plain launch when the initial create throws', async () => {
    const ended = session({ status: 'completed', exitCode: 0 });
    const base: SessionLauncher = {
      start: vi.fn(async () => launched(Promise.resolve(ended))),
    };
    const runner = createRecordingSessionLauncher({
      base,
      operations: {
        create: vi.fn(() => {
          throw new Error('db down');
        }),
        update: vi.fn(() => true),
        complete: vi.fn(() => true),
      },
      clock,
      newOperationId: () => 'op-1',
    });
    const handle = await runner.start(request());
    await expect(handle.completion).resolves.toBe(ended);
    expect(base.start).toHaveBeenCalledTimes(1);
  });

  it('never lets a repo write error disturb the metasession', async () => {
    const ended = session({ status: 'completed', exitCode: 0 });
    const base: SessionLauncher = {
      start: vi.fn(async () => launched(Promise.resolve(ended))),
    };
    const runner = createRecordingSessionLauncher({
      base,
      operations: {
        create: vi.fn(),
        update: vi.fn(() => {
          throw new Error('update boom');
        }),
        complete: vi.fn(() => {
          throw new Error('complete boom');
        }),
      },
      clock,
      newOperationId: () => 'op-1',
    });
    const handle = await runner.start(request());
    await expect(handle.completion).resolves.toBe(ended);
  });
});

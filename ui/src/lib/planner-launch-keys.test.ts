import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { createOperationKeyStore } from './operation-keys';
import {
  isOperationPending,
  launchKeysFor,
  launchNewTask,
  launchSession,
  type LaunchRetention,
  type PlannerLaunchApi,
} from './planner-launch';
import type { AgentCatalogItem, AgentAttachment, Feature, PlannerTask, Session } from './types';

const feature = { id: 'f1', name: 'F' } as unknown as Feature;
const session = { id: 's1', name: 'S' } as unknown as Session;
const attachment = { id: 'a1', featureId: 'f1', agentId: 'new-task' } as unknown as AgentAttachment;
const catalog = { manifest: { id: 'new-task' } } as unknown as AgentCatalogItem;
const task = {
  id: 'task-1',
  title: 'Fix the login bug',
  notes: 'details',
  repoId: null,
  prUrl: null,
} as unknown as PlannerTask;

function makeApi(overrides: Partial<PlannerLaunchApi> = {}): PlannerLaunchApi {
  return {
    listFeatures: vi.fn(async () => []),
    createFeature: vi.fn(async () => feature),
    attachAgent: vi.fn(async () => attachment),
    getAgent: vi.fn(async () => catalog),
    createTerminalSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => []),
    listFeatureAgents: vi.fn(async () => []),
    renameSession: vi.fn(async () => session),
    createPrFeature: vi.fn(async () => feature),
    ...overrides,
  } as PlannerLaunchApi;
}

function store() {
  const data = new Map<string, string>();
  return createOperationKeyStore({
    storage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) },
  });
}

describe('durable operation keys in planner launches', () => {
  it('resends the same key after a lost response, even with fresh retention (reload)', async () => {
    const keys = store();
    const lost = new TypeError('Failed to fetch');
    const api = makeApi({
      createTerminalSession: vi.fn().mockRejectedValueOnce(lost).mockResolvedValue(session),
    });
    const first: LaunchRetention = { keys: launchKeysFor(keys, task, 'session', null) };
    await expect(launchSession(api, task, null, undefined, first)).rejects.toBe(lost);

    const reloaded: LaunchRetention = { keys: launchKeysFor(keys, task, 'session', null) };
    await launchSession(api, task, null, undefined, reloaded);

    const calls = vi.mocked(api.createTerminalSession).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][2]).toEqual(calls[0][2]);
    const featureKeys = vi.mocked(api.createFeature).mock.calls.map((c) => c[1]);
    // Each launch creates a parent bucket then the feature; both replay with their own key.
    expect(featureKeys).toHaveLength(4);
    expect(featureKeys[2]).toEqual(featureKeys[0]);
    expect(featureKeys[3]).toEqual(featureKeys[1]);
    expect(featureKeys[1]).not.toEqual(featureKeys[0]);
    expect(api.listSessions).not.toHaveBeenCalled();
  });

  it('keeps the key on operation_pending and discards it only on a key conflict', async () => {
    const keys = store();
    const pending = new ApiError(409, 'pending', 'operation_pending');
    const conflict = new ApiError(409, 'conflict', 'operation_key_conflict');
    const api = makeApi({
      createTerminalSession: vi
        .fn()
        .mockRejectedValueOnce(pending)
        .mockRejectedValueOnce(pending)
        .mockRejectedValueOnce(conflict)
        .mockResolvedValue(session),
    });
    const keep: LaunchRetention = { keys: launchKeysFor(keys, task, 'session', null) };
    await expect(launchSession(api, task, null, undefined, keep)).rejects.toBe(pending);
    await expect(launchSession(api, task, null, undefined, keep)).rejects.toBe(pending);
    await expect(launchSession(api, task, null, undefined, keep)).rejects.toBe(conflict);
    await launchSession(api, task, null, undefined, keep);
    const sent = vi.mocked(api.createTerminalSession).mock.calls.map((c) => c[2]?.operationKey);
    expect(sent[1]).toBe(sent[0]);
    expect(sent[2]).toBe(sent[0]);
    expect(sent[3]).not.toBe(sent[0]);
    expect(isOperationPending(pending)).toBe(true);
    expect(isOperationPending(conflict)).toBe(false);
    expect(isOperationPending(new Error('x'))).toBe(false);
  });

  it('keys the attachment stage and releases the intent when asked', async () => {
    const keys = store();
    const api = makeApi();
    const keep: LaunchRetention = { keys: launchKeysFor(keys, task, 'new-task', 'r1') };
    await launchNewTask(api, task, 'r1', undefined, keep);
    expect(vi.mocked(api.attachAgent).mock.calls[0][2]?.operationKey).toMatch(/^op-/);
    const before = vi.mocked(api.createFeature).mock.calls[1][1]?.operationKey;
    keep.keys?.release();
    await launchNewTask(api, task, 'r1', undefined, {
      keys: launchKeysFor(keys, task, 'new-task', 'r1'),
    });
    expect(vi.mocked(api.createFeature).mock.calls[3][1]?.operationKey).not.toBe(before);
  });

  it('surfaces storage failure before sending anything', async () => {
    const broken = createOperationKeyStore({
      storage: { getItem: () => null, setItem: () => { throw new Error('full'); } },
    });
    const api = makeApi();
    await expect(
      launchSession(api, task, null, undefined, { keys: launchKeysFor(broken, task, 'session', null) }),
    ).rejects.toThrow(/nothing was created/);
    expect(api.createFeature).not.toHaveBeenCalled();
  });

  it('discards the parent bucket key on a key conflict and rethrows other failures', async () => {
    const keys = store();
    const conflict = new ApiError(409, 'conflict', 'operation_key_conflict');
    const api = makeApi({
      createFeature: vi.fn().mockRejectedValueOnce(conflict).mockResolvedValue(feature),
    });
    const keep: LaunchRetention = { keys: launchKeysFor(keys, task, 'session', null) };
    await expect(launchSession(api, task, null, undefined, keep)).rejects.toBe(conflict);
    await launchSession(api, task, null, undefined, keep);
    const sent = vi.mocked(api.createFeature).mock.calls.map((c) => c[1]?.operationKey);
    expect(sent[1]).not.toBe(sent[0]);
  });

  it('still reports a definite parent rejection when launched without keys', async () => {
    const rejected = new ApiError(400, 'bad');
    const api = makeApi({ createFeature: vi.fn().mockRejectedValue(rejected) });
    await expect(launchSession(api, task, null)).rejects.toBe(rejected);
  });
});
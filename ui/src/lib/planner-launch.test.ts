import { describe, expect, it, vi } from 'vitest';
import type {
  AgentCatalogItem,
  AttachedAgent,
  Feature,
  PlannerTask,
  Session,
} from './types';
import {
  datedFeatureName,
  featureNameForTask,
  launchNewTask,
  launchReview,
  launchSession,
  linkFromIntent,
  parsePullNumber,
  promptForTask,
  reopenTask,
  type PlannerLaunchApi,
  type PlannerReopenApi,
} from './planner-launch';

function makeTask(overrides: Partial<PlannerTask> = {}): PlannerTask {
  return {
    id: 't1',
    title: 'Fix the login bug',
    notes: '',
    priority: 'p1',
    status: 'open',
    kind: 'task',
    prUrl: '',
    date: '2025-01-01',
    repoId: null,
    launchKind: null,
    featureId: null,
    sessionId: null,
    launchLabel: null,
    backloggedAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const feature: Feature = {
  id: 'f1',
  name: 'Fix the login bug',
  description: 'desc',
  createdAt: '2025-01-01T00:00:00.000Z',
  summary: null,
  repoId: 'r1',
  checkoutPath: null,
};

const session: Session = {
  id: 's1',
  featureId: 'f1',
  name: null,
  provider: 'copilot',
  requestedModel: 'auto',
  resolvedModel: null,
  status: 'created',
  kind: 'dev',
  prompt: 'Fix the login bug',
  usageFilePath: '/tmp/usage',
  createdAt: '2025-01-01T00:00:00.000Z',
  startedAt: null,
  endedAt: null,
  exitCode: null,
};

const manifest = {
  id: 'new-task',
  title: 'New Task',
  description: 'd',
  icon: 'new-task',
  allowMultiplePerFeature: false,
  prerequisiteLabel: '',
  usageLabel: '',
  promptFields: [],
};

const attachment = {
  id: 'a1',
  agentId: 'new-task',
  featureId: 'f1',
  createdAt: '2025-01-01T00:00:00.000Z',
};

const attached: AttachedAgent = { attachment, manifest };

const catalog: AgentCatalogItem = {
  manifest,
  usage: { totalCredits: null, runs: 0, averageCredits: null },
  attachmentCount: 0,
};

function makeApi(): PlannerLaunchApi {
  return {
    createFeature: vi.fn(async () => feature),
    attachAgent: vi.fn(async () => attachment),
    getAgent: vi.fn(async () => catalog),
    startSession: vi.fn(async () => session),
    renameSession: vi.fn(async () => ({ ...session, name: 'Fix the login bug' })),
    createPrFeature: vi.fn(async () => feature),
  };
}

describe('parsePullNumber', () => {
  it('reads a bare number', () => {
    expect(parsePullNumber('42')).toBe(42);
    expect(parsePullNumber('  7  ')).toBe(7);
  });

  it('reads a GitHub pull URL', () => {
    expect(parsePullNumber('https://github.com/o/r/pull/123')).toBe(123);
  });

  it('reads an Azure DevOps pullrequest URL', () => {
    expect(
      parsePullNumber('https://dev.azure.com/org/proj/_git/r/pullrequest/987'),
    ).toBe(987);
  });

  it('falls back to the last number in the string', () => {
    expect(parsePullNumber('PR 5 for milestone 2024')).toBe(2024);
  });

  it('returns null when empty or numberless', () => {
    expect(parsePullNumber('   ')).toBeNull();
    expect(parsePullNumber('no digits here')).toBeNull();
  });
});

describe('featureNameForTask', () => {
  it('sentence-cases and trims the title', () => {
    expect(featureNameForTask(makeTask({ title: '  fix the bug  ' }))).toBe(
      'Fix the bug',
    );
  });

  it('strips a trailing full stop', () => {
    expect(featureNameForTask(makeTask({ title: 'Ship it.' }))).toBe('Ship it');
  });

  it('falls back when the title is blank', () => {
    expect(featureNameForTask(makeTask({ title: '   ' }))).toBe('Planner task');
  });

  it('truncates a long title with an ellipsis', () => {
    const name = featureNameForTask(makeTask({ title: 'x'.repeat(200) }));
    expect(name.endsWith('…')).toBe(true);
    expect(name.length).toBe(80);
  });
});

describe('promptForTask', () => {
  it('returns just the title with no notes', () => {
    expect(promptForTask(makeTask({ notes: '  ' }))).toBe('Fix the login bug');
  });

  it('appends notes under the title', () => {
    expect(promptForTask(makeTask({ notes: 'details' }))).toBe(
      'Fix the login bug\n\ndetails',
    );
  });
});

describe('datedFeatureName', () => {
  it('prefixes the tidy task name with its day', () => {
    expect(datedFeatureName(makeTask())).toBe('2025-01-01 · Fix the login bug');
  });
});

describe('launchNewTask', () => {
  it('creates a dated parent, nests the agent feature, and returns an agent intent', async () => {
    const api = makeApi();
    const intent = await launchNewTask(api, makeTask(), 'r1');
    expect(api.createFeature).toHaveBeenNthCalledWith(1, {
      name: '2025-01-01 · Fix the login bug',
      description: 'Fix the login bug',
      repoId: 'r1',
    });
    expect(api.createFeature).toHaveBeenNthCalledWith(2, {
      name: 'Fix the login bug',
      description: 'Fix the login bug',
      repoId: 'r1',
      parentFeatureId: 'f1',
    });
    expect(api.attachAgent).toHaveBeenCalledWith('f1', 'new-task');
    expect(api.getAgent).toHaveBeenCalledWith('new-task');
    expect(intent).toEqual({ kind: 'agent', feature, attached });
  });

  it('reuses an existing parent feature when the task was already launched', async () => {
    const api = makeApi();
    await launchNewTask(api, makeTask({ featureId: 'parent-1' }), 'r1');
    expect(api.createFeature).toHaveBeenCalledTimes(1);
    expect(api.createFeature).toHaveBeenCalledWith(
      expect.objectContaining({ parentFeatureId: 'parent-1' }),
    );
  });

  it('passes a null repo through', async () => {
    const api = makeApi();
    await launchNewTask(api, makeTask(), null);
    expect(api.createFeature).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: null }),
    );
  });
});

describe('launchSession', () => {
  it('creates a dated parent, starts and names a session, and returns a session intent', async () => {
    const api = makeApi();
    const intent = await launchSession(api, makeTask({ notes: 'n' }), 'r1');
    expect(api.createFeature).toHaveBeenNthCalledWith(1, {
      name: '2025-01-01 · Fix the login bug',
      description: 'Fix the login bug\n\nn',
      repoId: 'r1',
    });
    expect(api.createFeature).toHaveBeenNthCalledWith(2, {
      name: 'Fix the login bug',
      description: 'Fix the login bug\n\nn',
      repoId: 'r1',
      parentFeatureId: 'f1',
    });
    expect(api.startSession).toHaveBeenCalledWith('f1', {
      prompt: 'Fix the login bug\n\nn',
    });
    expect(api.renameSession).toHaveBeenCalledWith('s1', 'Fix the login bug');
    expect(intent).toEqual({
      kind: 'session',
      session: { ...session, name: 'Fix the login bug' },
      label: 'Fix the login bug',
    });
  });

  it('passes a null repo through', async () => {
    const api = makeApi();
    await launchSession(api, makeTask(), null);
    expect(api.createFeature).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: null }),
    );
  });
});

describe('launchReview', () => {
  it('imports the PR nested under the dated parent and returns a review-board intent', async () => {
    const api = makeApi();
    const intent = await launchReview(
      api,
      makeTask({ kind: 'pr', prUrl: 'https://github.com/o/r/pull/9' }),
      'r1',
    );
    expect(api.createFeature).toHaveBeenCalledWith(
      expect.objectContaining({ name: '2025-01-01 · Fix the login bug' }),
    );
    expect(api.createPrFeature).toHaveBeenCalledWith('r1', 9, 'f1');
    expect(intent).toEqual({ kind: 'review-board', feature });
  });

  it('reuses an existing parent and does not create another feature', async () => {
    const api = makeApi();
    await launchReview(
      api,
      makeTask({ kind: 'pr', prUrl: '9', featureId: 'parent-1' }),
      'r1',
    );
    expect(api.createFeature).not.toHaveBeenCalled();
    expect(api.createPrFeature).toHaveBeenCalledWith('r1', 9, 'parent-1');
  });

  it('falls back to the title when no prUrl is stored', async () => {
    const api = makeApi();
    await launchReview(api, makeTask({ title: 'Review PR 12', prUrl: '' }), 'r1');
    expect(api.createPrFeature).toHaveBeenCalledWith('r1', 12, 'f1');
  });

  it('throws without a repository', async () => {
    const api = makeApi();
    await expect(launchReview(api, makeTask({ prUrl: '9' }), null)).rejects.toThrow(
      'Pick a repository',
    );
  });

  it('throws when nothing resolves to a PR number', async () => {
    const api = makeApi();
    await expect(
      launchReview(api, makeTask({ title: 'no pr here', prUrl: '' }), 'r1'),
    ).rejects.toThrow('no pull-request number');
  });
});

describe('linkFromIntent', () => {
  it('maps a session intent', () => {
    expect(
      linkFromIntent({ kind: 'session', session, label: 'My session' }),
    ).toEqual({
      launchKind: 'session',
      featureId: 'f1',
      sessionId: 's1',
      launchLabel: 'My session',
    });
  });

  it('maps an agent intent', () => {
    expect(linkFromIntent({ kind: 'agent', feature, attached })).toEqual({
      launchKind: 'agent',
      featureId: 'f1',
      sessionId: null,
      launchLabel: 'Fix the login bug',
    });
  });

  it('maps a review-board intent', () => {
    expect(linkFromIntent({ kind: 'review-board', feature })).toEqual({
      launchKind: 'review',
      featureId: 'f1',
      sessionId: null,
      launchLabel: 'Fix the login bug',
    });
  });
});

function makeReopenApi(overrides: Partial<PlannerReopenApi> = {}): PlannerReopenApi {
  return {
    getSession: vi.fn(async () => session),
    getFeature: vi.fn(async () => feature),
    listFeatureAgents: vi.fn(async () => [attached]),
    ...overrides,
  };
}

describe('reopenTask', () => {
  it('reopens a session using its stored label', async () => {
    const api = makeReopenApi();
    const intent = await reopenTask(
      api,
      makeTask({ launchKind: 'session', sessionId: 's1', launchLabel: 'Saved' }),
    );
    expect(api.getSession).toHaveBeenCalledWith('s1');
    expect(intent).toEqual({ kind: 'session', session, label: 'Saved' });
  });

  it('falls back to the feature id when a session has no label', async () => {
    const api = makeReopenApi();
    const intent = await reopenTask(
      api,
      makeTask({ launchKind: 'session', sessionId: 's1', launchLabel: null }),
    );
    expect(intent).toMatchObject({ kind: 'session', label: 'f1' });
  });

  it('throws when a session launch has no session id', async () => {
    const api = makeReopenApi();
    await expect(
      reopenTask(api, makeTask({ launchKind: 'session', sessionId: null })),
    ).rejects.toThrow('no session to open');
  });

  it('reopens a review board', async () => {
    const api = makeReopenApi();
    const intent = await reopenTask(
      api,
      makeTask({ launchKind: 'review', featureId: 'f1' }),
    );
    expect(api.getFeature).toHaveBeenCalledWith('f1');
    expect(intent).toEqual({ kind: 'review-board', feature });
  });

  it('reopens an attached agent', async () => {
    const api = makeReopenApi();
    const intent = await reopenTask(
      api,
      makeTask({ launchKind: 'agent', featureId: 'f1' }),
    );
    expect(intent).toEqual({ kind: 'agent', feature, attached });
  });

  it('throws when the agent is no longer attached', async () => {
    const api = makeReopenApi({ listFeatureAgents: vi.fn(async () => []) });
    await expect(
      reopenTask(api, makeTask({ launchKind: 'agent', featureId: 'f1' })),
    ).rejects.toThrow('no longer attached');
  });

  it('throws when a feature-backed launch has no feature id', async () => {
    const api = makeReopenApi();
    await expect(
      reopenTask(api, makeTask({ launchKind: 'review', featureId: null })),
    ).rejects.toThrow('nothing to open');
  });
});

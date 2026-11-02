import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
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
  humanizeLaunchError,
  isMissingLaunchTarget,
  acquireRetention,
  claimLaunchSlot,
  launchRegistryFor,
  MAX_RETAINED_LAUNCHES,
  releaseLaunchSlot,
  setLaunchError,
  setLaunchPhase,
  UnknownLaunchOutcomeError,
  launchNewTask,
  launchReview,
  launchSession,
  linkFromIntent,
  MissingLaunchTargetError,
  parsePullNumber,
  promptForTask,
  reopenTask,
  type LaunchRetention,
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
    listFeatures: vi.fn(async () => []),
    createFeature: vi.fn(async () => feature),
    attachAgent: vi.fn(async () => attachment),
    getAgent: vi.fn(async () => catalog),
    createTerminalSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => []),
    listFeatureAgents: vi.fn(async () => []),
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

  it('uses the first non-empty line of a multi-line title', () => {
    expect(
      featureNameForTask(makeTask({ title: '\n  Fix login  \nmore detail' })),
    ).toBe('Fix login');
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
  it('names the dated parent bucket after the day alone, with no task name', () => {
    expect(datedFeatureName(makeTask())).toBe('2025-01-01');
  });
});

describe('humanizeLaunchError', () => {
  it('maps a raw "not a git repository" failure to actionable guidance', () => {
    const message = humanizeLaunchError(
      new Error('fatal: not a git repository (or any of the parent directories): .git'),
    );
    expect(message).toContain('no valid local git checkout');
    expect(message).not.toContain('fatal:');
  });

  it('passes other error messages through unchanged', () => {
    expect(humanizeLaunchError(new Error('Boom'))).toBe('Boom');
  });

  it('stringifies non-Error values', () => {
    expect(humanizeLaunchError('plain string error')).toBe('plain string error');
  });

  it('falls back to a default message when empty', () => {
    expect(humanizeLaunchError(null)).toBe('Could not launch the task.');
    expect(humanizeLaunchError(new Error('   '))).toBe('Could not launch the task.');
  });
});

describe('launchNewTask', () => {
  it('creates a dated parent, nests the agent feature, and returns an agent intent', async () => {
    const api = makeApi();
    const intent = await launchNewTask(api, makeTask(), 'r1');
    expect(api.createFeature).toHaveBeenNthCalledWith(1, {
      name: '2025-01-01',
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

  it('reuses an existing dated bucket so same-day tasks share one folder', async () => {
    const api = makeApi();
    const dated: Feature = {
      ...feature,
      id: 'dated-1',
      name: '2025-01-01',
      parentFeatureId: null,
      parentGroupId: null,
    };
    (api.listFeatures as ReturnType<typeof vi.fn>).mockResolvedValue([dated]);
    await launchNewTask(api, makeTask(), 'r1');
    // Only the child feature is created; the dated parent is reused.
    expect(api.createFeature).toHaveBeenCalledTimes(1);
    expect(api.createFeature).toHaveBeenCalledWith(
      expect.objectContaining({ parentFeatureId: 'dated-1' }),
    );
  });

  it('does not reuse a same-named feature from a different repo or a nested one', async () => {
    const api = makeApi();
    (api.listFeatures as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...feature, id: 'other-repo', name: '2025-01-01', repoId: 'r2' },
      { ...feature, id: 'nested', name: '2025-01-01', parentFeatureId: 'p' },
      { ...feature, id: 'grouped', name: '2025-01-01', parentGroupId: 'g' },
    ]);
    await launchNewTask(api, makeTask(), 'r1');
    // No usable bucket matched, so a fresh dated parent is created.
    expect(api.createFeature).toHaveBeenNthCalledWith(1, {
      name: '2025-01-01',
      description: 'Fix the login bug',
      repoId: 'r1',
    });
    expect(api.createFeature).toHaveBeenCalledTimes(2);
  });

  it('passes a null repo through', async () => {
    const api = makeApi();
    await launchNewTask(api, makeTask(), null);
    expect(api.createFeature).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: null }),
    );
  });

  it('reports progress phases to the onPhase reporter', async () => {
    const api = makeApi();
    const phases: string[] = [];
    await launchNewTask(api, makeTask(), 'r1', (p) => phases.push(p));
    expect(phases).toEqual([
      'Preparing workspace…',
      'Creating task…',
      'Attaching New Task agent…',
    ]);
  });
});

describe('launchSession', () => {
  it('creates a dated parent, starts and names a session, and returns a session intent', async () => {
    const api = makeApi();
    const intent = await launchSession(api, makeTask({ notes: 'n' }), 'r1');
    expect(api.createFeature).toHaveBeenNthCalledWith(1, {
      name: '2025-01-01',
      description: 'Fix the login bug\n\nn',
      repoId: 'r1',
    });
    expect(api.createFeature).toHaveBeenNthCalledWith(2, {
      name: 'Fix the login bug',
      description: 'Fix the login bug\n\nn',
      repoId: 'r1',
      parentFeatureId: 'f1',
    });
    expect(api.createTerminalSession).toHaveBeenCalledWith('f1', {
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

  it('reports progress phases to the onPhase reporter', async () => {
    const api = makeApi();
    const phases: string[] = [];
    await launchSession(api, makeTask(), 'r1', (p) => phases.push(p));
    expect(phases).toEqual([
      'Preparing workspace…',
      'Creating session…',
      'Starting session…',
    ]);
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
      expect.objectContaining({ name: '2025-01-01' }),
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

  it('reports progress phases to the onPhase reporter', async () => {
    const api = makeApi();
    const phases: string[] = [];
    await launchReview(
      api,
      makeTask({ kind: 'pr', prUrl: '9' }),
      'r1',
      (p) => phases.push(p),
    );
    expect(phases).toEqual(['Preparing workspace…', 'Importing pull request…']);
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

describe('launch retention', () => {
  it('retains the feature when starting the session fails and resumes without a duplicate feature', async () => {
    const api = makeApi();
    vi.mocked(api.createTerminalSession).mockRejectedValueOnce(new ApiError(422, 'spawn failed'));
    const retained: LaunchRetention = {};
    await expect(launchSession(api, makeTask(), 'r1', undefined, retained)).rejects.toThrow('spawn failed');
    expect(retained.feature).toEqual(feature);
    expect(retained.session).toBeUndefined();
    vi.mocked(api.createFeature).mockClear();
    await launchSession(api, makeTask(), 'r1', undefined, retained);
    expect(api.createFeature).not.toHaveBeenCalled();
    expect(api.createTerminalSession).toHaveBeenCalledTimes(2);
  });

  it('retains the created session when naming fails so a retry only renames', async () => {
    const api = makeApi();
    vi.mocked(api.renameSession).mockRejectedValueOnce(new Error('rename failed'));
    const retained: LaunchRetention = {};
    await expect(launchSession(api, makeTask(), 'r1', undefined, retained)).rejects.toThrow('rename failed');
    expect(retained.session).toEqual(session);
    await launchSession(api, makeTask(), 'r1', undefined, retained);
    expect(api.createTerminalSession).toHaveBeenCalledTimes(1);
    expect(api.renameSession).toHaveBeenCalledTimes(2);
  });

  it('retains the feature and attachment for the New Task agent', async () => {
    const api = makeApi();
    vi.mocked(api.attachAgent).mockRejectedValueOnce(new ApiError(409, 'attach failed'));
    const retained: LaunchRetention = {};
    await expect(launchNewTask(api, makeTask(), 'r1', undefined, retained)).rejects.toThrow('attach failed');
    expect(retained.feature).toEqual(feature);
    vi.mocked(api.createFeature).mockClear();
    await launchNewTask(api, makeTask(), 'r1', undefined, retained);
    expect(api.createFeature).not.toHaveBeenCalled();
    expect(retained.attachment).toEqual(attachment);
    await launchNewTask(api, makeTask(), 'r1', undefined, retained);
    expect(api.attachAgent).toHaveBeenCalledTimes(2);
  });
});

describe('unknown create outcomes', () => {
  const sessionTask = () => makeTask();

  it('does not repeat a feature create whose outcome is unknown', async () => {
    const api = makeApi();
    vi.mocked(api.createFeature).mockResolvedValueOnce(feature).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const retained: LaunchRetention = {};
    await expect(launchSession(api, sessionTask(), 'r1', undefined, retained)).rejects.toThrow('Failed to fetch');
    await expect(launchSession(api, sessionTask(), 'r1', undefined, retained)).rejects.toBeInstanceOf(UnknownLaunchOutcomeError);
    await expect(launchNewTask(api, sessionTask(), 'r1', undefined, retained)).rejects.toThrow(/task workspace/);
    expect(api.createFeature).toHaveBeenCalledTimes(2);
  });

  it('adopts the single matching session instead of creating another', async () => {
    const api = makeApi();
    vi.mocked(api.createTerminalSession).mockRejectedValueOnce(new ApiError(504, 'timeout'));
    vi.mocked(api.listSessions).mockResolvedValue([session]);
    const retained: LaunchRetention = {};
    await expect(launchSession(api, sessionTask(), 'r1', undefined, retained)).rejects.toThrow('timeout');
    const intent = await launchSession(api, sessionTask(), 'r1', undefined, retained);
    expect(api.listSessions).toHaveBeenCalledWith(feature.id, { includeInternal: true });
    expect(api.createTerminalSession).toHaveBeenCalledTimes(1);
    expect(intent.kind).toBe('session');
    expect(retained.attempt).toBeUndefined();
  });

  it('blocks when found sessions are ambiguous or do not match', async () => {
    const api = makeApi();
    vi.mocked(api.createTerminalSession).mockRejectedValueOnce(new ApiError(502, 'bad gateway'));
    const retained: LaunchRetention = {};
    await expect(launchSession(api, sessionTask(), 'r1', undefined, retained)).rejects.toThrow();
    vi.mocked(api.listSessions).mockResolvedValue([session, { ...session, id: 's2' }]);
    await expect(launchSession(api, sessionTask(), 'r1', undefined, retained)).rejects.toBeInstanceOf(UnknownLaunchOutcomeError);
    vi.mocked(api.listSessions).mockResolvedValue([{ ...session, prompt: 'other' }]);
    await expect(launchSession(api, sessionTask(), 'r1', undefined, retained)).rejects.toBeInstanceOf(UnknownLaunchOutcomeError);
    expect(api.createTerminalSession).toHaveBeenCalledTimes(1);
  });

  it('retries after a server answer when reconciliation finds no session', async () => {
    const api = makeApi();
    vi.mocked(api.createTerminalSession).mockRejectedValueOnce(new ApiError(500, 'boom'));
    const retained: LaunchRetention = {};
    await expect(launchSession(api, sessionTask(), 'r1', undefined, retained)).rejects.toThrow('boom');
    await launchSession(api, sessionTask(), 'r1', undefined, retained);
    expect(api.createTerminalSession).toHaveBeenCalledTimes(2);
  });

  it('blocks when no session is found but the request may still be in flight', async () => {
    const api = makeApi();
    vi.mocked(api.createTerminalSession).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const retained: LaunchRetention = {};
    await expect(launchSession(api, sessionTask(), 'r1', undefined, retained)).rejects.toThrow();
    await expect(launchSession(api, sessionTask(), 'r1', undefined, retained)).rejects.toThrow(/0 found/);
    expect(api.createTerminalSession).toHaveBeenCalledTimes(1);
  });

  it('reuses a known attachment and never attaches the multi-attach agent twice', async () => {
    const api = makeApi();
    vi.mocked(api.attachAgent).mockRejectedValueOnce(new ApiError(500, 'boom'));
    vi.mocked(api.listFeatureAgents).mockResolvedValue([
      { attachment, manifest: catalog.manifest },
      { attachment: { ...attachment, id: 'other', agentId: 'bug-bash' }, manifest: catalog.manifest },
    ]);
    const retained: LaunchRetention = {};
    await expect(launchNewTask(api, sessionTask(), 'r1', undefined, retained)).rejects.toThrow('boom');
    await launchNewTask(api, sessionTask(), 'r1', undefined, retained);
    expect(api.attachAgent).toHaveBeenCalledTimes(1);
    expect(retained.attachment).toEqual(attachment);
  });

  it('blocks on duplicate attachments, and on none while the request may be in flight', async () => {
    const api = makeApi();
    vi.mocked(api.attachAgent).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const retained: LaunchRetention = {};
    await expect(launchNewTask(api, sessionTask(), 'r1', undefined, retained)).rejects.toThrow();
    await expect(launchNewTask(api, sessionTask(), 'r1', undefined, retained)).rejects.toBeInstanceOf(UnknownLaunchOutcomeError);
    vi.mocked(api.listFeatureAgents).mockResolvedValue([
      { attachment, manifest: catalog.manifest },
      { attachment: { ...attachment, id: 'second' }, manifest: catalog.manifest },
    ]);
    await expect(launchNewTask(api, sessionTask(), 'r1', undefined, retained)).rejects.toThrow(/2 found/);
    expect(api.attachAgent).toHaveBeenCalledTimes(1);
  });

  it('retries an attach after a server answer when none is found', async () => {
    const api = makeApi();
    vi.mocked(api.attachAgent).mockRejectedValueOnce(new ApiError(503, 'busy'));
    const retained: LaunchRetention = {};
    await expect(launchNewTask(api, sessionTask(), 'r1', undefined, retained)).rejects.toThrow('busy');
    await launchNewTask(api, sessionTask(), 'r1', undefined, retained);
    expect(api.attachAgent).toHaveBeenCalledTimes(2);
  });

  it('treats 408 as unknown but other 4xx as a definite rejection', async () => {
    const api = makeApi();
    vi.mocked(api.createFeature).mockResolvedValueOnce(feature).mockRejectedValueOnce(new ApiError(408, 'timeout'));
    const retained: LaunchRetention = {};
    await expect(launchSession(api, sessionTask(), 'r1', undefined, retained)).rejects.toThrow('timeout');
    expect(retained.attempt).toEqual({ op: 'feature', answered: true });
  });
});

describe('isMissingLaunchTarget', () => {
  it('accepts only 404s and explicit missing-target errors', () => {
    expect(isMissingLaunchTarget(new MissingLaunchTargetError('gone'))).toBe(true);
    expect(isMissingLaunchTarget(new ApiError(404, 'nope'))).toBe(true);
    expect(isMissingLaunchTarget(new ApiError(500, 'boom'))).toBe(false);
    expect(isMissingLaunchTarget(new TypeError('Failed to fetch'))).toBe(false);
    expect(isMissingLaunchTarget('x')).toBe(false);
  });
});

describe('launch registry', () => {
  it('is shared per API client and isolated between clients', () => {
    const a = {};
    expect(launchRegistryFor(a)).toBe(launchRegistryFor(a));
    expect(launchRegistryFor({})).not.toBe(launchRegistryFor(a));
  });

  it('admits one launch at a time and publishes phase, error and completion', () => {
    const registry = launchRegistryFor({});
    const seen = vi.fn();
    const unsubscribe = registry.subscribe(seen);
    setLaunchPhase(registry, 'ignored');
    expect(registry.getSnapshot().active).toBeNull();
    expect(claimLaunchSlot(registry, 't1')).toBe(true);
    expect(claimLaunchSlot(registry, 't2')).toBe(false);
    setLaunchPhase(registry, 'Starting…');
    expect(registry.getSnapshot().active).toEqual({ taskId: 't1', phase: 'Starting…' });
    setLaunchError(registry, 'boom');
    expect(registry.getSnapshot().error).toBe('boom');
    releaseLaunchSlot(registry);
    expect(registry.getSnapshot()).toMatchObject({ active: null, completions: 1, error: 'boom' });
    expect(claimLaunchSlot(registry, 't2')).toBe(true);
    expect(registry.getSnapshot().error).toBeNull();
    unsubscribe();
    const calls = seen.mock.calls.length;
    releaseLaunchSlot(registry);
    expect(seen.mock.calls.length).toBe(calls);
  });

  it('keeps one record per fingerprint and drops older input for the same task', () => {
    const registry = launchRegistryFor({});
    const first = acquireRetention(registry, makeTask(), 'session', 'r1')!;
    expect(acquireRetention(registry, makeTask(), 'session', 'r1')!.keep).toBe(first.keep);
    expect(acquireRetention(registry, makeTask(), 'session', null)!.keep).not.toBe(first.keep);
    acquireRetention(registry, makeTask({ title: 'changed' }), 'session', 'r1');
    expect(registry.retained.size).toBe(1);
  });

  it('evicts finished records for space but never records with an unknown outcome', () => {
    const registry = launchRegistryFor({});
    for (let i = 0; i < MAX_RETAINED_LAUNCHES; i += 1) {
      acquireRetention(registry, makeTask({ id: `t${i}` }), 'session', 'r1');
    }
    expect(registry.retained.size).toBe(MAX_RETAINED_LAUNCHES);
    expect(acquireRetention(registry, makeTask({ id: 'extra' }), 'session', 'r1')).not.toBeNull();
    expect(registry.retained.size).toBe(MAX_RETAINED_LAUNCHES);
    for (const record of registry.retained.values()) {
      record.attempt = { op: 'session', answered: false };
    }
    const before = [...registry.retained.keys()];
    expect(acquireRetention(registry, makeTask({ id: 'blocked' }), 'session', 'r1')).toBeNull();
    expect([...registry.retained.keys()]).toEqual(before);
  });
});

describe('key cleanup failures never replace the original error', () => {
  const throwingKeys = () => ({
    keyFor: () => 'op-key',
    discard: vi.fn(() => { throw new Error('quota'); }),
    release: vi.fn(),
  });

  it('keeps the conflict error and publishes a notice when a stage reset fails (launchSession)', async () => {
    const { dismissOperationNotices, getOperationNotices } = await import('./operation-notices');
    const { KEY_RESET_WARNING } = await import('./operation-keys');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makeApi();
    const conflict = new ApiError(409, 'different input', 'operation_key_conflict');
    vi.mocked(api.createFeature).mockRejectedValueOnce(conflict);
    const keys = throwingKeys();
    await expect(launchSession(api, makeTask(), 'r1', undefined, { keys })).rejects.toBe(conflict);
    expect(keys.discard).toHaveBeenCalledTimes(1);
    expect(getOperationNotices()?.message).toBe(KEY_RESET_WARNING);
    dismissOperationNotices();
    warn.mockRestore();
  });

  it('keeps the original error when the parent-feature reset fails (launchReview path)', async () => {
    const { dismissOperationNotices, getOperationNotices } = await import('./operation-notices');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makeApi();
    const conflict = new ApiError(409, 'different input', 'operation_key_conflict');
    vi.mocked(api.createFeature).mockRejectedValueOnce(conflict);
    const keys = throwingKeys();
    await expect(launchNewTask(api, makeTask(), 'r1', undefined, { keys })).rejects.toBe(conflict);
    expect(getOperationNotices()?.message).toMatch(/could not be reset/);
    dismissOperationNotices();
    warn.mockRestore();
  });
});

describe('stage key reset failure in a create attempt', () => {
  it('keeps the original rejection and publishes a notice', async () => {
    const { dismissOperationNotices, getOperationNotices } = await import('./operation-notices');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makeApi();
    const rejection = new ApiError(400, 'invalid', 'bad_request');
    vi.mocked(api.createTerminalSession).mockRejectedValueOnce(rejection);
    const keys = { keyFor: () => 'op-key', discard: vi.fn(() => { throw new Error('quota'); }), release: vi.fn() };
    await expect(launchSession(api, makeTask({ featureId: 'f1' }), 'r1', undefined, { keys })).rejects.toBe(rejection);
    expect(keys.discard).toHaveBeenCalledWith('session');
    expect(getOperationNotices()?.message).toMatch(/could not be reset/);
    dismissOperationNotices();
    warn.mockRestore();
  });
});

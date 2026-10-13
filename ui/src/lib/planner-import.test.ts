import { describe, it, expect } from 'vitest';
import {
  workItemToTask,
  issueToTask,
  pullToTask,
  defaultWorkItemFilter,
  isWorkItemFilter,
} from './planner-import';
import type {
  RemoteIssue,
  RemotePullRequest,
  RemoteWorkItem,
} from './types';

const workItem: RemoteWorkItem = {
  provider: 'azure-devops',
  id: 101,
  title: 'Fix the cache',
  url: 'https://dev.azure.com/acme/proj/_workitems/edit/101',
  type: 'Bug',
  state: 'Active',
  assignedTo: 'Mona',
  description: 'Fix cache misses before release.',
};

const issue: RemoteIssue = {
  provider: 'github',
  number: 42,
  title: 'Crash on launch',
  url: 'https://github.com/acme/app/issues/42',
  state: 'open',
  author: 'octocat',
  assignees: ['hubot'],
  labels: ['bug', 'p1'],
  createdAt: '2025-01-01T00:00:00.000Z',
};

const pull: RemotePullRequest = {
  provider: 'github',
  number: 12,
  title: 'Add login',
  url: 'https://github.com/acme/app/pull/12',
  sourceBranch: 'feature/login',
  author: 'Mona',
  body: 'Implements login with tests.',
};

describe('workItemToTask', () => {
  it('maps a work item to a linked task with type, state, and assignee', () => {
    expect(workItemToTask(workItem, 'r1', '2025-02-01')).toEqual({
      title: 'Fix the cache',
      kind: 'task',
      notes:
        'Bug #101 · Active\nAssigned to Mona\n' +
        'https://dev.azure.com/acme/proj/_workitems/edit/101\n' +
        'Description:\nFix cache misses before release.',
      repoId: 'r1',
      date: '2025-02-01',
    });
  });

  it('omits the state, assignee, and date when absent', () => {
    const task = workItemToTask(
      { ...workItem, state: '', assignedTo: null, description: null },
      null,
    );
    expect(task).toEqual({
      title: 'Fix the cache',
      kind: 'task',
      notes: 'Bug #101\nhttps://dev.azure.com/acme/proj/_workitems/edit/101',
      repoId: null,
    });
  });

  it('appends comments when supplied', () => {
    const task = workItemToTask(workItem, 'r1', undefined, [
      'First comment',
      'Second comment',
    ]);
    expect(task.notes).toContain(
      'Comments:\nFirst comment\nSecond comment',
    );
  });
});

describe('issueToTask', () => {
  it('maps an issue to a linked task with state and labels', () => {
    expect(issueToTask(issue, 'r1', '2025-02-01')).toEqual({
      title: 'Crash on launch',
      kind: 'task',
      notes:
        'Issue #42 · open\nLabels: bug, p1\n' +
        'https://github.com/acme/app/issues/42',
      repoId: 'r1',
      date: '2025-02-01',
    });
  });

  it('omits labels, state, and date when absent', () => {
    const task = issueToTask(
      { ...issue, state: '', labels: [] },
      null,
    );
    expect(task).toEqual({
      title: 'Crash on launch',
      kind: 'task',
      notes: 'Issue #42\nhttps://github.com/acme/app/issues/42',
      repoId: null,
    });
  });
});

describe('pullToTask', () => {
  it('maps a pull request to a launchable pr task', () => {
    expect(pullToTask(pull, 'r1', '2025-02-01')).toEqual({
      title: 'Add login',
      kind: 'pr',
      prUrl: 'https://github.com/acme/app/pull/12',
      notes: 'PR #12\nAuthor: Mona\nImplements login with tests.',
      repoId: 'r1',
      date: '2025-02-01',
    });
  });

  it('omits the author line and date when absent', () => {
    const task = pullToTask({ ...pull, author: null, body: null }, null);
    expect(task).toEqual({
      title: 'Add login',
      kind: 'pr',
      prUrl: 'https://github.com/acme/app/pull/12',
      notes: 'PR #12',
      repoId: null,
    });
  });
});

describe('isWorkItemFilter', () => {
  it('accepts the default filter', () => {
    expect(isWorkItemFilter(defaultWorkItemFilter)).toBe(true);
    expect(defaultWorkItemFilter).toEqual({
      assignedTo: 'me',
      state: '',
      area: '',
      iteration: '',
      tag: '',
    });
  });

  it('accepts a fully-populated filter', () => {
    expect(
      isWorkItemFilter({
        assignedTo: 'all',
        state: 'Active',
        area: 'Proj\\Team',
        iteration: 'Proj\\Sprint',
        tag: 'GSI',
      }),
    ).toBe(true);
  });

  it('rejects non-objects, bad assignedTo, and non-string fields', () => {
    expect(isWorkItemFilter(null)).toBe(false);
    expect(isWorkItemFilter('nope')).toBe(false);
    expect(isWorkItemFilter({ ...defaultWorkItemFilter, assignedTo: 'x' })).toBe(
      false,
    );
    expect(isWorkItemFilter({ ...defaultWorkItemFilter, state: 1 })).toBe(false);
    expect(isWorkItemFilter({ ...defaultWorkItemFilter, area: null })).toBe(
      false,
    );
    expect(
      isWorkItemFilter({ ...defaultWorkItemFilter, iteration: undefined }),
    ).toBe(false);
    expect(isWorkItemFilter({ ...defaultWorkItemFilter, tag: 2 })).toBe(false);
  });
});

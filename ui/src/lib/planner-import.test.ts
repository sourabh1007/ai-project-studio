import { describe, it, expect } from 'vitest';
import { workItemToTask, issueToTask, pullToTask } from './planner-import';
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
};

describe('workItemToTask', () => {
  it('maps a work item to a linked task with type, state, and assignee', () => {
    expect(workItemToTask(workItem, 'r1', '2025-02-01')).toEqual({
      title: 'Fix the cache',
      kind: 'task',
      notes:
        'Bug #101 · Active\nAssigned to Mona\n' +
        'https://dev.azure.com/acme/proj/_workitems/edit/101',
      repoId: 'r1',
      date: '2025-02-01',
    });
  });

  it('omits the state, assignee, and date when absent', () => {
    const task = workItemToTask(
      { ...workItem, state: '', assignedTo: null },
      null,
    );
    expect(task).toEqual({
      title: 'Fix the cache',
      kind: 'task',
      notes: 'Bug #101\nhttps://dev.azure.com/acme/proj/_workitems/edit/101',
      repoId: null,
    });
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
      notes: 'PR #12\nAuthor: Mona',
      repoId: 'r1',
      date: '2025-02-01',
    });
  });

  it('omits the author line and date when absent', () => {
    const task = pullToTask({ ...pull, author: null }, null);
    expect(task).toEqual({
      title: 'Add login',
      kind: 'pr',
      prUrl: 'https://github.com/acme/app/pull/12',
      notes: 'PR #12',
      repoId: null,
    });
  });
});

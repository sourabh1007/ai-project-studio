import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RemoteIssue,
  RemotePullRequest,
  RemoteWorkItem,
  Repository,
} from '../../lib/types.js';
import { defaultWorkItemFilter } from '../../lib/planner-import.js';
import { TEAM_ROSTER_STORAGE_KEY } from '../../lib/team-roster.js';
import { ApiError, type ApiClient } from '../../lib/api.js';
import { ApiProvider } from '../../app/api-context.js';
import { SkillsManager } from '../skills/skills-manager.js';
import {
  PlannerImportDialog,
  type PlannerImportApi,
} from './planner-import-dialog.js';

const repos: Repository[] = [
  { id: 'r1', provider: 'azure-devops', name: 'ADO Repo' } as Repository,
  { id: 'r2', provider: 'github', name: 'gh/app' } as Repository,
];

const workItem: RemoteWorkItem = {
  provider: 'azure-devops',
  id: 12,
  title: 'Work item title',
  url: 'https://ado/wi/12',
  type: 'Bug',
  state: 'Active',
  assignedTo: 'Alice',
  description: 'Work item details',
};

const issue: RemoteIssue = {
  provider: 'github',
  number: 7,
  title: 'Issue title',
  url: 'https://gh/issues/7',
  state: 'open',
  author: 'bob',
  assignees: [],
  labels: ['bug'],
  createdAt: null,
};

const pull: RemotePullRequest = {
  provider: 'github',
  number: 9,
  title: 'PR title',
  url: 'https://gh/pull/9',
  sourceBranch: 'feat',
  author: 'carol',
};

function api(overrides: Partial<PlannerImportApi> = {}): PlannerImportApi {
  return {
    listRepoWorkItems: vi.fn().mockResolvedValue([workItem]),
    listRepoWorkItemComments: vi.fn().mockResolvedValue(['First comment']),
    listRepoIssues: vi.fn().mockResolvedValue([issue]),
    listRepoPulls: vi.fn().mockResolvedValue([pull]),
    createPlannerTask: vi.fn().mockResolvedValue({ id: 'new' }),
    ...overrides,
  };
}

function renderDialog(
  over: Partial<PlannerImportApi> = {},
  props: Partial<Parameters<typeof PlannerImportDialog>[0]> = {},
) {
  const client = api(over);
  const onClose = vi.fn();
  const onImported = vi.fn();
  render(
    <PlannerImportDialog
      api={client}
      repos={repos}
      date="2025-02-03"
      onClose={onClose}
      onImported={onImported}
      {...props}
    />,
  );
  return { client, onClose, onImported };
}

describe('PlannerImportDialog', () => {
  it.each([false, true])('refreshes partial successes and excludes confirmed/uncertain rows on retry (uncertain=%s)', async (uncertain) => {
    const createPlannerTask = vi.fn()
      .mockResolvedValueOnce({ id: 'one' })
      .mockRejectedValueOnce(uncertain ? new TypeError('Connection lost') : new ApiError(400, 'Task rejected'))
      .mockResolvedValue({ id: 'retry' });
    const onProgress = vi.fn();
    const { onImported } = renderDialog({
      listRepoIssues: vi.fn().mockResolvedValue([
        issue, { ...issue, number: 8, title: 'Second issue' },
        { ...issue, number: 9, title: 'Third issue' },
      ]),
      createPlannerTask,
    }, { onProgress });
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub Issues' }));
    fireEvent.click(await screen.findByText('Issue title'));
    fireEvent.click(screen.getByText('Second issue'));
    fireEvent.click(screen.getByText('Third issue'));
    fireEvent.click(screen.getByRole('button', { name: /Add 3 to Planner/ }));
    await screen.findByText(/1 task\(s\) added\./);
    expect(onProgress).toHaveBeenCalledWith(1);
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.queryByText('Issue title')).not.toBeInTheDocument();
    if (uncertain) expect(screen.queryByText('Second issue')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Add ${uncertain ? 1 : 2} to Planner`) }));
    await waitFor(() => expect(createPlannerTask).toHaveBeenCalledTimes(uncertain ? 3 : 4));
    if (uncertain) {
      expect(onImported).not.toHaveBeenCalled();
      expect(screen.getByText(/1 outcome\(s\) remain unconfirmed/)).toBeInTheDocument();
    } else {
      expect(onImported).toHaveBeenCalledWith(2);
    }
    expect(createPlannerTask.mock.calls.filter(([task]) => task.title === issue.title)).toHaveLength(1);
    expect(createPlannerTask.mock.calls.filter(([task]) => task.title === 'Second issue')).toHaveLength(uncertain ? 1 : 2);
  });

  it('reloads partial skill uploads and retries only unattempted entries after an uncertain result', async () => {
    const listSkills = vi.fn().mockResolvedValue([]);
    const importSkill = vi.fn().mockResolvedValueOnce({ id: 'one' })
      .mockRejectedValueOnce(new TypeError('Connection lost'))
      .mockResolvedValue({ id: 'three' });
    const view = render(<ApiProvider value={{ listSkills, importSkill } as unknown as ApiClient}><SkillsManager /></ApiProvider>);
    await screen.findByText('No skills yet');
    const payload = (name: string) => ({ name, instructions: name });
    const file = { text: async () => JSON.stringify([payload('one'), payload('two'), payload('three')]) };
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(await screen.findByText(/1 skill\(s\) imported\./)).toHaveTextContent('excluded from retry');
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Retry 1 remaining skill(s)' }));
    await waitFor(() => expect(importSkill).toHaveBeenCalledTimes(3));
    expect(importSkill.mock.calls.map(([value]) => value.name)).toEqual(['one', 'two', 'three']);
    expect(screen.getByText(/1 outcome\(s\) remain unconfirmed/)).toBeInTheDocument();
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(4));
    expect(importSkill).toHaveBeenCalledTimes(3);
  });

  it('does not label a failed skills read as an empty collection', async () => {
    render(<ApiProvider value={{ listSkills: vi.fn().mockRejectedValue(new Error('503 unavailable')) } as unknown as ApiClient}><SkillsManager /></ApiProvider>);
    await screen.findByText(/The list is unknown, not empty/);
    expect(screen.queryByText('No skills yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New skill' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Retry loading skills' })).toBeEnabled();
  });
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('loads work items and imports the selected ones', async () => {
    const { client, onImported } = renderDialog();
    expect(await screen.findByText('Work item title')).toBeInTheDocument();
    expect(client.listRepoWorkItems).toHaveBeenCalledWith(
      'r1',
      defaultWorkItemFilter,
    );

    fireEvent.click(screen.getByText('Work item title'));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 to Planner/ }));

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(1));
    expect(client.createPlannerTask).toHaveBeenCalledTimes(1);
    expect(client.createPlannerTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Work item title',
        kind: 'task',
        date: '2025-02-03',
        notes: expect.stringContaining('Comments:\nFirst comment'),
      }),
    );
    expect(client.listRepoWorkItemComments).toHaveBeenCalledWith('r1', 12);
  });

  it('imports work items without comments when the comments fetch fails', async () => {
    const { client, onImported } = renderDialog({
      listRepoWorkItemComments: vi.fn().mockRejectedValue(new Error('offline')),
    });
    fireEvent.click(await screen.findByText('Work item title'));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 to Planner/ }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(1));
    expect(client.createPlannerTask).toHaveBeenCalledWith(
      expect.objectContaining({
        notes: expect.not.stringContaining('Comments:'),
      }),
    );
  });

  it('switches to GitHub issues and uses the github repo', async () => {
    const { client } = renderDialog();
    await screen.findByText('Work item title');
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub Issues' }));
    expect(await screen.findByText('Issue title')).toBeInTheDocument();
    expect(client.listRepoIssues).toHaveBeenCalledWith('r2', 'all');
    expect(client.listRepoIssues).not.toHaveBeenCalledWith('r1', expect.anything());
  });

  it('narrows work items by filter and persists the choice', async () => {
    const { client } = renderDialog();
    await screen.findByText('Work item title');

    fireEvent.change(screen.getByLabelText('Tag'), {
      target: { value: 'GSI' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));
    expect(client.listRepoWorkItems).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('cw-planner-import-wi-filter')!)).toEqual(defaultWorkItemFilter);
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() =>
      expect(client.listRepoWorkItems).toHaveBeenLastCalledWith('r1', {
        assignedTo: 'all',
        state: '',
        area: '',
        iteration: '',
        tag: 'GSI',
      }),
    );

    // A freshly mounted dialog reuses the persisted filter.
    const { client: client2 } = renderDialog();
    await screen.findAllByText('Work item title');
    expect(client2.listRepoWorkItems).toHaveBeenCalledWith('r1', {
      assignedTo: 'all',
      state: '',
      area: '',
      iteration: '',
      tag: 'GSI',
    });
  });

  it('switches to ADO PRs and imports a pr task', async () => {
    const { client, onImported } = renderDialog();
    await screen.findByText('Work item title');
    fireEvent.click(screen.getByRole('tab', { name: 'ADO PRs' }));
    expect(await screen.findByText('PR title')).toBeInTheDocument();
    expect(client.listRepoPulls).toHaveBeenCalledWith('r1', 'all');

    fireEvent.click(screen.getByLabelText('Select all'));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 to Planner/ }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(1));
    expect(client.createPlannerTask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pr', prUrl: 'https://gh/pull/9' }),
    );
  });

  it('shows an empty message when no repo matches the provider', async () => {
    render(
      <PlannerImportDialog
        api={api()}
        repos={[{ id: 'g', provider: 'github', name: 'gh/only' } as Repository]}
        date="2025-02-03"
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/No Azure DevOps repositories/),
    ).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    renderDialog({
      listRepoWorkItems: vi.fn().mockRejectedValue(new Error('boom')),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  it('surfaces an add error', async () => {
    const { onImported } = renderDialog({
      createPlannerTask: vi.fn().mockRejectedValue(new Error('nope')),
    });
    fireEvent.click(await screen.findByText('Work item title'));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 to Planner/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
    expect(onImported).not.toHaveBeenCalled();
  });

  it('closes from the overlay and the close button', async () => {
    const { onClose } = renderDialog();
    await screen.findByText('Work item title');
    fireEvent.click(screen.getByLabelText('Close import'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('toggles select-all off when all are selected', async () => {
    const { client } = renderDialog({
      listRepoWorkItems: vi
        .fn()
        .mockResolvedValue([workItem, { ...workItem, id: 13, title: 'Second' }]),
    });
    await screen.findByText('Second');
    const selectAll = screen.getByLabelText('Select all');
    fireEvent.click(selectAll);
    expect(screen.getByRole('button', { name: /Add 2 to Planner/ })).toBeEnabled();
    fireEvent.click(selectAll);
    expect(screen.getByRole('button', { name: /Add to Planner/ })).toBeDisabled();
    expect(client.listRepoWorkItems).toHaveBeenCalled();
  });

  it('applies all work-item facets together, supports Enter and resets persisted filters', async () => {
    const { client } = renderDialog();
    await screen.findByText('Work item title');
    fireEvent.click(screen.getByText('Work item title'));
    for (const [name, value] of [
      ['State', ' Active '],
      ['Area path', 'Project\\Team'],
      ['Iteration path', 'Project\\Sprint 1'],
      ['Tag', ' release '],
    ]) {
      fireEvent.change(screen.getByLabelText(name), { target: { value } });
    }
    expect(client.listRepoWorkItems).toHaveBeenCalledTimes(1);
    fireEvent.submit(screen.getByRole('button', { name: 'Apply filters' }).closest('form')!);
    await waitFor(() => expect(client.listRepoWorkItems).toHaveBeenLastCalledWith('r1', {
      assignedTo: 'me', state: 'Active', area: 'Project\\Team',
      iteration: 'Project\\Sprint 1', tag: 'release',
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(client.listRepoWorkItems).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Add to Planner' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(client.listRepoWorkItems).toHaveBeenLastCalledWith('r1', defaultWorkItemFilter));
    expect(screen.getByLabelText('Tag')).toHaveValue('');
    expect(screen.getByLabelText('State')).toHaveValue('');
  });

  it('searches loaded work items only on apply without extra network calls and clears selection', async () => {
    const { client } = renderDialog();
    await screen.findByText('Work item title');
    fireEvent.click(screen.getByText('Work item title'));
    fireEvent.change(screen.getByLabelText('Search loaded work items'), { target: { value: 'not here' } });
    expect(screen.getByText('Work item title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.queryByText('Work item title')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to Planner' })).toBeDisabled();
    expect(client.listRepoWorkItems).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/provider may limit/)).toHaveTextContent('0 shown / 1 loaded');
    fireEvent.change(screen.getByLabelText('Search loaded work items'), { target: { value: '#12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByText('Work item title')).toBeInTheDocument();
    expect(client.listRepoWorkItems).toHaveBeenCalledTimes(1);
  });

  it('uses actual PR server scopes and keeps ADO and GitHub choices separate', async () => {
    const { client } = renderDialog();
    await screen.findByText('Work item title');
    fireEvent.click(screen.getByRole('tab', { name: 'ADO PRs' }));
    await screen.findByText('PR title');
    fireEvent.change(screen.getByLabelText('Pull request scope'), { target: { value: 'mine' } });
    await waitFor(() => expect(client.listRepoPulls).toHaveBeenLastCalledWith('r1', 'mine'));
    await screen.findByText('PR title');
    fireEvent.change(screen.getByLabelText('Pull request scope'), { target: { value: 'assigned' } });
    await waitFor(() => expect(client.listRepoPulls).toHaveBeenLastCalledWith('r1', 'assigned'));
    await screen.findByText('PR title');
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub PRs' }));
    await waitFor(() => expect(client.listRepoPulls).toHaveBeenLastCalledWith('r2', 'all'));
    expect(vi.mocked(client.listRepoPulls).mock.calls).toEqual([
      ['r1', 'all'], ['r1', 'mine'], ['r1', 'assigned'], ['r2', 'all'],
    ]);
    await screen.findByText('PR title');
    fireEvent.change(screen.getByLabelText('Pull request scope'), { target: { value: 'mine' } });
    await waitFor(() => expect(client.listRepoPulls).toHaveBeenLastCalledWith('r2', 'mine'));
    expect(JSON.parse(localStorage.getItem('cw-planner-import-ado-pr-scope')!)).toBe('assigned');
    expect(JSON.parse(localStorage.getItem('cw-planner-import-gh-pr-scope')!)).toBe('mine');
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(client.listRepoPulls).toHaveBeenLastCalledWith('r2', 'all'));
  });

  it('applies and persists GitHub issue server scopes, with local search and reset', async () => {
    const { client } = renderDialog();
    await screen.findByText('Work item title');
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub Issues' }));
    await screen.findByText('Issue title');
    fireEvent.change(screen.getByLabelText('Issue scope'), { target: { value: 'assigned' } });
    await waitFor(() => expect(client.listRepoIssues).toHaveBeenLastCalledWith('r2', 'assigned'));
    await screen.findByText('Issue title');
    expect(JSON.parse(localStorage.getItem('cw-planner-import-issue-scope')!)).toBe('assigned');
    fireEvent.change(screen.getByLabelText('Search loaded issues'), { target: { value: 'bug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByText('Issue title')).toBeInTheDocument();
    expect(client.listRepoIssues).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(client.listRepoIssues).toHaveBeenLastCalledWith('r2', 'all'));
    expect(screen.getByLabelText('Search loaded issues')).toHaveValue('');
  });

  it('reuses the saved team roster and age order without pretending Team is a server scope', async () => {
    localStorage.setItem(TEAM_ROSTER_STORAGE_KEY, JSON.stringify(['alice-login']));
    const { client } = renderDialog({
      listRepoPulls: vi.fn().mockResolvedValue([
        { ...pull, number: 1, title: 'Older Alice', author: 'Alice', authorLogin: 'alice-login', createdAt: '2025-01-01' },
        { ...pull, number: 2, title: 'Newer Alice', author: 'Alice', authorLogin: 'alice-login', createdAt: '2025-02-01' },
        { ...pull, number: 3, title: 'Bob change', author: 'Bob', createdAt: '2025-03-01' },
      ]),
    });
    await screen.findByText('Work item title');
    fireEvent.click(screen.getByRole('tab', { name: 'ADO PRs' }));
    await screen.findByText('Older Alice');
    fireEvent.change(screen.getByLabelText('Pull request scope'), { target: { value: 'team' } });
    await screen.findByText('Older Alice');
    expect(client.listRepoPulls).toHaveBeenLastCalledWith('r1', 'all');
    expect(screen.queryByText('Bob change')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Older Alice');
    fireEvent.change(screen.getByLabelText('Order by time in review'), { target: { value: 'newest' } });
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Newer Alice');
    fireEvent.change(screen.getByLabelText('Team members (shared with Open Pull Request)'), { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add teammate' }));
    expect(await screen.findByText('Bob change')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(TEAM_ROSTER_STORAGE_KEY)!)).toEqual(['alice-login', 'Bob']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove teammate Bob' }));
    expect(screen.queryByText('Bob change')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove teammate alice-login' }));
    expect(screen.getByText('Bob change')).toBeInTheDocument();
    expect(screen.getByText(/No saved team/)).toBeInTheDocument();
  });

  it('ignores invalid persisted scopes and work-item filters', async () => {
    localStorage.setItem('cw-planner-import-wi-filter', JSON.stringify({ assignedTo: 'nobody' }));
    localStorage.setItem('cw-planner-import-ado-pr-scope', JSON.stringify('unsupported'));
    const { client } = renderDialog();
    await screen.findByText('Work item title');
    expect(client.listRepoWorkItems).toHaveBeenCalledWith('r1', defaultWorkItemFilter);
    fireEvent.click(screen.getByRole('tab', { name: 'ADO PRs' }));
    await screen.findByText('PR title');
    expect(screen.getByLabelText('Pull request scope')).toHaveValue('all');
  });

  it('does not mix stale requests into the current source or provider', async () => {
    let finishWorkItems!: (items: RemoteWorkItem[]) => void;
    const { client } = renderDialog({
      listRepoWorkItems: vi.fn().mockReturnValue(new Promise<RemoteWorkItem[]>((resolve) => {
        finishWorkItems = resolve;
      })),
    });
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub Issues' }));
    await screen.findByText('Issue title');
    finishWorkItems([workItem]);
    await waitFor(() => expect(screen.queryByText('Work item title')).not.toBeInTheDocument());
    expect(client.listRepoIssues).toHaveBeenCalledTimes(1);
    expect(client.listRepoIssues).toHaveBeenCalledWith('r2', 'all');
  });

  it('clears local search and selection when changing repository', async () => {
    const { client } = renderDialog({}, {
      repos: [...repos, { ...repos[0], id: 'r3', name: 'Another ADO Repo' }],
    });
    await screen.findByText('Work item title');
    fireEvent.change(screen.getByLabelText('Search loaded work items'), { target: { value: 'Work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    fireEvent.click(screen.getByLabelText('Select all'));
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'r3' } });
    await waitFor(() => expect(client.listRepoWorkItems).toHaveBeenLastCalledWith('r3', defaultWorkItemFilter));
    expect(screen.getByLabelText('Search loaded work items')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Add to Planner' })).toBeDisabled();
  });

  it('restores saved provider scopes on mount', async () => {
    localStorage.setItem('cw-planner-import-ado-pr-scope', JSON.stringify('assigned'));
    localStorage.setItem('cw-planner-import-gh-pr-scope', JSON.stringify('mine'));
    localStorage.setItem('cw-planner-import-issue-scope', JSON.stringify('mine'));
    const { client } = renderDialog();
    await screen.findByText('Work item title');
    fireEvent.click(screen.getByRole('tab', { name: 'ADO PRs' }));
    await screen.findByText('PR title');
    expect(client.listRepoPulls).toHaveBeenLastCalledWith('r1', 'assigned');
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub PRs' }));
    await screen.findByText('PR title');
    expect(client.listRepoPulls).toHaveBeenLastCalledWith('r2', 'mine');
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub Issues' }));
    await screen.findByText('Issue title');
    expect(client.listRepoIssues).toHaveBeenLastCalledWith('r2', 'mine');
  });

  it('searches returned PR numbers, titles, branches, names and logins without refetching', async () => {
    const { client } = renderDialog({
      listRepoPulls: vi.fn().mockResolvedValue([{ ...pull, authorLogin: 'carol-login' }]),
    });
    await screen.findByText('Work item title');
    fireEvent.click(screen.getByRole('tab', { name: 'ADO PRs' }));
    await screen.findByText('PR title');
    for (const value of ['#9', 'PR title', 'feat', 'carol', 'carol-login']) {
      fireEvent.change(screen.getByLabelText('Search loaded pull requests'), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
      expect(screen.getByText('PR title')).toBeInTheDocument();
    }
    expect(client.listRepoPulls).toHaveBeenCalledTimes(1);
  });
});

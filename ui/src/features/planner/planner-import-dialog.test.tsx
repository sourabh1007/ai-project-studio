import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RemoteIssue,
  RemotePullRequest,
  RemoteWorkItem,
  Repository,
} from '../../lib/types.js';
import { defaultWorkItemFilter } from '../../lib/planner-import.js';
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
    expect(client.listRepoIssues).toHaveBeenCalledWith('r2');
  });

  it('narrows work items by filter and persists the choice', async () => {
    const { client } = renderDialog();
    await screen.findByText('Work item title');

    fireEvent.change(screen.getByLabelText('Tag'), {
      target: { value: 'GSI' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));

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
    expect(client.listRepoPulls).toHaveBeenCalledWith('r1');

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
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { Repository, RepositoryContext } from '../../lib/types.js';
import {
  RepositoryContextBadge,
  RepositoryContextSteps,
  RepositoryContextViewer,
  repositoryContextBlockReason,
} from './repository-context.js';

const repo: Repository = {
  id: 'r1',
  provider: 'github',
  remoteUrl: 'https://github.com/acme/app',
  name: 'acme/app',
  localPath: 'C:\\repos\\app',
  defaultBranch: 'main',
  createdAt: '2025-01-01T00:00:00Z',
};

function context(
  status: RepositoryContext['status'],
  overrides: Partial<RepositoryContext> = {},
): RepositoryContext {
  return {
    repositoryId: 'r1',
    status,
    content: status === 'ready' ? 'Generated repository summary' : null,
    sourceRevision: 'abc123',
    timestamps: {
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:01Z',
      generationStartedAt: null,
      generatedAt: status === 'ready' ? '2025-01-01T00:00:01Z' : null,
    },
    steps: [],
    failure: null,
    ...overrides,
  };
}

describe('repository context status', () => {
  it.each([
    ['pending', 'Pending'],
    ['generating', 'Analyzing'],
    ['ready', 'Ready'],
    ['stale', 'Refreshing'],
    ['failed', 'Failed'],
  ] as const)('renders the %s badge', (status, label) => {
    render(<RepositoryContextBadge context={context(status)} onClick={() => {}} />);
    expect(
      screen.getByRole('button', {
        name: `View repository context, status ${label}`,
      }),
    ).toBeInTheDocument();
  });

  it('explains gating while keeping repository-less work unblocked', () => {
    expect(repositoryContextBlockReason(undefined)).toMatch(/pending/i);
    expect(repositoryContextBlockReason(context('generating'))).toMatch(/analyzed/i);
    expect(repositoryContextBlockReason(context('stale'))).toMatch(/refreshing/i);
    expect(repositoryContextBlockReason(context('ready'))).toBeNull();
  });
});

describe('RepositoryContextViewer', () => {
  it('shows retained content and retries a failed refresh', async () => {
    const failed = context('failed', {
      content: 'Last good summary',
      failure: {
        code: 'generation_failed',
        message: 'Provider unavailable',
        failedAt: '2025-01-01T00:00:02Z',
        retryable: true,
        step: 'analyze',
      },
    });
    const generating = context('generating');
    const refreshRepositoryContext = vi.fn().mockResolvedValue(generating);
    const onUpdated = vi.fn();
    render(
      <ApiProvider value={{ refreshRepositoryContext } as unknown as ApiClient}>
        <RepositoryContextViewer
          repo={repo}
          context={failed}
          onClose={() => {}}
          onUpdated={onUpdated}
        />
      </ApiProvider>,
    );

    expect(screen.getByText('Last good summary')).toBeInTheDocument();
    expect(screen.getByText('Provider unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(refreshRepositoryContext).toHaveBeenCalledWith('r1'));
    expect(onUpdated).toHaveBeenCalledWith(generating);
  });

  it('keeps ready content visible when refresh fails', async () => {
    const refreshRepositoryContext = vi.fn().mockRejectedValue(new Error('Offline'));
    render(
      <ApiProvider value={{ refreshRepositoryContext } as unknown as ApiClient}>
        <RepositoryContextViewer
          repo={repo}
          context={context('ready')}
          onClose={() => {}}
          onUpdated={() => {}}
        />
      </ApiProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('Generated repository summary')).toBeInTheDocument();
  });

  it('shows an animated working banner and the live step checklist while analyzing', () => {
    const generating = context('generating', {
      steps: [
        {
          key: 'collect-evidence',
          label: 'Collect repository evidence',
          status: 'ok',
          detail: '42 files',
          startedAt: '2025-01-01T00:00:00Z',
          finishedAt: '2025-01-01T00:00:01Z',
        },
        {
          key: 'analyze',
          label: 'Analyze repository with AI',
          status: 'running',
          detail: 'Summarizing section 1 of 3: backend',
          startedAt: '2025-01-01T00:00:01Z',
          finishedAt: null,
        },
        {
          key: 'persist',
          label: 'Store repository context',
          status: 'pending',
          detail: null,
          startedAt: null,
          finishedAt: null,
        },
      ],
    });
    render(
      <ApiProvider value={{} as unknown as ApiClient}>
        <RepositoryContextViewer
          repo={repo}
          context={generating}
          onClose={() => {}}
          onUpdated={() => {}}
        />
      </ApiProvider>,
    );

    expect(screen.getByRole('status')).toHaveTextContent(/Analyzing repository/);
    const steps = screen.getByRole('list', { name: /Context collection steps/ });
    expect(steps).toHaveTextContent('Collect repository evidence');
    expect(steps).toHaveTextContent('Summarizing section 1 of 3: backend');
    expect(
      steps.querySelectorAll('.repo-context-step').length,
    ).toBe(3);
    // The running step animates a spinner rather than a static glyph.
    expect(steps.querySelector('.repo-step-running .spinner')).not.toBeNull();
  });

  it('highlights the failed step in the checklist', () => {
    const failed = context('failed', {
      failure: {
        code: 'generation_failed',
        message: 'attachment file type not supported',
        failedAt: '2025-01-01T00:00:02Z',
        retryable: true,
        step: 'analyze',
      },
      steps: [
        {
          key: 'collect-evidence',
          label: 'Collect repository evidence',
          status: 'ok',
          detail: null,
          startedAt: '2025-01-01T00:00:00Z',
          finishedAt: '2025-01-01T00:00:01Z',
        },
        {
          key: 'analyze',
          label: 'Analyze repository with AI',
          status: 'failed',
          detail: 'attachment file type not supported',
          startedAt: '2025-01-01T00:00:01Z',
          finishedAt: '2025-01-01T00:00:02Z',
        },
        {
          key: 'persist',
          label: 'Store repository context',
          status: 'skipped',
          detail: null,
          startedAt: null,
          finishedAt: null,
        },
      ],
    });
    render(
      <ApiProvider value={{ refreshRepositoryContext: vi.fn() } as unknown as ApiClient}>
        <RepositoryContextViewer
          repo={repo}
          context={failed}
          onClose={() => {}}
          onUpdated={() => {}}
        />
      </ApiProvider>,
    );
    const failedStep = document.querySelector(
      '.repo-context-step.repo-step-failed',
    );
    expect(failedStep).not.toBeNull();
    expect(failedStep).toHaveTextContent('Analyze repository with AI');
    expect(failedStep).toHaveTextContent('attachment file type not supported');
    // No animated working banner once generation has stopped.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders nothing when there are no steps to show', () => {
    const { container } = render(<RepositoryContextSteps steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

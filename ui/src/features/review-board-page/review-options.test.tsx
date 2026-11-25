import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { PerspectiveSpec, ReviewBoard } from '../../lib/types.js';
import { ReviewOptionsForm } from './review-options.js';

const value = {
  perspectives: [
    { id: 'security', name: 'Security', why: 'Review access.' },
    { id: 'business', name: 'Business', why: 'Review requirements.' },
  ],
} as ReviewBoard;

describe('per-review options', () => {
  it('requires an editable save before inferred context becomes user-confirmed requirements', async () => {
    const api = { getMetaModels: vi.fn().mockResolvedValue([]), listSkills: vi.fn().mockResolvedValue([]) } as unknown as ApiClient;
    const onPrepare = vi.fn().mockResolvedValue(undefined);
    render(<ApiProvider value={api}><ReviewOptionsForm board={value} busy={false} onPrepare={onPrepare}
      businessContextDraft="Reuse the operation key." /></ApiProvider>);
    expect(screen.getByLabelText('Acceptance criteria')).toHaveValue('Reuse the operation key.');
    expect(screen.getByRole('note')).toHaveTextContent('Saving confirms the text');
    expect(onPrepare).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'Keep keys for 24 hours.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save review options' }));
    await waitFor(() => expect(onPrepare).toHaveBeenCalledWith(expect.objectContaining({ businessContext: 'Keep keys for 24 hours.' })));
  });
  it('preserves automatically supplied Studio instruction skills when changing unrelated options', async () => {
    const api = {
      getMetaModels: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([{ id: 'billing', name: 'Billing policy', kind: 'instruction' }]),
    } as unknown as ApiClient;
    const current = { ...value, run: { options: {}, context: { skills: [
      { id: 'studio:billing', source: 'studio:billing' },
      { id: 'repository-guidance', source: 'AGENTS.md' },
    ] } } } as ReviewBoard;
    const onPrepare = vi.fn().mockResolvedValue(undefined);
    render(<ApiProvider value={api}><ReviewOptionsForm board={current} busy={false} onPrepare={onPrepare} /></ApiProvider>);
    expect(await screen.findByLabelText('Billing policy')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Business'));
    fireEvent.click(screen.getByRole('button', { name: 'Save review options' }));
    await waitFor(() => expect(onPrepare).toHaveBeenLastCalledWith({ perspectiveIds: ['security'], skillIds: ['billing'] }));
    fireEvent.click(screen.getByLabelText('Billing policy'));
    fireEvent.click(screen.getByRole('button', { name: 'Save review options' }));
    await waitFor(() => expect(onPrepare).toHaveBeenLastCalledWith({ perspectiveIds: ['security'], skillIds: [] }));
  });

  it.each(['availablePerspectives', 'model'] as const)('can reinclude Business after saving an excluded run using the %s catalog', async (catalogSource) => {
    const catalog: PerspectiveSpec[] = [
      { id: 'security', name: 'Security', why: 'Review access.', source: 'core' },
      { id: 'business', name: 'Business', why: 'Review requirements.', source: 'detected' },
    ];
    const api = { getMetaModels: vi.fn().mockResolvedValue([]), listSkills: vi.fn().mockResolvedValue([]) } as unknown as ApiClient;
    const initial: ReviewBoard = {
      ...value,
      ...(catalogSource === 'availablePerspectives'
        ? { availablePerspectives: catalog }
        : { model: { ...value.model, perspectives: catalog } }),
    };
    const onPrepare = vi.fn().mockResolvedValue(undefined);
    const first = render(<ApiProvider value={api}><ReviewOptionsForm board={initial} busy={false} onPrepare={onPrepare} /></ApiProvider>);
    expect(screen.getByLabelText('Business')).toBeChecked();
    expect(screen.getByLabelText('Security (required)')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Business'));
    fireEvent.click(screen.getByRole('button', { name: 'Save review options' }));
    await waitFor(() => expect(onPrepare).toHaveBeenCalledWith({ perspectiveIds: ['security'], skillIds: [] }));
    first.unmount();

    const saved: ReviewBoard = {
      ...initial,
      perspectives: value.perspectives.filter((p) => p.id !== 'business'),
      run: { options: { perspectiveIds: ['security'] }, perspectiveIds: ['security'] } as ReviewBoard['run'],
    };
    render(<ApiProvider value={api}><ReviewOptionsForm board={saved} busy={false} onPrepare={onPrepare} /></ApiProvider>);
    expect(screen.getByLabelText('Business')).not.toBeChecked();
    expect(screen.getByLabelText('Security (required)')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Business'));
    fireEvent.click(screen.getByRole('button', { name: 'Save review options' }));
    await waitFor(() => expect(onPrepare).toHaveBeenLastCalledWith({
      perspectiveIds: ['security', 'business'], skillIds: [],
    }));
  });

  it('uses the active model catalog, filters instruction skills, and prepares without launching analysis', async () => {
    const api = {
      getMetaModels: vi.fn().mockResolvedValue([
        { id: 'named', name: 'Named model', enabled: true, usageLabel: '3x' },
        { id: 'denied', name: 'Unavailable model', enabled: false },
      ]),
      listSkills: vi.fn().mockResolvedValue([
        { id: 'instruction', name: 'Repository conventions', kind: 'instruction' },
        { id: 'plan', name: 'Execute the plan', kind: 'task-plan' },
      ]),
    } as unknown as ApiClient;
    const onPrepare = vi.fn().mockResolvedValue(undefined);
    render(<ApiProvider value={api}><ReviewOptionsForm board={value} busy={false} onPrepare={onPrepare} /></ApiProvider>);
    await screen.findByRole('option', { name: 'Named model · 3x' });
    expect(screen.getByRole('option', { name: 'Unavailable model · unavailable' })).toBeDisabled();
    expect(screen.queryByText('Execute the plan')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Review model'), { target: { value: 'named' } });
    fireEvent.click(await screen.findByLabelText('Repository conventions'));
    fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: '  No duplicate charges.  ' } });
    fireEvent.click(screen.getByLabelText('Business'));
    fireEvent.click(screen.getByRole('button', { name: 'Save review options' }));
    await waitFor(() => expect(onPrepare).toHaveBeenCalledWith({
      model: 'named', perspectiveIds: ['security'], skillIds: ['instruction'], businessContext: 'No duplicate charges.',
    }));
    expect(api.getMetaModels).toHaveBeenCalledOnce();
    expect(api.listSkills).toHaveBeenCalledOnce();
  });

  it('preserves saved unavailable selections and exposes preparation errors without losing drafts', async () => {
    const api = { getMetaModels: vi.fn().mockRejectedValue(new Error('offline')), listSkills: vi.fn().mockResolvedValue([]) } as unknown as ApiClient;
    const saved = { ...value, run: { options: { model: 'old', skillIds: ['old-skill'], businessContext: 'Existing requirements' } } } as ReviewBoard;
    const onPrepare = vi.fn().mockRejectedValue(new Error('Model unavailable. Choose a new model.'));
    render(<ApiProvider value={api}><ReviewOptionsForm board={saved} busy={false} onPrepare={onPrepare} /></ApiProvider>);
    await screen.findByText(/Some options are unavailable/);
    expect(screen.getByLabelText('Review model')).toHaveValue('old');
    expect(screen.getByLabelText(/old-skill/)).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save review options' }));
    await screen.findByText('Model unavailable. Choose a new model.');
    expect(screen.getByLabelText('Acceptance criteria')).toHaveValue('Existing requirements');
  });
});

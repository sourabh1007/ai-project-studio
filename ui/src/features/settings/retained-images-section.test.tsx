import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  RetainedImagesSection,
  type AttachmentsBridge,
  type RetainedImage,
  type RetainedImagesSnapshot,
} from './retained-images-section.js';

afterEach(cleanup);

const first: RetainedImage = {
  id: 'opaque-snapshot-one-token', name: 'retained-image.png', bytes: 8192,
  createdAt: '2026-09-08T06:00:00.000Z',
};
function snapshot(items: RetainedImage[] = [first]): RetainedImagesSnapshot {
  return {
    status: 'ready', items, totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    limits: { files: 64, totalBytes: 64 * 1024 * 1024, fileBytes: 8 * 1024 * 1024 },
  };
}
function bridge() {
  return {
    list: vi.fn<AttachmentsBridge['list']>().mockResolvedValue(snapshot()),
    remove: vi.fn<AttachmentsBridge['remove']>().mockResolvedValue({ status: 'cancelled' }),
  };
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
async function selectFirst() {
  fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${first.name}` }));
}

it('shows browser unavailability rather than an empty list or success', () => {
  render(<RetainedImagesSection />);
  expect(screen.getByText(/management is unavailable/)).toBeInTheDocument();
  expect(screen.queryByText('No retained clipboard images.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete selected' })).toBeNull();
  expect(screen.getByText(/may break active, past, or resumed prompts/)).toHaveTextContent('cannot be undone');
  expect(screen.getByText(/native confirmation dialog/)).toHaveTextContent('no automatic deletion or expiry');
  expect(screen.getByText(/Storage caps/)).toHaveTextContent('64 files, 64 MiB total, 8 MiB per image');
});

it('loads once on opening and displays names, dates, bytes and quota without previews', async () => {
  const api = bridge();
  const view = render(<RetainedImagesSection bridge={api} />);
  expect(await screen.findByText(first.name)).toBeInTheDocument();
  expect(screen.getByText(new Date(first.createdAt).toLocaleString())).toBeInTheDocument();
  expect(screen.getByText(/1 of 64 files/)).toHaveTextContent('8.0 KiB of 64.0 MiB used');
  expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDisabled();
  expect(screen.queryByRole('img')).toBeNull();
  view.rerender(<RetainedImagesSection bridge={api} />);
  expect(api.list).toHaveBeenCalledTimes(1);
  expect(api.remove).not.toHaveBeenCalled();
});

it.each(['error', 'reject'] as const)('reports list %s without falsely showing empty storage, and allows refresh', async (failure) => {
  const api = bridge();
  if (failure === 'error') api.list.mockResolvedValueOnce({ status: 'error', error: 'private-path' });
  else api.list.mockRejectedValueOnce(new Error('private-path'));
  api.list.mockResolvedValue(snapshot([]));
  render(<RetainedImagesSection bridge={api} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('storage contents are unknown');
  expect(screen.queryByText('No retained clipboard images.')).toBeNull();
  expect(screen.queryByText('private-path')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh images' }));
  expect(await screen.findByText('No retained clipboard images.')).toBeInTheDocument();
  expect(screen.getByText(/0 of 64 files/)).toHaveTextContent('0 B');
  expect(api.list).toHaveBeenCalledTimes(2);
});

it('disables controls while native confirmation is pending and preserves selection on cancellation', async () => {
  const api = bridge();
  const pending = deferred<Awaited<ReturnType<AttachmentsBridge['remove']>>>();
  api.remove.mockReturnValue(pending.promise);
  render(<RetainedImagesSection bridge={api} />);
  await selectFirst();
  const remove = screen.getByRole('button', { name: 'Delete selected' });
  fireEvent.click(remove);
  fireEvent.click(remove);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh images' }));
  expect(remove).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Refresh images' })).toBeDisabled();
  expect(screen.getByRole('checkbox')).toBeDisabled();
  expect(api.remove).toHaveBeenCalledTimes(1);
  expect(api.remove).toHaveBeenCalledWith({ ids: [first.id] });
  await act(async () => { pending.resolve({ status: 'cancelled' }); });
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(remove).toBeEnabled();
  expect(screen.getByText('Deletion cancelled. No images were deleted.')).toBeInTheDocument();
  expect(api.list).toHaveBeenCalledTimes(1);
});

it('refreshes after confirmed deletion, updates usage and never sends renderer names or paths', async () => {
  const api = bridge();
  api.list.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot([]));
  api.remove.mockResolvedValue({ status: 'deleted', deleted: 1 });
  render(<RetainedImagesSection bridge={api} />);
  await selectFirst();
  fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
  expect(await screen.findByText('Deleted 1 retained image.')).toBeInTheDocument();
  expect(await screen.findByText('No retained clipboard images.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDisabled();
  expect(api.remove.mock.calls).toEqual([[{ ids: [first.id] }]]);
  expect(api.list).toHaveBeenCalledTimes(2);
});

it('manual refresh clears old snapshot selection and uses only new opaque IDs', async () => {
  const api = bridge();
  const refreshed = { ...first, id: 'opaque-snapshot-two-token' };
  api.list.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot([refreshed]));
  render(<RetainedImagesSection bridge={api} />);
  await selectFirst();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh images' }));
  expect(await screen.findByRole('checkbox')).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ ids: [refreshed.id] }));
});

it.each([0, 1] as const)('reports the exact partial deletion count %s and refreshes without replay', async (deleted) => {
  const api = bridge();
  api.remove.mockResolvedValue({ status: 'error', error: 'io-error', deleted });
  api.list.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot([{ ...first, id: 'fresh-token' }]));
  render(<RetainedImagesSection bridge={api} />);
  await selectFirst();
  fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(`${deleted} image${deleted === 1 ? ' was' : 's were'} deleted`);
  expect(await screen.findByRole('checkbox')).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDisabled();
  expect(api.remove).toHaveBeenCalledTimes(1);
  expect(api.list).toHaveBeenCalledTimes(2);
});

it('treats rejected removal as ambiguous and a failed refresh as unknown, never as empty or success', async () => {
  const api = bridge();
  api.remove.mockRejectedValue(new Error('private-path'));
  api.list.mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(new Error('offline'));
  render(<RetainedImagesSection bridge={api} />);
  await selectFirst();
  fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Some images may have been deleted');
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('remaining storage usage is unknown'));
  expect(screen.queryByText('No retained clipboard images.')).toBeNull();
  expect(screen.queryByText(/Deleted \d/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Refresh images' })).toBeEnabled();
  expect(api.remove).toHaveBeenCalledTimes(1);
});

it('does not let an old unmounted request overwrite a reopened snapshot', async () => {
  const old = deferred<Awaited<ReturnType<AttachmentsBridge['list']>>>();
  const api = bridge();
  api.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot([]));
  const view = render(<RetainedImagesSection bridge={api} />);
  view.unmount();
  render(<RetainedImagesSection bridge={api} />);
  expect(await screen.findByText('No retained clipboard images.')).toBeInTheDocument();
  await act(async () => { old.resolve(snapshot()); });
  expect(screen.queryByText(first.name)).toBeNull();
  expect(api.list).toHaveBeenCalledTimes(2);
});

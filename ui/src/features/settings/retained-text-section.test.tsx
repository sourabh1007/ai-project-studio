import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { TextAttachmentsSnapshot } from '../../lib/terminal-paste.js';
import { RetainedTextSection } from './retained-text-section.js';

const snapshot: TextAttachmentsSnapshot = {
  items: [{ attachmentId: 'a1', name: 'paste-a1.txt', path: '/owned/paste-a1.txt', bytes: 5000, modifiedAt: '2026-10-30T00:00:00.000Z' }],
  files: 1, totalBytes: 5000,
  limits: { fileBytes: 4194304, totalBytes: 67108864, files: 64 },
};

function fixture(overrides: Partial<ApiClient> = {}) {
  const listTextAttachments = vi.fn(async () => snapshot);
  const deleteTextAttachment = vi.fn(async (_id: string, _signal?: AbortSignal) => ({ attachmentId: 'a1' }));
  const api = { listTextAttachments, deleteTextAttachment, ...overrides } as ApiClient;
  const view = render(<ApiProvider value={api}><RetainedTextSection /></ApiProvider>);
  return { view, listTextAttachments, deleteTextAttachment };
}

afterEach(cleanup);

describe('retained pasted text management', () => {
  it('lists bounded storage usage without exposing or automatically deleting file contents', async () => {
    const f = fixture();
    expect(await f.view.findByText('paste-a1.txt')).toHaveAttribute('title', '/owned/paste-a1.txt');
    expect(f.view.getByText(/1 of 64 files/)).toBeTruthy();
    expect(f.view.getByText(/There is no automatic deletion/)).toBeTruthy();
    expect(f.deleteTextAttachment).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation and refreshes the authoritative list only on request', async () => {
    const f = fixture();
    await f.view.findByText('paste-a1.txt');
    fireEvent.click(f.view.getByRole('button', { name: 'Delete paste-a1.txt' }));
    expect(f.deleteTextAttachment).not.toHaveBeenCalled();
    expect(f.view.getByRole('dialog').textContent).toContain('cannot be undone');
    fireEvent.click(f.view.getByRole('button', { name: 'Cancel' }));
    expect(f.deleteTextAttachment).not.toHaveBeenCalled();
    fireEvent.click(f.view.getByRole('button', { name: 'Delete paste-a1.txt' }));
    fireEvent.click(f.view.getByRole('button', { name: 'Delete text file' }));
    await f.view.findByText(/Retained text file deleted/);
    expect(f.deleteTextAttachment).toHaveBeenCalledOnce();
    expect(f.deleteTextAttachment.mock.calls[0][0]).toBe('a1');
    f.listTextAttachments.mockResolvedValueOnce({ ...snapshot, items: [], files: 0, totalBytes: 0 });
    fireEvent.click(f.view.getByRole('button', { name: 'Refresh text files' }));
    expect(await f.view.findByText('No retained pasted text files.')).toBeTruthy();
  });

  it('does not retry or pretend a failed deletion left the file unchanged', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('PRIVATE file contents'));
    const f = fixture({ deleteTextAttachment: remove });
    await f.view.findByText('paste-a1.txt');
    fireEvent.click(f.view.getByRole('button', { name: 'Delete paste-a1.txt' }));
    fireEvent.click(f.view.getByRole('button', { name: 'Delete text file' }));
    expect(await f.view.findByRole('alert')).toHaveTextContent('Deletion was not confirmed');
    expect(f.view.getByRole('alert').textContent).not.toContain('PRIVATE');
    expect(remove).toHaveBeenCalledOnce();
    expect(f.view.queryByRole('button', { name: 'Delete paste-a1.txt' })).toBeNull();
  });

  it.each([
    null, {}, { ...snapshot, items: [{ ...snapshot.items[0], bytes: -1 }] },
    { ...snapshot, items: [snapshot.items[0], snapshot.items[0]] },
  ])('refuses malformed storage inventories: %j', async (value) => {
    const f = fixture({ listTextAttachments: vi.fn().mockResolvedValue(value) });
    expect(await f.view.findByRole('alert')).toHaveTextContent('storage contents are unknown');
    expect(f.view.queryByRole('button', { name: 'Delete paste-a1.txt' })).toBeNull();
  });

  it('surfaces storage failures and allows manual refresh', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('PRIVATE')).mockResolvedValueOnce(snapshot);
    const f = fixture({ listTextAttachments: list });
    await f.view.findByRole('alert');
    fireEvent.click(f.view.getByRole('button', { name: 'Refresh text files' }));
    expect(await f.view.findByText('paste-a1.txt')).toBeTruthy();
    expect(f.view.queryByRole('alert')).toBeNull();
  });

  it('aborts inventory reads and ignores late replies after the settings section unmounts', async () => {
    let resolve!: (value: TextAttachmentsSnapshot) => void;
    const list = vi.fn((_signal?: AbortSignal) => new Promise<TextAttachmentsSnapshot>((done) => { resolve = done; }));
    const f = fixture({ listTextAttachments: list });
    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    const signal = list.mock.calls[0][0]!;
    f.view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve(snapshot); });
    expect(f.deleteTextAttachment).not.toHaveBeenCalled();
  });
});

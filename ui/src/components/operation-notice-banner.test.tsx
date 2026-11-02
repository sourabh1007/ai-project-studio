import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationNoticeBanner } from './operation-notice-banner';
import { dismissOperationNotices, getOperationNotices } from '../lib/operation-notices';
import {
  KEY_CLEANUP_WARNING,
  createOperationKeyStore,
  withOperationKey,
} from '../lib/operation-keys';

function quotaStore() {
  let writes = 0;
  return createOperationKeyStore({
    storage: {
      getItem: () => null,
      setItem: () => { if (++writes > 1) throw new Error('QuotaExceededError'); },
    },
    newKey: () => 'op-key-100000',
  });
}

function Harness({ run }: { run: () => Promise<unknown> }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      {open && <button onClick={() => { void run().then(() => setOpen(false)); }}>create</button>}
      <OperationNoticeBanner />
    </div>
  );
}

afterEach(() => {
  dismissOperationNotices();
  vi.restoreAllMocks();
});

describe('OperationNoticeBanner', () => {
  it('renders nothing without a notice', () => {
    const { container } = render(<OperationNoticeBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the cleanup warning visible after the creating dialog unmounts, until dismissed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = vi.fn(async () => ({ id: 'created' }));
    render(<Harness run={() => withOperationKey('g', 1, 's', request, quotaStore())} />);
    await act(async () => { fireEvent.click(screen.getByText('create')); });
    expect(screen.queryByText('create')).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent(KEY_CLEANUP_WARNING);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(getOperationNotices()).toEqual({ message: null, count: 0 });
  });

  it('counts repeated notices', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<OperationNoticeBanner />);
    await act(async () => {
      await withOperationKey('g', 1, 's', async () => 1, quotaStore());
      await withOperationKey('g', 2, 's', async () => 1, quotaStore());
    });
    expect(screen.getByRole('status')).toHaveTextContent('2 notices');
  });
});

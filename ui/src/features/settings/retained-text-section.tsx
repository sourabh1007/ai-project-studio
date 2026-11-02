import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ConfirmDialog } from '../../components/ui.js';
import { formatBytes } from '../../lib/format.js';
import type { RetainedTextAttachment, TextAttachmentsSnapshot } from '../../lib/terminal-paste.js';

function validSnapshot(snapshot: TextAttachmentsSnapshot): boolean {
  const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
  return !!snapshot && Array.isArray(snapshot.items) && snapshot.items.length <= 64 &&
    count(snapshot.totalBytes) && count(snapshot.files) && !!snapshot.limits &&
    [snapshot.limits.fileBytes, snapshot.limits.totalBytes, snapshot.limits.files].every(count) &&
    snapshot.items.every((item) => !!item && typeof item.attachmentId === 'string' &&
      !!item.attachmentId && typeof item.name === 'string' && typeof item.path === 'string' &&
      typeof item.modifiedAt === 'string' && count(item.bytes)) &&
    new Set(snapshot.items.map((item) => item.attachmentId)).size === snapshot.items.length;
}

export function RetainedTextSection() {
  const api = useApi();
  const [snapshot, setSnapshot] = useState<TextAttachmentsSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState<RetainedTextAttachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const version = useRef(0);
  const busy = useRef(false);
  const active = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    const request = ++version.current;
    const controller = new AbortController();
    active.current = controller;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const next = await api.listTextAttachments(controller.signal);
      if (!validSnapshot(next)) throw new Error('Invalid attachment inventory');
      if (request === version.current) setSnapshot(next);
    } catch {
      if (request === version.current) {
        setSnapshot(null);
        setError('Could not list retained text files. Refresh to retry; storage contents are unknown.');
      }
    } finally {
      if (request === version.current) {
        active.current = null;
        busy.current = false;
        setPending(false);
      }
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    return () => {
      version.current++;
      active.current?.abort();
      active.current = null;
      busy.current = false;
    };
  }, [refresh]);

  const remove = async () => {
    if (busy.current || !confirm) return;
    const request = ++version.current;
    const controller = new AbortController();
    active.current = controller;
    busy.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.deleteTextAttachment(confirm.attachmentId, controller.signal);
      if (!result || result.attachmentId !== confirm.attachmentId) throw new Error('Deletion unconfirmed');
      if (request === version.current) setNotice('Retained text file deleted. Earlier prompts that reference it can no longer read it.');
    } catch {
      if (request === version.current) setError('Deletion was not confirmed. Refresh the list before trying again; nothing will be retried automatically.');
    } finally {
      if (request === version.current) {
        active.current = null;
        busy.current = false;
        setPending(false);
        setConfirm(null);
        setSnapshot(null);
      }
    }
  };

  return <>
    <p>Large pastes are saved as UTF-8 files so the terminal receives only a short reference.
      Files are retained for active, past and resumed prompts. There is no automatic deletion or expiry.</p>
    <p>Deleting a retained file may break prompts that reference it and cannot be undone. Only delete files you no longer need.</p>
    <Button variant="ghost" disabled={pending} onClick={() => { setNotice(null); void refresh(); }}>Refresh text files</Button>
    {pending && <p role="status">Updating retained text files...</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {snapshot && <>
      <p>{snapshot.files} of {snapshot.limits.files} files; {formatBytes(snapshot.totalBytes)} of {formatBytes(snapshot.limits.totalBytes)} used;
        {' '}{formatBytes(snapshot.limits.fileBytes)} maximum per paste.</p>
      {snapshot.items.length === 0 ? <p>No retained pasted text files.</p> : <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', textAlign: 'left' }}>
          <thead><tr><th>File</th><th>Size</th><th>Modified</th><th>Action</th></tr></thead>
          <tbody>{snapshot.items.map((item) => <tr key={item.attachmentId}>
            <td><code title={item.path}>{item.name}</code></td>
            <td>{formatBytes(item.bytes)}</td><td>{item.modifiedAt}</td>
            <td><Button variant="danger" disabled={pending} onClick={() => setConfirm(item)} ariaLabel={`Delete ${item.name}`}>Delete</Button></td>
          </tr>)}</tbody>
        </table>
      </div>}
    </>}
    {confirm && <ConfirmDialog title="Delete retained text file?" busy={pending}
      message={<p>Delete <code>{confirm.name}</code>? Active, past or resumed prompts that reference this file will stop working. This cannot be undone.</p>}
      confirmLabel="Delete text file" onConfirm={() => { void remove(); }} onCancel={() => setConfirm(null)} />}
  </>;
}

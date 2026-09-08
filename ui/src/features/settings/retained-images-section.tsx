import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, Card } from '../../components/ui.js';

export interface RetainedImage {
  id: string;
  name: string;
  bytes: number;
  createdAt: string;
}

export interface RetainedImagesSnapshot {
  status: 'ready';
  items: RetainedImage[];
  totalBytes: number;
  limits: { files: number; totalBytes: number; fileBytes: number };
}

export interface AttachmentsBridge {
  list(): Promise<RetainedImagesSnapshot | { status: 'error'; error: string }>;
  remove(request: { ids: string[] }): Promise<
    | { status: 'deleted'; deleted: number }
    | { status: 'cancelled' }
    | { status: 'error'; error: string; deleted?: number }
  >;
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
}

async function readSnapshot(bridge: AttachmentsBridge): Promise<RetainedImagesSnapshot> {
  const result = await bridge.list();
  const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if (result?.status !== 'ready' || !Array.isArray(result.items) ||
      !count(result.totalBytes) || !result.limits ||
      ![result.limits.files, result.limits.totalBytes, result.limits.fileBytes].every(count) ||
      !result.items.every((item) => typeof item.id === 'string' && item.id.length > 0 &&
        typeof item.name === 'string' && typeof item.createdAt === 'string' && count(item.bytes)) ||
      new Set(result.items.map((item) => item.id)).size !== result.items.length) {
    throw new Error('Retained image list unavailable');
  }
  return result;
}

export function RetainedImagesSection({ bridge }: { bridge?: AttachmentsBridge }) {
  const heading = useId();
  const warning = useId();
  const [snapshot, setSnapshot] = useState<RetainedImagesSnapshot | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<'loading' | 'deleting' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);
  const busy = useRef(false);
  const supported = typeof bridge?.list === 'function' && typeof bridge?.remove === 'function';

  const refresh = useCallback(async () => {
    if (!bridge || !supported || busy.current) return;
    const request = ++version.current;
    busy.current = true;
    setPending('loading');
    setSelected(new Set());
    setSnapshot(null);
    setNotice(null);
    setError(null);
    try {
      const next = await readSnapshot(bridge);
      if (version.current === request) setSnapshot(next);
    } catch {
      if (version.current === request) setError('Could not list retained images. Refresh to retry; storage contents are unknown.');
    } finally {
      if (version.current === request) {
        busy.current = false;
        setPending(null);
      }
    }
  }, [bridge, supported]);

  useEffect(() => {
    void refresh();
    return () => {
      version.current++;
      busy.current = false;
    };
  }, [refresh]);

  const remove = async () => {
    if (!bridge || busy.current || !snapshot || selected.size === 0) return;
    const ids = snapshot.items.filter((item) => selected.has(item.id)).map((item) => item.id);
    if (!ids.length) return;
    const request = ++version.current;
    busy.current = true;
    setPending('deleting');
    setNotice(null);
    setError(null);
    try {
      try {
        const result = await bridge.remove({ ids });
        if (version.current !== request) return;
        if (result?.status === 'cancelled') {
          setNotice('Deletion cancelled. No images were deleted.');
          return;
        }
        if (result?.status === 'deleted' && Number.isSafeInteger(result.deleted) && result.deleted >= 0) {
          setNotice(`Deleted ${result.deleted} retained image${result.deleted === 1 ? '' : 's'}.`);
        } else if (result?.status === 'error' && result.deleted !== undefined &&
                   Number.isSafeInteger(result.deleted) && result.deleted >= 0) {
          setError(`Deletion failed. ${result.deleted} image${result.deleted === 1 ? ' was' : 's were'} deleted before the failure. Review the refreshed list before trying again.`);
        } else {
          setError('Deletion was not confirmed. Some images may have been deleted. Nothing will be retried automatically.');
        }
      } catch {
        if (version.current !== request) return;
        setError('Deletion was not confirmed. Some images may have been deleted. Nothing will be retried automatically.');
      }
      // Every new list invalidates opaque IDs from the previous snapshot.
      setSelected(new Set());
      setSnapshot(null);
      try {
        const next = await readSnapshot(bridge);
        if (version.current === request) setSnapshot(next);
      } catch {
        if (version.current === request) setError((previous) =>
          `${previous ? `${previous} ` : ''}Could not refresh retained images. Refresh manually before another deletion; remaining storage usage is unknown.`);
      }
    } finally {
      if (version.current === request) {
        busy.current = false;
        setPending(null);
      }
    }
  };

  return (
    <Card>
      <div role="region" aria-labelledby={heading}>
        <h2 id={heading} className="page-title">Retained clipboard images</h2>
        <p id={warning}>
          Deleting images may break active, past, or resumed prompts that reference them.
          Deletion cannot be undone. A native confirmation dialog will ask you to confirm
          before any deletion. There is no automatic deletion or expiry.
        </p>
        <p className="page-subtitle">
          Only app-retained clipboard images are managed here, never copied source files.
          Storage caps: 64 files, 64 MiB total, 8 MiB per image.
        </p>
        {!supported ? (
          <p>Retained image management is unavailable in this browser or desktop bridge.</p>
        ) : (
          <>
            <div className="diag-actions" aria-describedby={warning}>
              <Button variant="ghost" onClick={() => { void refresh(); }} disabled={pending !== null}>
                Refresh images
              </Button>
              <Button variant="danger" onClick={() => { void remove(); }}
                disabled={pending !== null || !snapshot || selected.size === 0}>
                Delete selected
              </Button>
            </div>
            {pending && <p role="status">{pending === 'loading' ? 'Loading retained images…' : 'Waiting for confirmation, deletion, or refreshed storage usage…'}</p>}
            {notice && <p role="status">{notice}</p>}
            {error && <p role="alert">{error}</p>}
            {snapshot && (
              <>
                <p>
                  {snapshot.items.length} of {snapshot.limits.files} files · {bytesLabel(snapshot.totalBytes)} of {bytesLabel(snapshot.limits.totalBytes)} used
                  {' · '}{bytesLabel(snapshot.limits.fileBytes)} maximum per image
                </p>
                {snapshot.items.length === 0 ? <p>No retained clipboard images.</p> : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', textAlign: 'left' }}>
                      <thead><tr><th>Select</th><th>Name</th><th>Size</th><th>Created</th></tr></thead>
                      <tbody>
                        {snapshot.items.map((item) => (
                          <tr key={item.id}>
                            <td>
                              <input type="checkbox" aria-label={`Select ${item.name}`}
                                disabled={pending !== null} checked={selected.has(item.id)}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setSelected((previous) => {
                                    const next = new Set(previous);
                                    if (checked) next.add(item.id);
                                    else next.delete(item.id);
                                    return next;
                                  });
                                }} />
                            </td>
                            <td style={{ overflowWrap: 'anywhere' }}>{item.name}</td>
                            <td>{bytesLabel(item.bytes)}</td>
                            <td>{dateLabel(item.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

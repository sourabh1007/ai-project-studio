import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { SessionFile } from '../../lib/types.js';
import { ErrorText } from '../../components/ui.js';
import { Loader } from '../../components/loading.js';
import { FileIcon, PencilIcon, PlusIcon } from '../../components/icons.js';

interface DesktopBridge {
  revealFile(path: string): void;
}

/** The Electron preload bridge, present only in the desktop app. */
function desktopBridge(): DesktopBridge | undefined {
  return (window as unknown as { desktop?: DesktopBridge }).desktop;
}

/**
 * Lists the files a session created or edited, read from the CLI's own session
 * store. Mounted only when its parent disclosure is expanded so we don't query
 * the store for every session on every render. In the desktop app a row reveals
 * the file in the OS file explorer; in the browser it stays informational.
 */
export function SessionFiles({
  sessionId,
  reloadSignal = 0,
}: {
  sessionId: string;
  /**
   * Bumps whenever the session records a new file (via the live SSE stream), so
   * the list re-fetches immediately as the CLI creates/edits files instead of
   * only when the disclosure is first opened.
   */
  reloadSignal?: number;
}) {
  const api = useApi();
  const files = useAsync(
    () => api.listSessionFiles(sessionId),
    [sessionId, reloadSignal],
  );
  const bridge = desktopBridge();

  if (files.loading) {
    return (
      <div className="session-files-loading">
        <Loader label="Loading files" />
      </div>
    );
  }

  const rows = files.data ?? [];
  if (rows.length === 0) {
    return (
      <>
        <p className="session-files-empty">No files changed in this session.</p>
        <ErrorText error={files.error} />
      </>
    );
  }

  return (
    <div className="session-files-list">
      {rows.map((file) => (
        <FileRow
          key={file.path}
          file={file}
          onReveal={bridge ? () => bridge.revealFile(file.path) : undefined}
        />
      ))}
      <ErrorText error={files.error} />
    </div>
  );
}

function FileRow({
  file,
  onReveal,
}: {
  file: SessionFile;
  onReveal?: () => void;
}) {
  const badge =
    file.tool === 'create' ? (
      <span className="session-file-badge is-create" title="Created">
        <PlusIcon size={10} />
      </span>
    ) : (
      <span className="session-file-badge is-edit" title="Edited">
        <PencilIcon size={10} />
      </span>
    );

  const inner = (
    <>
      {badge}
      <FileIcon size={13} className="session-file-icon" />
      <span className="session-file-name">{file.name}</span>
      {file.dir && <span className="session-file-dir">{file.dir}</span>}
    </>
  );

  if (onReveal) {
    return (
      <button
        type="button"
        className="session-file-row is-interactive"
        title={`Reveal ${file.path} in file explorer`}
        onClick={onReveal}
      >
        {inner}
      </button>
    );
  }

  return (
    <span className="session-file-row" title={file.path}>
      {inner}
    </span>
  );
}

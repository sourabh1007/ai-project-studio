import { useId, useState } from 'react';
import { Button, ErrorText, Modal } from '../../components/ui.js';
import { ActivityIcon, CircleIcon, ClockIcon, LogsIcon, PlayIcon, SessionIcon, StopIcon } from '../../components/icons.js';
import type { LiveState } from '../../lib/stream.js';
import type { ActiveSessionEntry, ActiveSessionsApi } from '../active-sessions/active-session-types.js';
import { useActiveSessions } from '../active-sessions/use-active-sessions.js';
import '../active-sessions/active-sessions.css';

export interface ActiveSessionsStatusProps {
  api: ActiveSessionsApi;
  live?: Pick<LiveState, 'sessionRevision'>;
  onOpen(entry: ActiveSessionEntry): void;
}

const stateLabel = (entry: ActiveSessionEntry) =>
  entry.state === 'stopping' ? 'Stopping · unavailable, waiting for process exit'
    : entry.state === 'idle' ? 'Idle · available, not processing'
    : entry.state === 'warming' ? 'Warming · not yet available'
      : entry.state === 'busy' ? 'Busy · IDE operation' : 'Running · workspace terminal';

function SessionSection({ label, entries, onOpen }: {
  label: string;
  entries: ActiveSessionEntry[];
  onOpen(entry: ActiveSessionEntry): void;
}) {
  const headingId = useId();
  return <section className="active-session-section" aria-labelledby={headingId}>
    <h3 id={headingId}>{label} <span className="active-session-section-count">({entries.length})</span></h3>
    {entries.length === 0 ? <p className="muted active-session-empty">None</p> : <ul className="active-session-list">
      {entries.map((entry) => {
        const StateIcon = entry.state === 'idle' ? CircleIcon
          : entry.state === 'warming' ? ClockIcon
            : entry.state === 'stopping' ? StopIcon
              : entry.state === 'busy' ? ActivityIcon : PlayIcon;
        const OpenIcon = entry.kind === 'meta' ? LogsIcon : SessionIcon;
        const action = `${entry.kind === 'meta' ? 'Open live debug' : 'Open terminal tab'}: ${entry.label}`;
        const context = [...new Set([entry.projectName, entry.featureName, entry.purpose]
          .filter((value): value is string => !!value && value !== entry.label))].join(' · ');
        const status = stateLabel(entry);
        return <li key={entry.id} className="active-session-row">
          <span className={`active-session-state active-session-state--${entry.state}`}
            role="img" aria-label={status} title={status}><StateIcon size={14} /></span>
          <span className="active-session-label" title={entry.label}>{entry.label}</span>
          <span className="active-session-context" title={context}>{context}</span>
          <button type="button" onClick={() => onOpen(entry)} className="active-session-open"
            aria-label={action} aria-description={[status, context].filter(Boolean).join(' · ')} title={action}>
            <OpenIcon size={15} />
          </button>
        </li>;
      })}
    </ul>}
  </section>;
}

export function ActiveSessionsStatus({ api, live, onOpen }: ActiveSessionsStatusProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ActiveSessionEntry | null>(null);
  const monitor = useActiveSessions(api, selected?.id ?? null, live?.sessionRevision);
  const { snapshot, debug, error, debugError, refresh } = monitor;
  const entries = snapshot?.entries ?? [];
  const title = selected ? 'IDE metasession · live debug' : 'Active sessions';
  const current = selected ? entries.find((entry) => entry.id === selected.id) : null;
  const details = current ?? selected;
  const count = snapshot ? entries.length : '?';

  function close() { setSelected(null); setOpen(false); }
  function activate(entry: ActiveSessionEntry) {
    if (entry.kind === 'meta') setSelected(entry);
    else { close(); onOpen(entry); }
  }
  return <>
    <button type="button" className="statusbar-item active-sessions-status" aria-haspopup="dialog"
      aria-expanded={open} title="Open active workspace sessions and IDE metasessions (including idle warm capacity)"
      onClick={() => { setOpen(true); refresh(); }}>
      {count} active{error ? ' · stale' : ''}
    </button>
    {open && <Modal title={title} size="xl" className="active-sessions-modal" onClose={close}>
      <div className="active-sessions-panel">
        <ErrorText error={error} />
        {error && <Button onClick={refresh}>Retry active sessions</Button>}
        {!snapshot && !error && <p role="status">Loading active sessions…</p>}
        {selected ? <>
          <Button onClick={() => setSelected(null)}>Back to active sessions</Button>
          <h3>{current?.label ?? selected.label}</h3>
          <p className="muted">Read-only inspection of the existing IDE-owned session. Opening this window does not launch AI work or send input.</p>
          <p>{current ? stateLabel(current) : 'Session is no longer active.'}</p>
          <dl className="active-session-details">
            <dt>Project</dt><dd>{details?.projectName ?? 'Not associated'}</dd>
            <dt>Feature</dt><dd>{details?.featureName ?? details?.featureId ?? 'Not associated'}</dd>
            <dt>Purpose / task</dt><dd>{details?.purpose ?? 'Not supplied by this operation'}</dd>
            <dt>Provider / model</dt><dd>{details?.provider ?? 'Not reported'} / {details?.model ?? 'Not reported'}</dd>
            <dt>Operation</dt><dd>{details?.operationId ?? 'No current operation'}</dd>
            <dt>Operation status</dt><dd>{debug?.state ?? 'Loading…'}</dd>
          </dl>
          <ErrorText error={debugError} />
          {debugError && <Button onClick={refresh}>Retry live debug</Button>}
          <ErrorText error={debug?.error ?? null} />
          {!debug && !debugError && !error && <p role="status">Loading live activity…</p>}
          {debug && <>
            <p className="muted">Last sampled: {new Date(debug.sampledAt).toLocaleTimeString()}. Prompts and authentication payloads are not shown.</p>
            {debug.truncated && <p role="status">Showing a bounded activity/output tail; earlier text was omitted.</p>}
            <h3>Recent activity</h3>
            {debug.activity.length ? <ol className="active-session-activity">{debug.activity.map((line, index) => <li key={index}>{line}</li>)}</ol>
              : <p>No activity available for this session.</p>}
            <h3>{current?.state === 'idle' ? 'Last operation output' : 'Live output'}</h3>
            {debug.output ? <pre className="active-session-output">{debug.output}</pre>
              : <p>No output available{current?.state === 'idle' ? ' — this warm session is idle.' : '.'}</p>}
          </>}
        </> : <>
          {snapshot && entries.length === 0 && <p>No active sessions.</p>}
          {snapshot && <>
            <SessionSection label="Metasessions" entries={entries.filter((entry) => entry.kind === 'meta')} onOpen={activate} />
            <SessionSection label="Other sessions" entries={entries.filter((entry) => entry.kind !== 'meta')} onOpen={activate} />
          </>}
        </>}
      </div>
    </Modal>}
  </>;
}

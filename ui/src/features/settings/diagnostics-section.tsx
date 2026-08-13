import { useState } from 'react';
import { Button, Card } from '../../components/ui.js';
import { useConnectionStatus } from '../../hooks/use-connection-status.js';
import {
  buildDiagnostics,
  formatDiagnostics,
} from '../../lib/diagnostics.js';
import {
  clearFailures,
  listFailures,
  type FailureEntry,
} from '../../lib/failure-log.js';
import type { ConnectionState } from '../../lib/connection-status.js';

/** The Electron preload bridge, present only in the desktop app. */
interface DiagnosticsBridge {
  relaunch(): void;
}

interface DiagnosticsSectionProps {
  version: string | null;
  logDirectory: string | null;
  bridge?: DiagnosticsBridge;
}

const HEALTH_LABEL: Record<ConnectionState, string> = {
  online: 'ok',
  'backend-down': 'unreachable',
  offline: 'unknown',
};

function readPlatform(): string {
  return typeof navigator === 'undefined' ? 'unknown' : navigator.platform;
}

function readUserAgent(): string {
  return typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent;
}

function FailureList({ failures }: { failures: readonly FailureEntry[] }) {
  if (failures.length === 0) {
    return (
      <p className="diag-empty">No failures recorded this session.</p>
    );
  }
  return (
    <ul className="diag-failures">
      {failures.map((f, i) => (
        <li className="diag-failure" key={`${f.at}-${i}`}>
          <span className="diag-failure-context">{f.context}</span>
          <span className="diag-failure-message">{f.message}</span>
          <time className="diag-failure-time" dateTime={f.at}>
            {new Date(f.at).toLocaleTimeString()}
          </time>
        </li>
      ))}
    </ul>
  );
}

/**
 * Settings ▸ "Diagnostics & recovery" (Phase 4e).
 *
 * A local-only place to see the app's current health, review recent client-side
 * failures, export a shareable diagnostics report, and recover by restarting the
 * app. Everything shown is gathered on-device: no secrets, no network calls
 * beyond the health probe the connection banner already runs. Product-specific
 * note: this build has no separate "workers" or search "index" to rebuild, so we
 * expose the recovery actions that actually apply (restart) rather than fake
 * buttons.
 */
export function DiagnosticsSection({
  version,
  logDirectory,
  bridge,
}: DiagnosticsSectionProps) {
  const connection = useConnectionStatus();
  const [failures, setFailures] = useState<readonly FailureEntry[]>(() =>
    listFailures(),
  );
  const [copied, setCopied] = useState(false);

  const refresh = () => {
    setFailures(listFailures().slice());
  };

  const clear = () => {
    clearFailures();
    setFailures([]);
  };

  const buildReport = () =>
    buildDiagnostics({
      version,
      platform: readPlatform(),
      userAgent: readUserAgent(),
      connection: connection.state,
      health: HEALTH_LABEL[connection.state],
      logDirectory,
      failures: listFailures(),
      now: new Date().toISOString(),
    });

  const copyDiagnostics = () => {
    const text = formatDiagnostics(buildReport());
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        },
        () => {
          /* clipboard may be unavailable; ignore */
        },
      );
    }
  };

  return (
    <Card>
      <div className="page-header">
        <div>
          <h2 className="page-title">Diagnostics &amp; recovery</h2>
          <p className="page-subtitle">
            A local-only snapshot of the app&apos;s health and recent failures.
            Copy it when reporting an issue — it never leaves your machine on its
            own.
          </p>
        </div>
        <div className="diag-actions">
          <Button variant="ghost" onClick={copyDiagnostics}>
            {copied ? 'Copied' : 'Copy diagnostics'}
          </Button>
          {bridge && (
            <Button variant="ghost" onClick={() => bridge.relaunch()}>
              Restart app
            </Button>
          )}
        </div>
      </div>

      <dl className="kv">
        <div style={{ display: 'contents' }}>
          <dt>Connection</dt>
          <dd>{connection.title}</dd>
        </div>
        <div style={{ display: 'contents' }}>
          <dt>Backend health</dt>
          <dd>{HEALTH_LABEL[connection.state]}</dd>
        </div>
        <div style={{ display: 'contents' }}>
          <dt>App version</dt>
          <dd>{version ?? '—'}</dd>
        </div>
        <div style={{ display: 'contents' }}>
          <dt>Platform</dt>
          <dd>{readPlatform()}</dd>
        </div>
      </dl>

      <div className="diag-failures-head">
        <h3 className="diag-subtitle">Recent failures</h3>
        <div className="diag-actions">
          <Button variant="ghost" onClick={refresh}>
            Refresh
          </Button>
          {failures.length > 0 && (
            <Button variant="ghost" onClick={clear}>
              Clear
            </Button>
          )}
        </div>
      </div>
      <FailureList failures={failures} />
    </Card>
  );
}

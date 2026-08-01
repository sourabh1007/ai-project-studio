import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { resolveApiBase } from '../../lib/api-base.js';
import { CheckIcon, RefreshIcon } from '../../components/icons.js';

type Phase = 'checking' | 'installing' | 'done' | 'error';

interface InstallEvent {
  kind: 'line' | 'done' | 'error';
  line?: string;
  message?: string;
}

/**
 * First-run gate that ensures the bundled Microsoft `agency` CLI is installed
 * before the app is usable. When agency is missing it streams the install
 * (via SSE) with live progress; once present it renders the app. A manual
 * "Continue anyway" escape hatch avoids hard-bricking the app if install fails.
 */
export function AgencyInstallGate({ children }: { children: React.ReactNode }) {
  const api = useApi();
  const [phase, setPhase] = useState<Phase>('checking');
  const [lines, setLines] = useState<{ id: number; text: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [bypassed, setBypassed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const logRef = useRef<HTMLDivElement | null>(null);
  // Monotonic id for log lines so React keys stay stable and unique even across
  // resets and duplicate line text (array index keys are an anti-pattern).
  const nextLineId = useRef(0);

  // Probe status first; only start an install when agency is actually missing.
  useEffect(() => {
    let cancelled = false;
    setPhase('checking');
    api
      .getAgencyStatus()
      .then((status) => {
        if (cancelled) {
          return;
        }
        setPhase(status.installed ? 'done' : 'installing');
      })
      .catch(() => {
        // If the status probe fails we cannot confirm agency; attempt install.
        if (!cancelled) {
          setPhase('installing');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, attempt]);

  // Drive the SSE install stream while in the installing phase.
  useEffect(() => {
    if (phase !== 'installing') {
      return;
    }
    setLines([]);
    setError(null);
    const base = resolveApiBase(
      typeof window !== 'undefined' ? window.__CW_API_BASE__ : undefined,
      import.meta.env.VITE_API_BASE,
    );
    const source = new EventSource(`${base}/agency/install`);
    source.onmessage = (raw: MessageEvent<string>) => {
      let event: InstallEvent;
      try {
        event = JSON.parse(raw.data) as InstallEvent;
      } catch {
        return;
      }
      if (event.kind === 'line' && event.line !== undefined) {
        setLines((prev) => [
          ...prev,
          { id: nextLineId.current++, text: event.line as string },
        ]);
      } else if (event.kind === 'done') {
        source.close();
        setPhase('done');
      } else if (event.kind === 'error') {
        source.close();
        setError(event.message ?? 'Installation failed');
        setPhase('error');
      }
    };
    source.onerror = () => {
      source.close();
      setError('Lost connection to the installer');
      setPhase('error');
    };
    return () => {
      source.close();
    };
  }, [phase]);

  // Keep the log scrolled to the latest line.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines]);

  if (phase === 'done' || bypassed) {
    return <>{children}</>;
  }

  return (
    <div className="bootstrap-gate">
      <div className="bootstrap-card">
        <div className="bootstrap-head">
          <span className="bootstrap-badge">
            {phase === 'error' ? '!' : <RefreshIcon size={18} />}
          </span>
          <div>
            <h1 className="bootstrap-title">
              {phase === 'checking'
                ? 'Preparing AI Project Studio'
                : phase === 'error'
                  ? 'Agency installation failed'
                  : 'Installing Agency'}
            </h1>
            <p className="bootstrap-subtitle">
              {phase === 'checking'
                ? 'Checking for the Agency CLI…'
                : phase === 'error'
                  ? (error ?? 'Something went wrong.')
                  : 'Setting up the Microsoft Agency CLI. This runs once.'}
            </p>
          </div>
        </div>

        {(phase === 'installing' || phase === 'error') && lines.length > 0 && (
          <div className="bootstrap-log" ref={logRef}>
            {lines.map((line) => (
              <div key={line.id} className="bootstrap-log-line">
                {line.text}
              </div>
            ))}
          </div>
        )}

        {phase === 'installing' && (
          <div className="bootstrap-status">
            <span className="bootstrap-spinner" aria-hidden />
            Installing…
          </div>
        )}

        {phase === 'error' && (
          <div className="bootstrap-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setAttempt((n) => n + 1)}
            >
              <RefreshIcon size={14} /> Retry
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setBypassed(true)}
            >
              <CheckIcon size={14} /> Continue anyway
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

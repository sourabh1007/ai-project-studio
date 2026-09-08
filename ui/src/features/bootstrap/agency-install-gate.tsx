import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { resolveApiBase } from '../../lib/api-base.js';
import { CheckIcon, RefreshIcon } from '../../components/icons.js';
import { Button } from '../../components/ui.js';

type Phase = 'checking' | 'installing' | 'done' | 'error' | 'uncertain';
const STATUS_TIMEOUT_MS = 15_000;
const PROGRESS_TIMEOUT_MS = 30_000;
const MAX_LOG_LINES = 200;
const MAX_LOG_LINE_CHARS = 1_000;

interface InstallEvent {
  kind: 'line' | 'done' | 'error';
  line?: string;
  message?: string;
}

/**
 * First-run setup with bounded status/progress waits and an always-available
 * deferral. Unknown installation state never authorizes another installer.
 */
export function AgencyInstallGate({ children }: { children: React.ReactNode }) {
  const api = useApi();
  const [phase, setPhase] = useState<Phase>('checking');
  const [lines, setLines] = useState<{ id: number; text: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [bypassed, setBypassed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [stalled, setStalled] = useState(false);
  const installMayBeRunning = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  // Monotonic id for log lines so React keys stay stable and unique even across
  // resets and duplicate line text (array index keys are an anti-pattern).
  const nextLineId = useRef(0);

  // Probe status first; only start an install when agency is actually missing.
  useEffect(() => {
    if (bypassed) return;
    let cancelled = false;
    setPhase('checking');
    setError(null);
    const timer = setTimeout(() => {
      cancelled = true;
      setError('Could not confirm whether Agency is installed: the status check timed out.');
      setPhase('error');
    }, STATUS_TIMEOUT_MS);
    api
      .getAgencyStatus()
      .then((status) => {
        if (cancelled) {
          return;
        }
        clearTimeout(timer);
        if (typeof status.installed !== 'boolean') {
          throw new Error('The status response did not confirm installation availability.');
        }
        if (status.installed) {
          setPhase('done');
        } else if (installMayBeRunning.current) {
          setError('The previous installer may still be running. Check again later; another installation will not be started.');
          setPhase('uncertain');
        } else {
          setPhase('installing');
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          clearTimeout(timer);
          setError(`Could not confirm whether Agency is installed: ${failure instanceof Error ? failure.message : String(failure)}`);
          setPhase('error');
        }
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, attempt, bypassed]);

  // Drive the SSE install stream while in the installing phase.
  useEffect(() => {
    if (phase !== 'installing' || bypassed) {
      return;
    }
    setLines([]);
    setError(null);
    setStalled(false);
    installMayBeRunning.current = true;
    let active = true;
    let watchdog: ReturnType<typeof setTimeout>;
    const armWatchdog = () => {
      clearTimeout(watchdog);
      setStalled(false);
      watchdog = setTimeout(() => setStalled(true), PROGRESS_TIMEOUT_MS);
    };
    const base = resolveApiBase(
      typeof window !== 'undefined' ? window.__CW_API_BASE__ : undefined,
      import.meta.env.VITE_API_BASE,
    );
    const source = new EventSource(`${base}/agency/install`);
    armWatchdog();
    source.onmessage = (raw: MessageEvent<string>) => {
      if (!active) return;
      let event: InstallEvent;
      try {
        const parsed: unknown = JSON.parse(raw.data);
        if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) return;
        event = parsed as InstallEvent;
      } catch {
        return;
      }
      if (event.kind === 'line' && typeof event.line === 'string') {
        armWatchdog();
        const text = event.line.length > MAX_LOG_LINE_CHARS
          ? `${event.line.slice(0, MAX_LOG_LINE_CHARS)}... (truncated)`
          : event.line;
        setLines((prev) => [
          ...prev.slice(-(MAX_LOG_LINES - 1)),
          { id: nextLineId.current++, text },
        ]);
      } else if (event.kind === 'done') {
        active = false;
        clearTimeout(watchdog);
        installMayBeRunning.current = false;
        source.close();
        setPhase('done');
      } else if (event.kind === 'error') {
        active = false;
        clearTimeout(watchdog);
        installMayBeRunning.current = false;
        source.close();
        setError(typeof event.message === 'string' ? event.message : 'Installation failed');
        setPhase('error');
      }
    };
    source.onerror = () => {
      if (!active) return;
      active = false;
      clearTimeout(watchdog);
      source.close();
      setError('Lost connection to the installer. Installation may still be running; no cancellation has been confirmed.');
      setPhase('uncertain');
    };
    return () => {
      active = false;
      clearTimeout(watchdog);
      source.close();
    };
  }, [phase, bypassed]);

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
            {phase === 'error' || phase === 'uncertain' ? '!' : <RefreshIcon size={18} />}
          </span>
          <div>
            <h1 className="bootstrap-title">
              {phase === 'checking'
                ? 'Preparing AI Project Studio'
                : phase === 'error'
                  ? 'Agency setup needs attention'
                  : phase === 'uncertain'
                    ? 'Installation status unknown'
                    : 'Installing Agency'}
            </h1>
            <p className="bootstrap-subtitle" role={phase === 'error' || phase === 'uncertain' ? 'alert' : undefined}>
              {phase === 'checking'
                ? 'Checking for the Agency CLI…'
                : phase === 'error' || phase === 'uncertain'
                  ? (error ?? 'Something went wrong.')
                  : 'Setting up the Microsoft Agency CLI. This runs once.'}
            </p>
          </div>
        </div>

        {lines.length > 0 && (
          <div className="bootstrap-log" ref={logRef} role="log" aria-label="Recent installation output">
            {lines.map((line) => (
              <div key={line.id} className="bootstrap-log-line">
                {line.text}
              </div>
            ))}
          </div>
        )}

        {phase === 'installing' && (
          <div className="bootstrap-status" role="status">
            <span className="bootstrap-spinner" aria-hidden />
            {stalled ? 'No installer progress for 30 seconds. It may still be running; you can continue without waiting.' : 'Installing…'}
          </div>
        )}

        <div className="bootstrap-actions">
          {(phase === 'error' || phase === 'uncertain') && (
            <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshIcon size={14} /> Check again
            </Button>
          )}
          <Button variant="secondary" onClick={() => setBypassed(true)}>
            <CheckIcon size={14} /> Continue without waiting
          </Button>
        </div>
        <p className="field-hint">
          Agency-dependent features may be unavailable until setup completes.
          Continuing does not cancel an installer already running.
        </p>
      </div>
    </div>
  );
}

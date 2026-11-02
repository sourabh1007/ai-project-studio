import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { resolveApiBase } from '../../lib/api-base.js';
import { CheckIcon, RefreshIcon } from '../../components/icons.js';
import { Button } from '../../components/ui.js';
import type { ProviderSelectionInfo } from '../../lib/api.js';
import { providerLabel } from '../../lib/meta-model.js';
import { announceProvider } from '../../lib/provider-selection.js';

type Phase = 'checking' | 'choosing' | 'selecting' | 'installing' | 'done' | 'error' | 'uncertain';
const STATUS_TIMEOUT_MS = 15_000;
const PROGRESS_TIMEOUT_MS = 30_000;
const MAX_LOG_LINES = 200;
const MAX_LOG_LINE_CHARS = 1_000;

interface InstallEvent {
  kind: 'line' | 'done' | 'error';
  line?: string;
  message?: string;
}

/** Detection is read-only; selecting and installing each require explicit consent. */
export function ProviderInstallGate({ children, forceChoose = false }: { children: React.ReactNode; forceChoose?: boolean }) {
  const api = useApi();
  const [phase, setPhase] = useState<Phase>('checking');
  const [target, setTarget] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const [info, setInfo] = useState<ProviderSelectionInfo | null>(null);
  const [lines, setLines] = useState<{ id: number; text: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [bypassed, setBypassed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [stalled, setStalled] = useState(false);
  const installMayBeRunning = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const nextLineId = useRef(0);
  const choosing = useRef(false);
  const pendingAnnouncement = useRef<ProviderSelectionInfo | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const label = target ? providerLabel(target) : 'the AI CLI';

  // Rechecks never restart an installer.
  useEffect(() => {
    if (bypassed) return;
    let cancelled = false;
    setPhase('checking');
    setError(null);
    const timer = setTimeout(() => {
      cancelled = true;
      setError('Could not confirm whether the AI CLI is installed: the status check timed out.');
      setPhase('error');
    }, STATUS_TIMEOUT_MS);
    api
      .getProviderBootstrap()
      .then((info) => {
        if (cancelled) {
          return;
        }
        clearTimeout(timer);
        if ((info.selectionRequired === true || forceChoose) && !installMayBeRunning.current) {
          if (info.providers.length === 0 || info.providers.some((provider) => typeof provider.installed !== 'boolean')) {
            throw new Error('No eligible CLI installation choices could be confirmed.');
          }
          setInfo(info);
          setPhase('choosing');
          return;
        }
        const entry = info.providers.find((p) => p.id === info.defaultProvider);
        if (!entry || typeof entry.installed !== 'boolean') {
          throw new Error('The status response did not confirm installation availability.');
        }
        setTarget(info.defaultProvider);
        setInfo(info);
        if (entry.installed && info.selectionRequired !== true) {
          setPhase('done');
          if (pendingAnnouncement.current) {
            pendingAnnouncement.current = null;
            announceProvider(info);
          }
        } else if (installMayBeRunning.current) {
          setError('The previous installer may still be running. Check again later; another installation will not be started.');
          setPhase('uncertain');
        } else {
          setPhase('choosing');
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          clearTimeout(timer);
          setError(`Could not confirm whether the AI CLI is installed: ${failure instanceof Error ? failure.message : String(failure)}`);
          setPhase('error');
        }
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, attempt, bypassed, forceChoose]);

  async function choose(provider: ProviderSelectionInfo['providers'][number]) {
    if (choosing.current || installMayBeRunning.current) return;
    choosing.current = true;
    setPhase('selecting');
    setError(null);
    setTarget(provider.id);
    try {
      const selected = await api.selectProvider(provider.id, { remember });
      if (!mounted.current) return;
      const entry = selected.providers.find((p) => p.id === provider.id);
      if (selected.defaultProvider !== provider.id || selected.selectionRequired === true || !entry || typeof entry.installed !== 'boolean') {
        throw new Error('The server did not confirm the selected CLI.');
      }
      setInfo(selected);
      if (!entry.installed && provider.installed) {
        setError('The selected CLI is no longer detected. Choose Install and use to authorize installation.');
        setPhase('choosing');
        return;
      }
      if (!entry.installed && entry.installAvailable === false) {
        setError('Automatic installation is unavailable for the selected CLI.');
        setPhase('choosing');
        return;
      }
      pendingAnnouncement.current = entry.installed ? null : selected;
      if (entry.installed) announceProvider(selected);
      setPhase(entry.installed ? 'done' : 'installing');
    } catch (failure: unknown) {
      if (mounted.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setPhase('choosing');
      }
    } finally {
      choosing.current = false;
    }
  }

  async function stopIdle() {
    if (choosing.current) return;
    choosing.current = true;
    setPhase('selecting');
    setError(null);
    try {
      await api.stopIdleProviderWorkers();
      const refreshed = await api.getProviderBootstrap();
      if (mounted.current) setInfo(refreshed);
    } catch (failure: unknown) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      choosing.current = false;
      if (mounted.current) setPhase('choosing');
    }
  }

  // Drive the SSE install stream for the target provider while installing.
  useEffect(() => {
    if (phase !== 'installing' || bypassed || !target) {
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
    const source = new EventSource(`${base}/${target}/install`);
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
        const selected = pendingAnnouncement.current;
        if (selected) {
          pendingAnnouncement.current = null;
          announceProvider({
            ...selected,
            providers: selected.providers.map((provider) =>
              provider.id === target ? { ...provider, installed: true } : provider),
          });
        }
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
  }, [phase, bypassed, target]);

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
                  ? `${label} setup needs attention`
                  : phase === 'uncertain'
                    ? 'Installation status unknown'
                    : phase === 'choosing' || phase === 'selecting'
                      ? 'Choose your AI CLI'
                      : `Installing ${label}`}
            </h1>
            <p className="bootstrap-subtitle" role={phase === 'error' || phase === 'uncertain' ? 'alert' : undefined}>
              {phase === 'checking'
                ? 'Checking your AI CLI setup…'
                : phase === 'error' || phase === 'uncertain'
                  ? (error ?? 'Something went wrong.')
                  : phase === 'choosing' || phase === 'selecting'
                    ? 'Use one CLI at a time. Nothing is installed until you choose Install and use.'
                    : `Setting up ${label}.`}
            </p>
          </div>
        </div>

        {(phase === 'choosing' || phase === 'selecting') && (
          <div>
            {error && <p role="alert">{error}</p>}
            <label className="field">
              <span><input type="checkbox" aria-label="Remember me" checked={remember} disabled={phase === 'selecting'} onChange={(event) => setRemember(event.target.checked)} /> Remember me</span>
              <span className="field-hint">Use this CLI automatically next time. Otherwise choose again after restarting.</span>
            </label>
            {info?.blockers?.map((blocker) => (
              <p key={`${blocker.kind}:${blocker.id}`}>Stop {blocker.label} before switching CLI.</p>
            ))}
            {Boolean(info?.blockers?.length) && info?.blockers?.every((blocker) => /warm|probe|pool/i.test(blocker.kind)) && (
              <Button disabled={phase === 'selecting'} onClick={() => void stopIdle()}>Stop idle background CLI workers</Button>
            )}
            {info?.providers.map((provider) => (
              <div key={provider.id} className="config-namespace">
                <h2>{provider.label ?? providerLabel(provider.id)}</h2>
                <p>{provider.installed ? 'Installed' : 'Not installed'}</p>
                {provider.automation?.supported === false && <p>Interactive use only — automated AI is unavailable. {provider.automation.reason} Choose another CLI for agents and AI planning.</p>}
                {provider.installCommand && <code>{provider.installCommand}</code>}
                {!provider.installed && provider.installAvailable === false && <p>Automatic installation unavailable.</p>}
                <Button
                  disabled={phase === 'selecting' || (!provider.installed && provider.installAvailable === false) || Boolean(info.blockers?.length)}
                  onClick={() => void choose(provider)}
                >
                  {provider.installed ? 'Use installed CLI' : 'Install and use'} — {provider.label ?? providerLabel(provider.id)}
                </Button>
              </div>
            ))}
          </div>
        )}

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
          <Button variant="secondary" disabled={phase === 'selecting'} onClick={() => setBypassed(true)}>
            <CheckIcon size={14} /> Continue without waiting
          </Button>
        </div>
        <p className="field-hint">
          AI CLI features may be unavailable until setup completes.
          Continuing does not cancel an installer already running.
        </p>
      </div>
    </div>
  );
}

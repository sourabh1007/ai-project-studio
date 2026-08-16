import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Modal, Button } from '../../components/ui.js';
import { Spinner } from '../../components/loading.js';
import type { DeviceCodeStart } from '../../lib/types.js';

interface DesktopBridge {
  openExternal(url: string): void;
}

function openExternal(url: string) {
  const bridge = (window as unknown as { desktop?: DesktopBridge }).desktop;
  if (bridge?.openExternal) {
    bridge.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Phase =
  | { kind: 'starting' }
  | { kind: 'awaiting'; code: DeviceCodeStart }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

/**
 * Drives the GitHub device-code sign-in flow entirely in-app: it asks the
 * backend for a user code, shows it with a one-click link to GitHub's
 * verification page, then polls until GitHub reports the login completed (or the
 * code expires). Every state is expressed with motion — never a bare "Loading…"
 * string — matching the product's animation-first loading language.
 */
export function GithubSignInModal({
  onClose,
  onAuthenticated,
}: {
  onClose: () => void;
  onAuthenticated: () => void;
}) {
  const api = useApi();
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [copied, setCopied] = useState(false);
  // Bumping this restarts the whole flow (used by "Try again").
  const [attempt, setAttempt] = useState(0);
  const cancelled = useRef(false);

  const retry = useCallback(() => {
    setCopied(false);
    setPhase({ kind: 'starting' });
    setAttempt((n) => n + 1);
  }, []);

  const copyCode = useCallback((code: string) => {
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void (async () => {
      try {
        const code = await api.githubSignInStart();
        if (cancelled.current) return;
        setPhase({ kind: 'awaiting', code });
        openExternal(code.verificationUri);

        // GitHub's `slow_down` tells us to poll less often; we add 5s to the
        // interval each time or the flow can spin until the code expires.
        let intervalMs = Math.max(code.interval, 1) * 1000;
        const deadline = Date.now() + Math.max(code.expiresIn, 1) * 1000;
        while (!cancelled.current && Date.now() < deadline) {
          await sleep(intervalMs);
          if (cancelled.current) return;
          const result = await api.githubSignInPoll(code.deviceCode);
          if (cancelled.current) return;
          if (result.status === 'success') {
            setPhase({ kind: 'success' });
            await sleep(800);
            if (!cancelled.current) onAuthenticated();
            return;
          }
          if (result.status === 'error') {
            setPhase({ kind: 'error', message: result.message });
            return;
          }
          if (result.slowDown) {
            intervalMs += 5000;
          }
        }
        if (!cancelled.current) {
          setPhase({
            kind: 'error',
            message: 'The code expired before sign-in completed. Please try again.',
          });
        }
      } catch (err) {
        if (!cancelled.current) {
          setPhase({
            kind: 'error',
            message: err instanceof Error ? err.message : 'Sign-in could not be started.',
          });
        }
      }
    })();
    return () => {
      cancelled.current = true;
    };
  }, [api, onAuthenticated, attempt]);

  return (
    <Modal title="Sign in to GitHub" onClose={onClose}>
      <div className="device-signin">
        {phase.kind === 'starting' && (
          <div className="device-signin-center">
            <Spinner size={28} label="Preparing sign-in" />
          </div>
        )}

        {phase.kind === 'awaiting' && (
          <div className="device-signin-awaiting">
            <p className="device-signin-lead">
              Enter this code on GitHub to finish signing in:
            </p>
            <button
              type="button"
              className="device-code"
              aria-label={`Copy your one-time device code ${phase.code.userCode}`}
              title="Click to copy"
              onClick={() => copyCode(phase.code.userCode)}
            >
              {phase.code.userCode}
            </button>
            <p className="device-code-hint" aria-live="polite">
              {copied ? 'Copied to clipboard' : 'Click the code to copy it'}
            </p>
            <Button onClick={() => openExternal(phase.code.verificationUri)}>
              Open GitHub
            </Button>
            <div className="device-signin-waiting">
              <Spinner size={14} label="Waiting for authorization" />
              <span className="device-signin-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}

        {phase.kind === 'success' && (
          <div className="device-signin-center device-signin-success">
            <span className="success-check" aria-hidden="true" />
            <p>Signed in</p>
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="device-signin-center device-signin-error">
            <p className="device-signin-error-msg">{phase.message}</p>
            <div className="device-signin-error-actions">
              <Button onClick={retry}>Try again</Button>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

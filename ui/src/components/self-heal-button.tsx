import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, StatusBadge } from './ui.js';
import {
  INITIAL_SELF_HEAL_STATE,
  deriveSelfHealUi,
  reduceSelfHeal,
  type SelfHealEvent,
  type SelfHealState,
} from '../lib/self-heal.js';
import { resolveApiBase } from '../lib/api-base.js';

/**
 * Drives a backend self-heal run over SSE and shows a live, premium status.
 * Used wherever a fixable environment error is surfaced (missing CLI,
 * unconfigured model): instead of a dead-end message, the user gets a one-click
 * "fix it" button with animated progress and a streamed log.
 */
export function SelfHealButton({
  target,
  label,
  onHealed,
}: {
  /** Backend heal target id (e.g. `github-cli`). */
  target: string;
  /** Button label shown while idle. */
  label: string;
  /** Called once the problem is confirmed resolved. */
  onHealed?: () => void;
}) {
  const [state, setState] = useState<SelfHealState>(INITIAL_SELF_HEAL_STATE);
  const [running, setRunning] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const onHealedRef = useRef(onHealed);
  onHealedRef.current = onHealed;

  useEffect(
    () => () => {
      sourceRef.current?.close();
    },
    [],
  );

  const start = useCallback(() => {
    sourceRef.current?.close();
    setState(INITIAL_SELF_HEAL_STATE);
    setRunning(true);
    const base = resolveApiBase(
      typeof window !== 'undefined' ? window.__CW_API_BASE__ : undefined,
      import.meta.env.VITE_API_BASE,
    );
    const source = new EventSource(`${base}/self-heal/${target}/run`);
    sourceRef.current = source;
    source.onmessage = (raw: MessageEvent<string>) => {
      let event: SelfHealEvent;
      try {
        event = JSON.parse(raw.data) as SelfHealEvent;
      } catch {
        return;
      }
      setState((prev) => reduceSelfHeal(prev, event));
      if (event.kind === 'done') {
        source.close();
        setRunning(false);
        if (event.healed) {
          onHealedRef.current?.();
        }
      } else if (event.kind === 'error') {
        source.close();
        setRunning(false);
      }
    };
    source.onerror = () => {
      source.close();
      setRunning(false);
      setState((prev) =>
        reduceSelfHeal(prev, {
          kind: 'error',
          message: 'Lost connection while fixing. Please retry.',
        }),
      );
    };
  }, [target]);

  const ui = deriveSelfHealUi(state);
  const idle = state.phase === 'idle';

  return (
    <div className="self-heal">
      {!idle && (
        <div className="self-heal-status">
          <StatusBadge status={ui.status} label={ui.headline} />
        </div>
      )}
      {state.logs.length > 0 && (
        <pre className="self-heal-log" aria-live="polite">
          {state.logs.slice(-6).join('\n')}
        </pre>
      )}
      <Button
        variant="secondary"
        onClick={start}
        loading={running}
        disabled={running}
      >
        {idle ? label : running ? 'Fixing…' : 'Try again'}
      </Button>
    </div>
  );
}

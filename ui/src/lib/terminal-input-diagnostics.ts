export type TerminalInputSource =
  | 'paste-event' | 'context-menu' | 'paste-call' | 'xterm-data'
  | 'transport-input' | 'transport-resize' | 'input-ack'
  | 'paste-key' | 'submit-key' | 'beforeinput' | 'input'
  | 'compositionstart' | 'compositionend' | 'focusout' | 'window-blur'
  | 'generation' | 'socket-close' | 'terminal-exit';

export interface TerminalInputObservation {
  operation: number | null;
  source: TerminalInputSource;
  trusted: boolean | null;
  focused: boolean;
  generation: number;
  focusEpoch: number;
  bytes: number;
  outcome: 'observed' | 'accepted' | 'untrusted' | 'duplicate-event' | 'ownership-lost';
  sequence?: number;
  cols?: number;
  rows?: number;
  composing?: boolean;
  fromPaste?: boolean;
}

export interface TerminalInputRecord extends TerminalInputObservation {
  index: number;
  elapsedMs: number;
}

/** Per-view opt-in metadata only: bounded memory, no text, hashes or persistence. */
export function createTerminalInputDiagnostics(now: () => number) {
  let enabled = false;
  let index = 0;
  let operation = 0;
  let identities = new WeakMap<object, number>();
  let records: TerminalInputRecord[] = [];
  let started = now();
  return {
    enabled: () => enabled,
    setEnabled(value: boolean) {
      enabled = value;
      records = [];
      identities = new WeakMap();
      index = 0;
      operation = 0;
      started = now();
    },
    operation(event?: object): number | null {
      if (!enabled) return null;
      if (event) {
        const known = identities.get(event);
        if (known !== undefined) return known;
      }
      const id = ++operation;
      if (event) identities.set(event, id);
      return id;
    },
    record(observation: TerminalInputObservation) {
      if (!enabled) return;
      // Project allowed fields explicitly; even an over-wide runtime object
      // cannot accidentally retain event.data, clipboard text or file paths.
      const { operation, source, trusted, focused, generation, focusEpoch, bytes,
        outcome, sequence, cols, rows, composing, fromPaste } = observation;
      records.push({ index: ++index, elapsedMs: Math.max(0, now() - started), operation, source, trusted, focused,
        generation, focusEpoch, bytes, outcome, sequence, cols, rows, composing, fromPaste });
      if (records.length > 128) records.shift();
    },
    snapshot: (): TerminalInputRecord[] => records.map((record) => ({ ...record })),
  };
}

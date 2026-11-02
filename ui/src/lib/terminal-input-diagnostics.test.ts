import { describe, expect, it } from 'vitest';
import { createTerminalInputDiagnostics, type TerminalInputObservation } from './terminal-input-diagnostics.js';

const observation: TerminalInputObservation = {
  operation: null, source: 'paste-event', trusted: true, focused: true,
  generation: 2, focusEpoch: 3, bytes: 9, outcome: 'observed',
};

describe('terminal input diagnostics', () => {
  it('is disabled by default and clears metadata and event identities on opt-out or restart', () => {
    let time = 100;
    const trace = createTerminalInputDiagnostics(() => time);
    const event = {};
    expect(trace.enabled()).toBe(false);
    expect(trace.operation(event)).toBeNull();
    trace.record(observation);
    expect(trace.snapshot()).toEqual([]);
    trace.setEnabled(true);
    expect(trace.enabled()).toBe(true);
    expect(trace.operation(event)).toBe(1);
    expect(trace.operation(event)).toBe(1);
    expect(trace.operation({})).toBe(2);
    expect(trace.operation()).toBe(3);
    time = 125;
    trace.record(observation);
    expect(trace.snapshot()[0]).toMatchObject({ index: 1, elapsedMs: 25, ...observation });
    trace.setEnabled(false);
    expect(trace.snapshot()).toEqual([]);
    trace.setEnabled(true);
    expect(trace.operation(event)).toBe(1);
  });

  it('retains only the last 128 metadata records and returns detached snapshots', () => {
    const trace = createTerminalInputDiagnostics(() => 0);
    trace.setEnabled(true);
    const overWide = { ...observation, data: 'PRIVATE', path: 'PRIVATE', clipboardData: 'PRIVATE' };
    for (let i = 0; i < 130; i++) trace.record(overWide);
    const snapshot = trace.snapshot();
    expect(snapshot).toHaveLength(128);
    expect(snapshot[0].index).toBe(3);
    expect(snapshot[127].index).toBe(130);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    snapshot[0].bytes = 999;
    snapshot.pop();
    expect(trace.snapshot()).toHaveLength(128);
    expect(trace.snapshot()[0].bytes).toBe(9);
  });
});

import { describe, expect, it } from 'vitest';
import {
  backendFailureDetail,
  describeBackendFailure,
  readBackendDiagnostics,
  type BackendFailure,
} from './backend-failure.js';

describe('readBackendDiagnostics', () => {
  it('rejects non-object payloads', () => {
    expect(readBackendDiagnostics(null)).toBeNull();
    expect(readBackendDiagnostics('nope')).toBeNull();
  });

  it('reads a well-formed payload', () => {
    const result = readBackendDiagnostics({
      logDirectory: 'C:\\logs',
      failures: [{ at: '2026-01-01T00:00:00Z', kind: 'exit', code: 1 }],
    });
    expect(result).toEqual({
      logDirectory: 'C:\\logs',
      failures: [{ at: '2026-01-01T00:00:00Z', kind: 'exit', code: 1 }],
    });
  });

  it('defaults a non-string log directory and a non-array failure list', () => {
    expect(readBackendDiagnostics({ logDirectory: 7, failures: 'x' })).toEqual({
      logDirectory: null,
      failures: [],
    });
  });

  it('drops entries that are not timestamped failure records', () => {
    const result = readBackendDiagnostics({
      logDirectory: null,
      failures: [null, 'bad', { kind: 'exit' }, { at: 't', kind: 'exit' }],
    });
    expect(result?.failures).toEqual([{ at: 't', kind: 'exit' }]);
  });
});

describe('describeBackendFailure', () => {
  it('reports the supervisor reason when it gave up', () => {
    const failure: BackendFailure = {
      at: 't',
      kind: 'unavailable',
      reason: 'too many restarts',
    };
    expect(describeBackendFailure(failure)).toBe(
      'Gave up restarting the backend: too many restarts',
    );
  });

  it('still reports giving up without a reason', () => {
    expect(describeBackendFailure({ at: 't', kind: 'unavailable' })).toBe(
      'Gave up restarting the backend',
    );
  });

  it('prefers the signal over the exit code', () => {
    expect(
      describeBackendFailure({
        at: 't',
        kind: 'exit',
        signal: 'SIGKILL',
        code: 1,
      }),
    ).toBe('Backend was terminated by SIGKILL');
  });

  it('falls back to the exit code', () => {
    expect(
      describeBackendFailure({ at: 't', kind: 'exit', code: 0, signal: null }),
    ).toBe('Backend exited with code 0');
  });

  it('admits when nothing is known', () => {
    expect(describeBackendFailure({ at: 't', kind: 'exit' })).toBe(
      'Backend exited for an unknown reason',
    );
  });
});

describe('backendFailureDetail', () => {
  it('returns the last non-empty stderr line', () => {
    expect(
      backendFailureDetail({
        at: 't',
        kind: 'exit',
        stderrTail: '  boot\n Error: boom \n\n  ',
      }),
    ).toBe('Error: boom');
  });

  it('returns an empty string when there is no stderr', () => {
    expect(backendFailureDetail({ at: 't', kind: 'exit' })).toBe('');
    expect(
      backendFailureDetail({ at: 't', kind: 'exit', stderrTail: '  \n ' }),
    ).toBe('');
  });
});
import { describe, it, expect } from 'vitest';
import { buildDiagnostics, formatDiagnostics } from './diagnostics';
import type { FailureEntry } from './failure-log';

const failures: FailureEntry[] = [
  { at: '2024-01-01T00:00:00.000Z', context: 'Settings', message: 'boom' },
];

describe('buildDiagnostics', () => {
  it('assembles a structured report from populated input', () => {
    const report = buildDiagnostics({
      version: '1.2.3',
      platform: 'Win32',
      userAgent: 'Electron/30',
      connection: 'online',
      health: 'ok',
      logDirectory: 'C:\\logs',
      failures,
      now: '2024-06-01T12:00:00.000Z',
    });
    expect(report.generatedAt).toBe('2024-06-01T12:00:00.000Z');
    expect(report.app.version).toBe('1.2.3');
    expect(report.environment.platform).toBe('Win32');
    expect(report.environment.userAgent).toBe('Electron/30');
    expect(report.status.connection).toBe('online');
    expect(report.status.health).toBe('ok');
    expect(report.logDirectory).toBe('C:\\logs');
    expect(report.recentFailures).toBe(failures);
  });

  it('falls back to "unknown" for null/blank values', () => {
    const report = buildDiagnostics({
      version: null,
      platform: '   ',
      userAgent: '',
      connection: 'offline',
      health: 'unreachable',
      logDirectory: null,
      failures: [],
      now: '2024-06-01T12:00:00.000Z',
    });
    expect(report.app.version).toBe('unknown');
    expect(report.environment.platform).toBe('unknown');
    expect(report.environment.userAgent).toBe('unknown');
    expect(report.logDirectory).toBe('unknown');
    expect(report.status.connection).toBe('offline');
    expect(report.recentFailures).toHaveLength(0);
  });
});

describe('formatDiagnostics', () => {
  it('serialises the report to pretty JSON', () => {
    const report = buildDiagnostics({
      version: '1.0.0',
      platform: 'Win32',
      userAgent: 'UA',
      connection: 'online',
      health: 'ok',
      logDirectory: 'C:\\logs',
      failures: [],
      now: '2024-06-01T12:00:00.000Z',
    });
    const text = formatDiagnostics(report);
    expect(text).toContain('"version": "1.0.0"');
    expect(text).toContain('\n');
    expect(JSON.parse(text).generatedAt).toBe('2024-06-01T12:00:00.000Z');
  });
});

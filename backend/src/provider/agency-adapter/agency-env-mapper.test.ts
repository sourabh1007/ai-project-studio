import { describe, it, expect, vi } from 'vitest';
import { buildAgencyEnv, resolveAgencyNativeCopilot } from './agency-env-mapper.js';
import type { SessionSpec } from '../provider-contract.js';

const spec: SessionSpec = {
  sessionId: 'sess-1',
  featureId: 'feat-1',
  prompt: 'p',
  model: 'auto',
  kind: 'dev',
  otelFilePath: '/tmp/usage.jsonl',
};

describe('agency-env-mapper', () => {
  it('selects a native Windows CLI instead of npm scripts or the forwarding VS Code shim', () => {
    const native = 'C:\\native\\copilot.exe';
    const files = new Set(['C:\\npm\\copilot', 'C:\\npm\\copilot.cmd', 'C:\\VSCode\\copilot-shim\\copilot.exe', native]);
    const pathEnv = 'C:\\npm;C:\\VSCode\\copilot-shim;C:\\native';
    const deps = { isWindows: true, fileExists: (path: string) => files.has(path) };
    expect(resolveAgencyNativeCopilot(pathEnv, deps)).toBe(native);
    expect(resolveAgencyNativeCopilot('C:\\npm;C:\\VSCode\\COPILOT-SHIM', deps)).toBeNull();
    expect(resolveAgencyNativeCopilot('', deps)).toBeNull();
    expect(resolveAgencyNativeCopilot('C:\\no-cli', deps)).toBeNull();
    expect(resolveAgencyNativeCopilot(pathEnv, { ...deps, isWindows: false })).toBeNull();
  });

  it('prioritizes the selected native CLI only in the child environment and preserves all other paths', () => {
    const base = { PATH: 'C:\\npm;C:\\native;C:\\Windows', OTHER: 'preserved' };
    const env = buildAgencyEnv(spec, base, 'C:\\native\\copilot.exe');
    expect(env.PATH).toBe('C:\\native;C:\\npm;C:\\native;C:\\Windows');
    expect(env.OTHER).toBe('preserved');
    expect(base.PATH).toBe('C:\\npm;C:\\native;C:\\Windows');
    expect(buildAgencyEnv(spec, {}, 'C:\\native\\copilot.exe').PATH).toBe('C:\\native');
    expect(buildAgencyEnv(spec, { Path: 'C:\\npm' }, 'C:\\native\\copilot.exe'))
      .toMatchObject({ Path: 'C:\\native;C:\\npm' });
    expect(buildAgencyEnv(spec, base, null).PATH).toBe(base.PATH);
  });

  it('recovers npm-only Windows installations before Agency can select the rejected command shim', () => {
    const native = 'Q:\\.tools\\.npm-global\\node_modules\\@github\\copilot\\node_modules\\@github\\copilot-win32-x64\\copilot.exe';
    const shim = 'Q:\\.tools\\.npm-global\\copilot.cmd';
    const nativeFromNpm = vi.fn((path: string) => path === shim ? native : null);
    const deps = {
      isWindows: true,
      fileExists: (path: string) => path.endsWith('copilot.cmd'),
      nativeFromNpm,
    };
    expect(resolveAgencyNativeCopilot('C:\\stale;Q:\\.tools\\.npm-global', deps)).toBe(native);
    expect(nativeFromNpm.mock.calls.map(([path]) => path)).toEqual(['C:\\stale\\copilot.cmd', shim]);
    expect(resolveAgencyNativeCopilot('C:\\stale', deps)).toBeNull();
    expect(buildAgencyEnv(spec, { PATH: 'Q:\\.tools\\.npm-global' }, native).PATH)
      .toBe(`${native.slice(0, native.lastIndexOf('\\'))};Q:\\.tools\\.npm-global`);
  });

  it('captures usage via the shared Copilot OTel env mapping', () => {
    const env = buildAgencyEnv(spec, { PATH: '/bin' });
    expect(env.PATH).toBe('/bin');
    expect(env.COPILOT_OTEL_ENABLED).toBe('true');
    expect(env.COPILOT_OTEL_FILE_EXPORTER_PATH).toBe('/tmp/usage.jsonl');
    expect(env.STUDIO_SESSION_ID).toBe('sess-1');
    expect(env.STUDIO_FEATURE_ID).toBe('feat-1');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'feature.id=feat-1,session.id=sess-1,cw.session.kind=dev',
    );
  });
});

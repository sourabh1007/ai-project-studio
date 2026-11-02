import { describe, it, expect } from 'vitest';
import { createAgencyDetector } from './agency-detector.js';

describe('createAgencyDetector', () => {
  it('honors custom executable detection instead of falsely finding a default install', () => {
    let configured = 'custom';
    const detect = createAgencyDetector({
      configuredExecutable: () => configured, resolveExecutable: (command) => `C:\\tools\\${command}.exe`,
      paths: () => ['C:\\default\\agency.exe'], pathExists: (path) => path === 'C:\\tools\\present.exe' || path === 'C:\\default\\agency.exe',
    });
    expect(detect()).toBe(false);
    configured = 'present';
    expect(detect()).toBe(true);
    expect(createAgencyDetector({ configuredExecutable: () => 'direct.exe', paths: () => [], pathExists: (path) => path === 'direct.exe' })()).toBe(true);
  });
  it('reports installed when any candidate path exists', () => {
    const detect = createAgencyDetector({
      paths: () => ['/a', '/b'],
      pathExists: (path) => path === '/b',
    });
    expect(detect()).toBe(true);
  });

  it('reports not installed when no candidate path exists', () => {
    const detect = createAgencyDetector({
      paths: () => ['/a', '/b'],
      pathExists: () => false,
    });
    expect(detect()).toBe(false);
  });

  it('recomputes candidate paths on every probe', () => {
    let installed = false;
    const detect = createAgencyDetector({
      paths: () => (installed ? ['/agency'] : []),
      pathExists: () => true,
    });
    expect(detect()).toBe(false);
    installed = true;
    expect(detect()).toBe(true);
  });
});

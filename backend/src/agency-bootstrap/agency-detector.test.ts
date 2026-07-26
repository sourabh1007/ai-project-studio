import { describe, it, expect } from 'vitest';
import { createAgencyDetector } from './agency-detector.js';

describe('createAgencyDetector', () => {
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

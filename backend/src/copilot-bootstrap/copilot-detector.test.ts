import { describe, it, expect } from 'vitest';
import { createCopilotDetector } from './copilot-detector.js';

describe('createCopilotDetector', () => {
  it('reports installed when the executable resolves to a path', () => {
    const detect = createCopilotDetector({
      executable: 'copilot',
      resolve: (cmd) => (cmd === 'copilot' ? '/usr/local/bin/copilot' : null),
    });
    expect(detect()).toBe(true);
  });

  it('reports not installed when the executable does not resolve', () => {
    const detect = createCopilotDetector({
      executable: 'copilot',
      resolve: () => null,
    });
    expect(detect()).toBe(false);
  });

  it('recomputes on each probe', () => {
    let resolved: string | null = null;
    const detect = createCopilotDetector({
      executable: 'copilot',
      resolve: () => resolved,
    });
    expect(detect()).toBe(false);
    resolved = '/opt/copilot';
    expect(detect()).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { sessionDotClass } from './session-status.js';

describe('sessionDotClass', () => {
  it('maps running to the running dot', () => {
    expect(sessionDotClass('running')).toBe('dot-running');
  });

  it('maps failed to the failed dot', () => {
    expect(sessionDotClass('failed')).toBe('dot-failed');
  });

  it('maps completed to the completed dot', () => {
    expect(sessionDotClass('completed')).toBe('dot-completed');
  });

  it('maps other statuses to the idle dot', () => {
    expect(sessionDotClass('created')).toBe('dot-idle');
    expect(sessionDotClass('cancelled')).toBe('dot-idle');
  });
});

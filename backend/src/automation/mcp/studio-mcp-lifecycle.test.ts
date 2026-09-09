import { describe, it, expect, vi } from 'vitest';
import { watchForParentExit } from './studio-mcp-lifecycle.js';

describe('watchForParentExit', () => {
  it('fires once stdin ends', () => {
    const handlers: Record<string, () => void> = {};
    const stdin = { once: (event: 'end' | 'close', cb: () => void) => { handlers[event] = cb; } };
    const onParentGone = vi.fn();
    watchForParentExit(stdin, onParentGone);
    handlers.end();
    expect(onParentGone).toHaveBeenCalledTimes(1);
  });

  it('fires once stdin closes', () => {
    const handlers: Record<string, () => void> = {};
    const stdin = { once: (event: 'end' | 'close', cb: () => void) => { handlers[event] = cb; } };
    const onParentGone = vi.fn();
    watchForParentExit(stdin, onParentGone);
    handlers.close();
    expect(onParentGone).toHaveBeenCalledTimes(1);
  });

  it('only calls onParentGone once even if both end and close fire', () => {
    const handlers: Record<string, () => void> = {};
    const stdin = { once: (event: 'end' | 'close', cb: () => void) => { handlers[event] = cb; } };
    const onParentGone = vi.fn();
    watchForParentExit(stdin, onParentGone);
    handlers.end();
    handlers.close();
    expect(onParentGone).toHaveBeenCalledTimes(1);
  });
});

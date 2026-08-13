import { describe, it, expect } from 'vitest';
import { computeVirtualWindow } from './virtual-window.js';

describe('computeVirtualWindow', () => {
  it('returns an empty window for zero rows', () => {
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 100,
      rowHeight: 25,
      rowCount: 0,
    });
    expect(w).toEqual({
      startIndex: 0,
      endIndex: 0,
      topPad: 0,
      bottomPad: 0,
      totalHeight: 0,
    });
  });

  it('returns an empty window for a non-positive row height', () => {
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 100,
      rowHeight: 0,
      rowCount: 10,
    });
    expect(w.endIndex).toBe(0);
    expect(w.totalHeight).toBe(0);
  });

  it('renders from the top with no overscan', () => {
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 100,
      rowHeight: 25,
      rowCount: 1000,
    });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(4); // ceil(100/25) = 4
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe((1000 - 4) * 25);
    expect(w.totalHeight).toBe(1000 * 25);
  });

  it('applies overscan on both sides when scrolled into the middle', () => {
    const w = computeVirtualWindow({
      scrollTop: 25 * 40, // firstVisible = 40
      viewportHeight: 100, // visibleCount = 4
      rowHeight: 25,
      rowCount: 1000,
      overscan: 3,
    });
    expect(w.startIndex).toBe(37); // 40 - 3
    expect(w.endIndex).toBe(47); // 40 + 4 + 3
    expect(w.topPad).toBe(37 * 25);
    expect(w.bottomPad).toBe((1000 - 47) * 25);
  });

  it('clamps the start index to zero near the top', () => {
    const w = computeVirtualWindow({
      scrollTop: 25, // firstVisible = 1
      viewportHeight: 100,
      rowHeight: 25,
      rowCount: 1000,
      overscan: 5,
    });
    expect(w.startIndex).toBe(0); // 1 - 5 clamped to 0
    expect(w.topPad).toBe(0);
  });

  it('clamps the end index to rowCount near the bottom', () => {
    const w = computeVirtualWindow({
      scrollTop: 25 * 1000, // beyond content, clamps to totalHeight
      viewportHeight: 100,
      rowHeight: 25,
      rowCount: 1000,
      overscan: 2,
    });
    expect(w.endIndex).toBe(1000);
    expect(w.bottomPad).toBe(0);
  });

  it('renders the entire list when it fits in the viewport', () => {
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 1000,
      rowHeight: 25,
      rowCount: 10,
    });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(10);
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe(0);
  });

  it('treats a negative scrollTop as the top', () => {
    const w = computeVirtualWindow({
      scrollTop: -50,
      viewportHeight: 100,
      rowHeight: 25,
      rowCount: 100,
    });
    expect(w.startIndex).toBe(0);
    expect(w.topPad).toBe(0);
  });

  it('handles a NaN scrollTop by treating it as the top', () => {
    const w = computeVirtualWindow({
      scrollTop: Number.NaN,
      viewportHeight: 100,
      rowHeight: 25,
      rowCount: 100,
    });
    expect(w.startIndex).toBe(0);
  });

  it('floors a fractional rowCount and ignores negative overscan', () => {
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 50,
      rowHeight: 25,
      rowCount: 10.9,
      overscan: -5,
    });
    expect(w.endIndex).toBe(2); // ceil(50/25) = 2, overscan clamped to 0
    expect(w.bottomPad).toBe((10 - 2) * 25);
  });

  it('clamps a negative viewportHeight to zero visible rows', () => {
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: -100,
      rowHeight: 25,
      rowCount: 100,
    });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(0);
  });
});

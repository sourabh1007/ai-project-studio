import { describe, it, expect } from 'vitest';
import {
  COLOR_QUERY_OSC_IDENTS,
  isColorQuery,
  stripTerminalColorReports,
} from './terminal-input.js';

describe('stripTerminalColorReports', () => {
  it('returns plain keystrokes untouched (fast path, no OSC)', () => {
    expect(stripTerminalColorReports('what is the new PR?')).toBe(
      'what is the new PR?',
    );
    expect(stripTerminalColorReports('')).toBe('');
  });

  it('strips a single OSC 4 palette report terminated by BEL', () => {
    const data = '\x1b]4;0;rgb:2e2e/3434/3636\x07';
    expect(stripTerminalColorReports(data)).toBe('');
  });

  it('strips a report terminated by ST (ESC backslash)', () => {
    const data = '\x1b]11;rgb:0000/0000/0000\x1b\\';
    expect(stripTerminalColorReports(data)).toBe('');
  });

  it('strips OSC 10 and 12 fg/cursor reports', () => {
    const fg = '\x1b]10;rgb:eeee/eeee/ecec\x07';
    const cursor = '\x1b]12;rgb:ffff/ffff/ffff\x07';
    expect(stripTerminalColorReports(fg + cursor)).toBe('');
  });

  it('strips many concatenated palette reports, keeping interleaved typed text', () => {
    let reports = '';
    for (let i = 0; i < 16; i += 1) {
      reports += `\x1b]4;${i};rgb:2e2e/3434/3636\x07`;
    }
    expect(stripTerminalColorReports(reports + 'what is')).toBe('what is');
    expect(stripTerminalColorReports('a' + reports + 'b')).toBe('ab');
  });

  it('leaves CSI cursor-position / device-attribute replies intact', () => {
    // A DSR cursor-position report and a DA reply are CSI (ESC [), not OSC.
    const csi = '\x1b[24;80R\x1b[?1;2c';
    expect(stripTerminalColorReports(csi)).toBe(csi);
  });

  it('does not strip an unrelated OSC (e.g. title set) sequence', () => {
    const title = '\x1b]0;my title\x07';
    expect(stripTerminalColorReports(title)).toBe(title);
  });
});

describe('isColorQuery', () => {
  it('treats payloads containing "?" as queries', () => {
    expect(isColorQuery('0;?')).toBe(true);
    expect(isColorQuery('?')).toBe(true);
  });

  it('treats palette-set payloads (no "?") as non-queries', () => {
    expect(isColorQuery('0;rgb:2e2e/3434/3636')).toBe(false);
    expect(isColorQuery('rgb:ffff/ffff/ffff')).toBe(false);
    expect(isColorQuery('#1e1e1e')).toBe(false);
  });
});

describe('COLOR_QUERY_OSC_IDENTS', () => {
  it('covers the palette, fg, bg and cursor color OSC idents', () => {
    expect([...COLOR_QUERY_OSC_IDENTS]).toEqual([4, 10, 11, 12]);
  });
});

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

  // Regression for the reported bug: the CLI queried its 16 ANSI palette colors
  // plus fg/bg/cursor; xterm's replies leaked into the prompt as
  // `4;0;rgb:2e2e/3434/3636...15;r` mixed with the typed "revert last commit".
  it('regression: strips a full palette+fg/bg/cursor report burst, keeping only typed text', () => {
    const palette = [
      'rgb:2e2e/3434/3636',
      'rgb:cccc/0000/0000',
      'rgb:4e4e/9a9a/0606',
      'rgb:c4c4/a0a0/0000',
      'rgb:3434/6565/a4a4',
      'rgb:7575/5050/7b7b',
      'rgb:0606/9898/9a9a',
      'rgb:d3d3/d7d7/cfcf',
      'rgb:5555/5757/5353',
      'rgb:efef/2929/2929',
      'rgb:8a8a/e2e2/3434',
      'rgb:fcfc/e9e9/4f4f',
      'rgb:7272/9f9f/cfcf',
      'rgb:adad/7f7f/a8a8',
      'rgb:3434/e2e2/e2e2',
      'rgb:9e9e/8a8a/8a8a',
    ];
    let burst = '';
    palette.forEach((color, index) => {
      burst += `\x1b]4;${index};${color}\x07`;
    });
    burst += '\x1b]10;rgb:eded/eded/eded\x07'; // fg
    burst += '\x1b]11;rgb:1e1e/1e1e/1e1e\x07'; // bg
    burst += '\x1b]12;rgb:ffff/ffff/ffff\x07'; // cursor

    const typed = 'revert last commit';
    const cleaned = stripTerminalColorReports(burst + typed);

    expect(cleaned).toBe(typed);
    // Hard guards against any report residue reaching the prompt.
    expect(cleaned).not.toContain('rgb');
    expect(cleaned).not.toContain('\x1b]');
    expect(cleaned).not.toMatch(/\d;\d/);
  });

  it('handles mixed BEL- and ST-terminated reports in one burst', () => {
    const data =
      '\x1b]4;0;rgb:2e2e/3434/3636\x07' +
      '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\' +
      'hi';
    expect(stripTerminalColorReports(data)).toBe('hi');
  });

  it('is idempotent — re-stripping already-clean data changes nothing', () => {
    const cleaned = stripTerminalColorReports('\x1b]4;0;rgb:2e2e/3434/3636\x07x');
    expect(stripTerminalColorReports(cleaned)).toBe(cleaned);
    expect(cleaned).toBe('x');
  });

  it('does not touch a real keystroke that merely contains a question mark', () => {
    expect(stripTerminalColorReports('is this the PR?')).toBe('is this the PR?');
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
    expect(isColorQuery('')).toBe(false);
  });

  it('treats a mixed set+query payload as a query (drops the reply to be safe)', () => {
    expect(isColorQuery('0;rgb:2e2e/3434/3636;1;?')).toBe(true);
  });
});

describe('COLOR_QUERY_OSC_IDENTS', () => {
  it('covers the palette, fg, bg and cursor color OSC idents', () => {
    expect([...COLOR_QUERY_OSC_IDENTS]).toEqual([4, 10, 11, 12]);
  });
});

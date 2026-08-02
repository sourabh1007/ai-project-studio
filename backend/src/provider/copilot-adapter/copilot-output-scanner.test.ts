import { describe, it, expect } from 'vitest';
import { createCopilotOutputScanner } from './copilot-output-scanner.js';

const HOME = 'C:\\Users\\me';

function scan(chunks: string[], ctx = { home: HOME, cwd: undefined as string | undefined }) {
  const scanner = createCopilotOutputScanner(ctx);
  return chunks.flatMap((c) => scanner.feed(c));
}

describe('createCopilotOutputScanner', () => {
  it('detects a created absolute path and trims trailing punctuation', () => {
    expect(scan(['● Created  C:\\Users\\me\\Downloads\\new-file.md .\n'])).toEqual([
      { path: 'C:\\Users\\me\\Downloads\\new-file.md', tool: 'create' },
    ]);
  });

  it('matches the verb nearest the path in a tool header line', () => {
    // "Edit" is followed by "Create", not a path, so only "Create <path>" matches.
    expect(scan(['● Edit  Create ~\\Downloads\\new-file.md\n'])).toEqual([
      { path: 'C:\\Users\\me\\Downloads\\new-file.md', tool: 'create' },
    ]);
  });

  it('classifies edit verbs and resolves POSIX absolute paths', () => {
    expect(scan(['Updated /home/u/app.ts\n'])).toEqual([
      { path: '/home/u/app.ts', tool: 'edit' },
    ]);
  });

  it('reads a quoted path that contains spaces', () => {
    expect(scan(['Wrote "C:\\my docs\\a.md"\n'])).toEqual([
      { path: 'C:\\my docs\\a.md', tool: 'create' },
    ]);
  });

  it('resolves a quoted relative path against cwd, or drops it without a cwd', () => {
    expect(
      scan(['Created "todo.md"\n'], { home: HOME, cwd: '/proj/src' }),
    ).toEqual([{ path: '/proj/src/todo.md', tool: 'create' }]);
    expect(scan(['Created "todo.md"\n'])).toEqual([]);
  });

  it('resolves an unquoted relative path (Edit/Create header) against cwd', () => {
    // The CLI renders the touched path relative to the session cwd, e.g.
    // `● Edit  Create Product\Backend\docs\report.md`.
    expect(
      scan(['\u25cf Edit  Create Product\\Backend\\docs\\report.md\n'], {
        home: HOME,
        cwd: 'Q:\\src\\CosmosDB',
      }),
    ).toEqual([{ path: 'Q:\\src\\CosmosDB\\Product\\Backend\\docs\\report.md', tool: 'create' }]);
    expect(
      scan(['Updated src/app/index.ts\n'], { home: HOME, cwd: '/proj' }),
    ).toEqual([{ path: '/proj/src/app/index.ts', tool: 'edit' }]);
  });

  it('drops an unquoted relative path when the session has no cwd', () => {
    expect(scan(['Created src/index.ts\n'])).toEqual([]);
  });

  it('does not treat a slash inside prose or a URL as a relative path', () => {
    expect(scan(['Updated the read/write flag\n'], { home: HOME, cwd: '/p' })).toEqual([]);
    expect(scan(['Created https://example.com/x\n'], { home: HOME, cwd: '/p' })).toEqual([]);
  });

  it('ignores a truncated path token ending in an ellipsis', () => {
    expect(
      scan(['\u25cf Edit  Create Product\\Backend\\docs\\EN20260603_ad1cc74a\u2026\n'], {
        home: HOME,
        cwd: 'Q:\\src\\CosmosDB',
      }),
    ).toEqual([]);
  });

  it('expands ~, ~/ and bare ~ to the home directory', () => {
    expect(scan(['Created "~"\n'])).toEqual([{ path: HOME, tool: 'create' }]);
    expect(scan(['Edited "~/"\n'])).toEqual([{ path: HOME, tool: 'edit' }]);
    expect(scan(['Modified ~/notes/a.md\n'])).toEqual([
      { path: 'C:\\Users\\me\\notes\\a.md', tool: 'edit' },
    ]);
  });

  it('ignores a path not immediately preceded by an action verb', () => {
    expect(scan(['the file at C:\\a\\b.md is ready\n'])).toEqual([]);
  });

  it('drops a token that cleans down to nothing', () => {
    expect(scan(['Created "."\n'])).toEqual([]);
  });

  it('strips TUI box-border glyphs abutting the path (bordered chip)', () => {
    // The CLI draws the path inside a bordered chip; its box glyphs (┃ ● ...)
    // can touch the path with no separating whitespace.
    expect(
      scan(['● Created  C:\\Users\\me\\Downloads\\new-file.md\u2503\u2503\u25cf\n']),
    ).toEqual([{ path: 'C:\\Users\\me\\Downloads\\new-file.md', tool: 'create' }]);
    expect(scan(['Edit  Create ~\\Downloads\\a.md\u2503\n'])).toEqual([
      { path: 'C:\\Users\\me\\Downloads\\a.md', tool: 'create' },
    ]);
  });

  it('strips ANSI escape codes wrapping the path', () => {
    expect(scan(['Created \x1b[36mC:\\a\\b.md\x1b[0m\n'])).toEqual([
      { path: 'C:\\a\\b.md', tool: 'create' },
    ]);
  });

  it('buffers a partial line until a terminator arrives', () => {
    const scanner = createCopilotOutputScanner({ home: HOME, cwd: undefined });
    expect(scanner.feed('Created C:\\a')).toEqual([]);
    expect(scanner.feed('\\b.md\n')).toEqual([
      { path: 'C:\\a\\b.md', tool: 'create' },
    ]);
  });

  it('treats a bare carriage return (TUI redraw) as a line break', () => {
    expect(scan(['spinner\rCreated C:\\a\\b.md\n'])).toEqual([
      { path: 'C:\\a\\b.md', tool: 'create' },
    ]);
  });

  it('keeps working after truncating an overlong unterminated buffer', () => {
    const scanner = createCopilotOutputScanner({ home: HOME, cwd: undefined });
    expect(scanner.feed('x'.repeat(70_000))).toEqual([]);
    expect(scanner.feed('\nCreated C:\\a\\b.md\n')).toEqual([
      { path: 'C:\\a\\b.md', tool: 'create' },
    ]);
  });
});

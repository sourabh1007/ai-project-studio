import { describe, it, expect } from 'vitest';
import { createCopilotModelScanner } from './copilot-model-scanner.js';

function scan(chunks: string[]): string[] {
  const scanner = createCopilotModelScanner();
  return chunks.flatMap((c) => scanner.feed(c));
}

describe('createCopilotModelScanner', () => {
  it('captures the target model from a "changed from … to …" line', () => {
    expect(
      scan(['● Model changed from auto to claude-opus-4.8 (medium)\n']),
    ).toEqual(['claude-opus-4.8']);
  });

  it('captures the target model from a "changed to …" line', () => {
    expect(scan(['Model changed to gpt-5.4\n'])).toEqual(['gpt-5.4']);
  });

  it('is case-insensitive and strips ANSI escapes', () => {
    expect(scan(['\x1b[32mmodel CHANGED to \x1b[0mgpt-5.4-mini\n'])).toEqual([
      'gpt-5.4-mini',
    ]);
  });

  it('ignores unrelated output', () => {
    expect(scan(['just some prose that mentions a model\n'])).toEqual([]);
  });

  it('does not treat the "to" inside the old model name as the target', () => {
    expect(scan(['Model changed from auto to claude\n'])).toEqual(['claude']);
  });

  it('trims trailing punctuation from the captured id', () => {
    expect(scan(['Model changed to gpt-5.4.\n'])).toEqual(['gpt-5.4']);
  });

  it('cuts the token at box-drawing/control glyphs the TUI can abut', () => {
    expect(scan(['Model changed to gpt-5.4\u2502rest\n'])).toEqual(['gpt-5.4']);
  });

  it('skips a line whose model token is empty after cleaning', () => {
    expect(scan(['Model changed to \u2026\n'])).toEqual([]);
  });

  it('reports each change across multiple lines in order', () => {
    expect(
      scan(['Model changed to gpt-5.4\nModel changed from gpt-5.4 to claude\n']),
    ).toEqual(['gpt-5.4', 'claude']);
  });

  it('buffers a partial line until a terminator arrives', () => {
    const scanner = createCopilotModelScanner();
    expect(scanner.feed('Model changed to gpt')).toEqual([]);
    expect(scanner.feed('-5.4\n')).toEqual(['gpt-5.4']);
  });

  it('keeps working after truncating an overlong unterminated buffer', () => {
    const scanner = createCopilotModelScanner();
    expect(scanner.feed('x'.repeat(70_000))).toEqual([]);
    expect(scanner.feed('\nModel changed to gpt-5.4\n')).toEqual(['gpt-5.4']);
  });
});

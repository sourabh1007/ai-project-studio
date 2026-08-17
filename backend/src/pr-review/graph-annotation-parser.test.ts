import { describe, expect, it } from 'vitest';

import { parseGraphAnnotations } from './graph-annotation-parser.js';

const valid = new Set(['src/A.cs', 'src/B.cs', 'src/C.cs']);

function block(json: string): string {
  return '```pr-graph\n' + json + '\n```';
}

describe('parseGraphAnnotations', () => {
  it('returns the trimmed answer and no annotations when there is no block', () => {
    expect(parseGraphAnnotations('  Just prose.  ', valid)).toEqual({
      answer: 'Just prose.',
      annotations: null,
    });
  });

  it('parses highlight, focusFlow and notes and strips the block from prose', () => {
    const raw =
      'Here is the flow.\n\n' +
      block(
        JSON.stringify({
          highlight: ['src/A.cs', 'src/B.cs'],
          focusFlow: ['src/A.cs', 'src/B.cs', 'src/C.cs'],
          notes: [{ path: 'src/A.cs', text: 'entry point' }],
        }),
      );
    expect(parseGraphAnnotations(raw, valid)).toEqual({
      answer: 'Here is the flow.',
      annotations: {
        highlight: ['src/A.cs', 'src/B.cs'],
        focusFlow: ['src/A.cs', 'src/B.cs', 'src/C.cs'],
        notes: [{ path: 'src/A.cs', text: 'entry point' }],
      },
    });
  });

  it('matches the fence tag case-insensitively and with trailing spaces', () => {
    const raw = 'Text\n```PR-Graph  \n' +
      JSON.stringify({ highlight: ['src/A.cs'] }) +
      '\n```';
    expect(parseGraphAnnotations(raw, valid).annotations).toEqual({
      highlight: ['src/A.cs'],
      focusFlow: [],
      notes: [],
    });
  });

  it('drops unknown paths and de-duplicates while preserving order', () => {
    const raw = block(
      JSON.stringify({
        highlight: ['src/B.cs', 'nope.cs', 'src/B.cs', 'src/A.cs'],
      }),
    );
    expect(parseGraphAnnotations(raw, valid).annotations?.highlight).toEqual([
      'src/B.cs',
      'src/A.cs',
    ]);
  });

  it('ignores non-string highlight entries and non-array fields', () => {
    const raw = block(
      JSON.stringify({ highlight: ['src/A.cs', 42, null], focusFlow: 'nope' }),
    );
    const annotations = parseGraphAnnotations(raw, valid).annotations;
    expect(annotations?.highlight).toEqual(['src/A.cs']);
    expect(annotations?.focusFlow).toEqual([]);
  });

  it('caps highlight, focusFlow and notes to their maximum counts', () => {
    const many = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      many.add(`f${i}.cs`);
    }
    const paths = [...many];
    const raw = block(
      JSON.stringify({
        highlight: paths,
        focusFlow: paths,
        notes: paths.map((p) => ({ path: p, text: 'n' })),
      }),
    );
    const annotations = parseGraphAnnotations(raw, many).annotations!;
    expect(annotations.highlight).toHaveLength(40);
    expect(annotations.focusFlow).toHaveLength(40);
    expect(annotations.notes).toHaveLength(40);
  });

  it('keeps only well-formed notes and clamps long note text', () => {
    const long = 'x'.repeat(200);
    const raw = block(
      JSON.stringify({
        notes: [
          'not-an-object',
          { path: 'src/A.cs' },
          { path: 42, text: 'bad path' },
          { path: 'unknown.cs', text: 'dropped' },
          { path: 'src/B.cs', text: '   ' },
          { path: 'src/A.cs', text: long },
          { path: 'src/A.cs', text: 'dup path ignored' },
        ],
      }),
    );
    const notes = parseGraphAnnotations(raw, valid).annotations!.notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].path).toBe('src/A.cs');
    expect(notes[0].text.endsWith('…')).toBe(true);
    expect(notes[0].text.length).toBe(140);
  });

  it('strips the block but yields no annotations when the JSON is malformed', () => {
    const raw = 'Answer.\n' + '```pr-graph\n{ not json ]\n```';
    expect(parseGraphAnnotations(raw, valid)).toEqual({
      answer: 'Answer.',
      annotations: null,
    });
  });

  it('yields no annotations when the JSON is not an object', () => {
    const raw = 'Answer.\n' + block('[1, 2, 3]');
    expect(parseGraphAnnotations(raw, valid)).toEqual({
      answer: 'Answer.',
      annotations: null,
    });
  });

  it('yields no annotations when the JSON is the literal null', () => {
    const raw = 'Answer.\n' + block('null');
    expect(parseGraphAnnotations(raw, valid).annotations).toBeNull();
  });

  it('drops an overlay that validates to entirely empty', () => {
    const raw = 'Answer.\n' + block(
      JSON.stringify({ highlight: ['ghost.cs'], notes: [] }),
    );
    expect(parseGraphAnnotations(raw, valid)).toEqual({
      answer: 'Answer.',
      annotations: null,
    });
  });
});

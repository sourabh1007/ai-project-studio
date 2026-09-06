import { describe, expect, it } from 'vitest';
import { parseFindingDetail } from './finding-detail.js';

describe('parseFindingDetail', () => {
  it('returns nothing for empty or whitespace-only detail', () => {
    expect(parseFindingDetail('')).toEqual([]);
    expect(parseFindingDetail('   \n ')).toEqual([]);
  });

  it('treats label-free text as a single unlabelled section', () => {
    expect(parseFindingDetail('Just a plain sentence.')).toEqual([
      { label: null, body: 'Just a plain sentence.' },
    ]);
  });

  it('keeps leading text before the first label as an unlabelled lead', () => {
    expect(parseFindingDetail('Summary text. Problem: bad thing')).toEqual([
      { label: null, body: 'Summary text.' },
      { label: 'Problem', body: 'bad thing' },
    ]);
  });

  it('drops the empty lead when a label starts the text', () => {
    expect(parseFindingDetail('Problem: bad thing. Fix/verify: do this')).toEqual(
      [
        { label: 'Problem', body: 'bad thing.' },
        { label: 'Fix/verify', body: 'do this' },
      ],
    );
  });

  it('recognises labels after sentence punctuation', () => {
    expect(parseFindingDetail('Problem: a.Where: b;Impact: c')).toEqual([
      { label: 'Problem', body: 'a' },
      { label: 'Where', body: 'b' },
      { label: 'Impact', body: 'c' },
    ]);
  });
});

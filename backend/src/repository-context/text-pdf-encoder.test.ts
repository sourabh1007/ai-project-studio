import { describe, expect, it } from 'vitest';
import { encodeTextPdf, normalizePdfText } from './text-pdf-encoder.js';

function text(pdf: Buffer): string {
  return pdf.toString('latin1');
}

describe('text-pdf-encoder', () => {
  it('creates a valid deterministic PDF with correct xref offsets and escaped content', () => {
    const pdf = encodeTextPdf('repository (evidence) \\ café');
    const source = text(pdf);

    expect(source.startsWith('%PDF-1.4\n%âãÏÓ\n')).toBe(true);
    expect(source).toContain(
      '(repository \\(evidence\\) \\\\ caf\\351) Tj',
    );
    expect(source).toMatch(
      /trailer\n<< \/Size \d+ \/Root 1 0 R >>\nstartxref\n\d+\n%%EOF\n$/,
    );

    const startXref = Number(source.match(/startxref\n(\d+)/)?.[1]);
    expect(source.slice(startXref, startXref + 4)).toBe('xref');
    const entries = [...source.matchAll(/^(\d{10}) 00000 n $/gm)];
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((entry, index) => {
      const offset = Number(entry[1]);
      expect(source.slice(offset)).toMatch(
        new RegExp(`^${index + 1} 0 obj\\n`),
      );
    });
    expect(encodeTextPdf('same')).toEqual(encodeTextPdf('same'));
  });

  it('normalizes controls and unsupported Unicode deterministically', () => {
    expect(normalizePdfText('A\r\nB\t“snowman” ☃\u0001\u00a0é')).toBe(
      'A\nB    "snowman" ?  é',
    );
    expect(text(encodeTextPdf('emoji 😀'))).toContain('(emoji ?) Tj');
  });

  it('wraps and paginates large repository prompts', () => {
    const pdf = text(
      encodeTextPdf(
        `${'word '.repeat(2_000)}\n${'x'.repeat(200)}`,
      ),
    );
    const pageCount = Number(pdf.match(/\/Type \/Pages \/Count (\d+)/)?.[1]);
    expect(pageCount).toBeGreaterThan(1);
    expect(pdf).toContain('/Type /Page ');
    expect(pdf).toContain(`(${'x'.repeat(90)}) Tj`);
  });

  it('encodes empty lines as blank PDF text rows', () => {
    const pdf = text(encodeTextPdf('first\n\nlast'));
    expect(pdf).toContain('() Tj');
    expect(text(encodeTextPdf(''))).toContain('() Tj');
  });
});

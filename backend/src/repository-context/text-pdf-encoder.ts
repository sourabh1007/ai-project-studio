const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const FONT_SIZE = 10;
const LINE_HEIGHT = 12;
const MAX_LINE_CHARS = 90;
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - MARGIN * 2) / LINE_HEIGHT);

const UNICODE_REPLACEMENTS: Readonly<Record<string, string>> = {
  '\u2013': '-',
  '\u2014': '-',
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u2022': '*',
  '\u2026': '...',
  '\u00a0': ' ',
};

/** Converts arbitrary repository text to deterministic PDF-safe Latin-1 text. */
export function normalizePdfText(input: string): string {
  let result = '';
  for (const character of input.normalize('NFC')) {
    const replacement = UNICODE_REPLACEMENTS[character];
    if (replacement !== undefined) {
      result += replacement;
      continue;
    }
    const code = character.codePointAt(0) as number;
    if (character === '\n') {
      result += '\n';
    } else if (character === '\r') {
      continue;
    } else if (character === '\t') {
      result += '    ';
    } else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      result += ' ';
    } else if (code <= 0xff) {
      result += character;
    } else {
      result += '?';
    }
  }
  return result;
}

function wrapLine(line: string): string[] {
  if (line.length === 0) return [''];
  const wrapped: string[] = [];
  let remaining = line;
  while (remaining.length > MAX_LINE_CHARS) {
    const candidate = remaining.slice(0, MAX_LINE_CHARS + 1);
    const space = candidate.lastIndexOf(' ');
    const width = space > 0 ? space : MAX_LINE_CHARS;
    wrapped.push(remaining.slice(0, width));
    remaining = remaining.slice(width + (space > 0 ? 1 : 0));
  }
  wrapped.push(remaining);
  return wrapped;
}

function paginate(input: string): string[][] {
  const lines = normalizePdfText(input)
    .split('\n')
    .flatMap(wrapLine);
  const pages: string[][] = [];
  for (let offset = 0; offset < lines.length; offset += LINES_PER_PAGE) {
    pages.push(lines.slice(offset, offset + LINES_PER_PAGE));
  }
  return pages;
}

function pdfLiteral(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === '(' || character === ')' || character === '\\') {
      result += `\\${character}`;
    } else if (code > 0x7e) {
      result += `\\${code.toString(8).padStart(3, '0')}`;
    } else {
      result += character;
    }
  }
  return result;
}

function pageStream(lines: readonly string[]): Buffer {
  const commands = [
    'BT',
    `/F1 ${FONT_SIZE} Tf`,
    `${LINE_HEIGHT} TL`,
    `${MARGIN} ${PAGE_HEIGHT - MARGIN} Td`,
  ];
  lines.forEach((line, index) => {
    if (index > 0) commands.push('T*');
    commands.push(`(${pdfLiteral(line)}) Tj`);
  });
  commands.push('ET');
  return Buffer.from(`${commands.join('\n')}\n`, 'latin1');
}

/**
 * Encodes text as a small, deterministic PDF 1.4 document without external
 * dependencies. Object offsets are measured from the final byte stream.
 */
export function encodeTextPdf(input: string): Buffer {
  const pages = paginate(input);
  const objects = new Map<number, Buffer>();
  const pageIds = pages.map((_, index) => 4 + index * 2);

  objects.set(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'));
  objects.set(
    2,
    Buffer.from(
      `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds
        .map((id) => `${id} 0 R`)
        .join(' ')}] >>`,
      'ascii',
    ),
  );
  objects.set(
    3,
    Buffer.from(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      'ascii',
    ),
  );

  pages.forEach((lines, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    const stream = pageStream(lines);
    objects.set(
      pageId,
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
        'ascii',
      ),
    );
    objects.set(
      contentId,
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'ascii'),
        stream,
        Buffer.from('endstream', 'ascii'),
      ]),
    );
  });

  const header = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const chunks: Buffer[] = [header];
  const offsets = [0];
  let length = header.length;
  const objectCount = Math.max(...objects.keys());
  for (let id = 1; id <= objectCount; id += 1) {
    offsets[id] = length;
    const object = Buffer.concat([
      Buffer.from(`${id} 0 obj\n`, 'ascii'),
      objects.get(id) as Buffer,
      Buffer.from('\nendobj\n', 'ascii'),
    ]);
    chunks.push(object);
    length += object.length;
  }

  const xrefOffset = length;
  const xref = [
    `xref\n0 ${objectCount + 1}`,
    '0000000000 65535 f ',
    ...offsets
      .slice(1)
      .map((offset) => `${offset.toString().padStart(10, '0')} 00000 n `),
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>`,
    `startxref\n${xrefOffset}`,
    '%%EOF',
    '',
  ].join('\n');
  chunks.push(Buffer.from(xref, 'ascii'));
  return Buffer.concat(chunks);
}

/**
 * Pure text transforms backing the markdown composer's formatting toolbar. Each
 * helper takes the current textarea value and selection and returns the new
 * value plus the selection to restore, so the UI layer stays a thin wrapper and
 * every editing rule is unit-tested without a DOM.
 */

/** A formatting action the toolbar can apply to the current selection. */
export type MarkdownFormat =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'codeblock'
  | 'link'
  | 'bullet'
  | 'quote';

/** The rewritten value and the selection range to restore after applying it. */
export interface MarkdownFormatResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

const INLINE_MARKERS: Record<'bold' | 'italic' | 'strike' | 'code', string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
};

const INLINE_PLACEHOLDERS: Record<'bold' | 'italic' | 'strike' | 'code', string> = {
  bold: 'bold text',
  italic: 'italic text',
  strike: 'strikethrough',
  code: 'code',
};

function clampRange(
  value: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const max = value.length;
  const s = Math.max(0, Math.min(Number.isFinite(start) ? start : 0, max));
  const e = Math.max(s, Math.min(Number.isFinite(end) ? end : s, max));
  return { start: s, end: e };
}

function applyInline(
  value: string,
  start: number,
  end: number,
  format: 'bold' | 'italic' | 'strike' | 'code',
): MarkdownFormatResult {
  const marker = INLINE_MARKERS[format];
  const before = value.slice(0, start);
  const after = value.slice(end);
  const selected = value.slice(start, end);
  const inner = selected.length > 0 ? selected : INLINE_PLACEHOLDERS[format];
  const value2 = `${before}${marker}${inner}${marker}${after}`;
  const innerStart = start + marker.length;
  return {
    value: value2,
    selectionStart: innerStart,
    selectionEnd: innerStart + inner.length,
  };
}

function applyLink(
  value: string,
  start: number,
  end: number,
): MarkdownFormatResult {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const selected = value.slice(start, end);
  const text = selected.length > 0 ? selected : 'text';
  const urlPlaceholder = 'https://';
  const value2 = `${before}[${text}](${urlPlaceholder})${after}`;
  // Select the URL placeholder so the reviewer can type the destination next.
  const urlStart = before.length + 1 + text.length + 2;
  return {
    value: value2,
    selectionStart: urlStart,
    selectionEnd: urlStart + urlPlaceholder.length,
  };
}

function applyLinePrefix(
  value: string,
  start: number,
  end: number,
  prefix: string,
): MarkdownFormatResult {
  // Expand the selection to whole lines so the prefix lands at line starts.
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineEndIndex = value.indexOf('\n', end);
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
  const block = value.slice(lineStart, lineEnd);
  const prefixed = block
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
  const value2 = value.slice(0, lineStart) + prefixed + value.slice(lineEnd);
  return {
    value: value2,
    selectionStart: lineStart,
    selectionEnd: lineStart + prefixed.length,
  };
}

function applyCodeBlock(
  value: string,
  start: number,
  end: number,
): MarkdownFormatResult {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const selected = value.slice(start, end);
  const inner = selected.length > 0 ? selected : 'code';
  // Keep the fences on their own lines, inserting separators only when the
  // surrounding text does not already provide them.
  const lead = before.length === 0 || before.endsWith('\n') ? '' : '\n';
  const tail = after.length === 0 || after.startsWith('\n') ? '' : '\n';
  const block = `${lead}\`\`\`\n${inner}\n\`\`\`${tail}`;
  const value2 = `${before}${block}${after}`;
  const innerStart = before.length + lead.length + 4; // "```\n"
  return {
    value: value2,
    selectionStart: innerStart,
    selectionEnd: innerStart + inner.length,
  };
}

/**
 * Applies a markdown formatting action to a textarea's current selection,
 * returning the rewritten value and the selection to restore. Inline formats
 * wrap the selection (or insert a placeholder when empty); list/quote prefix
 * whole lines; code blocks fence the selection; links insert a `[text](url)`
 * skeleton with the URL pre-selected.
 */
export function applyMarkdownFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  format: MarkdownFormat,
): MarkdownFormatResult {
  const { start, end } = clampRange(value, selectionStart, selectionEnd);
  switch (format) {
    case 'bold':
    case 'italic':
    case 'strike':
    case 'code':
      return applyInline(value, start, end, format);
    case 'link':
      return applyLink(value, start, end);
    case 'bullet':
      return applyLinePrefix(value, start, end, '- ');
    case 'quote':
      return applyLinePrefix(value, start, end, '> ');
    case 'codeblock':
      return applyCodeBlock(value, start, end);
  }
}

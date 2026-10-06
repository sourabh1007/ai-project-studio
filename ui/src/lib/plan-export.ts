/**
 * Builders for downloadable New Task plan documents.
 *
 * The user can export a reviewed plan as Markdown, a styled standalone HTML
 * page, or a Word-openable document. These builders are pure string functions
 * (no DOM, no Blob) so the 100% `src/lib` coverage gate can exercise them; the
 * page wires the returned strings into a Blob download. The HTML/Word builders
 * take the already-rendered, sanitized plan body so sanitization stays in one
 * place (`renderMarkdownComment`).
 */

export type PlanExportFormat = 'md' | 'html' | 'doc';

export interface PlanExportInput {
  /** Human title for the document (e.g. the task/branch name). */
  title: string;
  /** The raw plan markdown. */
  markdown: string;
  /** The plan rendered to sanitized HTML (body fragment, no <html> wrapper). */
  bodyHtml: string;
}

/** Slug-safe base file name derived from the title, with a stable fallback. */
export function planExportFilename(
  title: string,
  format: PlanExportFormat,
): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const base = slug.length > 0 ? slug : 'new-task-plan';
  return `${base}.${format}`;
}

/** The plan as a Markdown document, titled with an H1. */
export function buildPlanMarkdown(input: PlanExportInput): string {
  const title = input.title.trim() || 'New Task plan';
  return `# ${title}\n\n${input.markdown.trim()}\n`;
}

/** Shared document CSS for the HTML and Word exports. */
const DOCUMENT_STYLES = [
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
  'line-height:1.6;color:#1b1f24;max-width:820px;margin:40px auto;padding:0 24px;}',
  'h1{font-size:28px;border-bottom:2px solid #d0d7de;padding-bottom:10px;}',
  'h2{font-size:20px;margin-top:28px;border-bottom:1px solid #d8dee4;padding-bottom:6px;}',
  'h3{font-size:16px;margin-top:22px;}',
  'code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#f1f3f5;',
  'padding:2px 5px;border-radius:4px;font-size:0.92em;}',
  'pre{background:#0d1117;color:#e6edf3;padding:14px 16px;border-radius:8px;overflow:auto;}',
  'pre code{background:transparent;color:inherit;padding:0;}',
  'table{border-collapse:collapse;width:100%;}',
  'th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;}',
  'blockquote{border-left:3px solid #d0d7de;margin:0;padding-left:14px;color:#57606a;}',
  'ul,ol{padding-left:22px;}',
].join('');

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A styled, standalone HTML document embedding the sanitized plan body. */
export function buildPlanHtmlDocument(input: PlanExportInput): string {
  const title = input.title.trim() || 'New Task plan';
  const safeTitle = escapeHtml(title);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${safeTitle}</title>`,
    `<style>${DOCUMENT_STYLES}</style>`,
    '</head>',
    '<body>',
    `<h1>${safeTitle}</h1>`,
    input.bodyHtml,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * A Word-openable document. Microsoft Word opens an HTML file that declares the
 * Office namespaces and the `ProgId` meta, so a `.doc` HTML blob renders as a
 * formatted document without needing a binary .docx writer dependency.
 */
export function buildPlanWordDocument(input: PlanExportInput): string {
  const title = input.title.trim() || 'New Task plan';
  const safeTitle = escapeHtml(title);
  return [
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" ',
    'xmlns:w="urn:schemas-microsoft-com:office:word" ',
    'xmlns="http://www.w3.org/TR/REC-html40">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="ProgId" content="Word.Document" />',
    `<title>${safeTitle}</title>`,
    `<style>${DOCUMENT_STYLES}</style>`,
    '</head>',
    '<body>',
    `<h1>${safeTitle}</h1>`,
    input.bodyHtml,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** The MIME type for each export format. */
export function planExportMime(format: PlanExportFormat): string {
  switch (format) {
    case 'md':
      return 'text/markdown;charset=utf-8';
    case 'html':
      return 'text/html;charset=utf-8';
    case 'doc':
      return 'application/msword';
  }
}

/** Build the document string for a given format from one input. */
export function buildPlanDocument(
  input: PlanExportInput,
  format: PlanExportFormat,
): string {
  switch (format) {
    case 'md':
      return buildPlanMarkdown(input);
    case 'html':
      return buildPlanHtmlDocument(input);
    case 'doc':
      return buildPlanWordDocument(input);
  }
}

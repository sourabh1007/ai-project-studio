/**
 * Pure helpers for exporting a prompt's response from the history pane as a
 * Markdown or HTML file. The DOM-level download (Blob + anchor click) lives in
 * the component; everything here is deterministic and unit-tested so the file
 * name derivation and HTML wrapping stay correct across platforms.
 */

export type ResponseExportFormat = 'md' | 'html';

/**
 * Turns a prompt into a safe, readable file-name stem: lower-cased, non-word
 * runs collapsed to single hyphens, trimmed, and length-capped. Falls back to a
 * stable default when the prompt yields nothing usable (e.g. only punctuation).
 */
export function responseFileNameStem(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'response';
}

/** Full export file name for a prompt's response, e.g. `fix-the-bug.md`. */
export function responseFileName(text: string, format: ResponseExportFormat): string {
  return `${responseFileNameStem(text)}.${format}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wraps already-sanitized response HTML (as produced by `renderMarkdownComment`)
 * in a minimal, self-contained, print-friendly HTML document so a downloaded
 * `.html` file renders cleanly on its own in any browser.
 */
export function buildResponseHtmlDocument(title: string, bodyHtml: string): string {
  const safeTitle = escapeHtml(title.trim().length > 0 ? title.trim() : 'Response');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    max-width: 820px;
    margin: 2.5rem auto;
    padding: 0 1.25rem;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 16px;
    line-height: 1.6;
  }
  pre {
    overflow-x: auto;
    padding: 0.75rem 0.9rem;
    border-radius: 6px;
    background: rgba(127, 127, 127, 0.12);
  }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre code { padding: 0; background: none; }
  :not(pre) > code { padding: 0.1rem 0.3rem; border-radius: 4px; background: rgba(127, 127, 127, 0.14); }
  table { border-collapse: collapse; max-width: 100%; display: block; overflow-x: auto; }
  th, td { border: 1px solid rgba(127, 127, 127, 0.4); padding: 0.35rem 0.55rem; }
  img { max-width: 100%; }
  h1 { font-size: 1.6rem; }
</style>
</head>
<body>
<h1>${safeTitle}</h1>
${bodyHtml}
</body>
</html>
`;
}

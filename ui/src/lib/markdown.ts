import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';
import { marked } from 'marked';

const markdownOptions = {
  async: false,
  breaks: false,
  gfm: true,
} as const;

const sanitizeOptions: Config = {
  ALLOWED_ATTR: [
    'align',
    'aria-label',
    'border',
    'cellpadding',
    'cellspacing',
    'checked',
    'class',
    'colspan',
    'disabled',
    'href',
    'open',
    'rel',
    'rowspan',
    'style',
    'target',
    'title',
    'type',
    'width',
  ],
  ALLOWED_TAGS: [
    'a',
    'blockquote',
    'br',
    'code',
    'del',
    'details',
    'div',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'input',
    'kbd',
    'li',
    'ol',
    'p',
    'pre',
    'samp',
    'span',
    'strong',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
  ],
  ALLOW_DATA_ATTR: false,
};

export function renderMarkdownComment(body: string): string {
  if (body.trim().length === 0) {
    return '';
  }

  const html = marked.parse(body, markdownOptions);
  const sanitized = DOMPurify.sanitize(html, sanitizeOptions);
  const template = document.createElement('template');
  template.innerHTML = sanitized;

  template.content.querySelectorAll('a[href]').forEach((link) => {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  });

  return template.innerHTML;
}

/**
 * Flattens Markdown to a single line of plain text for compact previews (e.g.
 * history row summaries). Reuses the same parser so syntax like `**bold**`,
 * headings, links and lists render as readable text instead of raw markers,
 * then collapses all whitespace so it fits one truncated line.
 */
export function markdownPreviewText(body: string): string {
  if (body.trim().length === 0) {
    return '';
  }

  const html = marked.parse(body, markdownOptions);
  const sanitized = DOMPurify.sanitize(html, sanitizeOptions);
  const template = document.createElement('template');
  template.innerHTML = sanitized;

  return template.content.textContent!.replace(/\s+/gu, ' ').trim();
}

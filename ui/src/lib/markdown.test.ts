import { describe, expect, it } from 'vitest';
import { renderMarkdownComment } from './markdown.js';

function renderFragment(markdown: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdownComment(markdown);
  return host;
}

describe('renderMarkdownComment', () => {
  it('renders common Markdown formatting', () => {
    const html = renderFragment(
      [
        '## Violation',
        '',
        '**bold** and *italic*',
        '',
        '- first',
        '- second',
        '',
        '| Rule | Status |',
        '| --- | --- |',
        '| A | Failed |',
      ].join('\n'),
    );

    expect(html.querySelector('h2')?.textContent).toBe('Violation');
    expect(html.querySelector('strong')?.textContent).toBe('bold');
    expect(html.querySelector('em')?.textContent).toBe('italic');
    expect([...html.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'first',
      'second',
    ]);
    expect(html.querySelector('table th')?.textContent).toBe('Rule');
    expect(html.querySelector('table td')?.textContent).toBe('A');
  });

  it('keeps safe links and hardens them for a new tab', () => {
    const html = renderFragment('[docs](https://example.test/path "Docs")');
    const link = html.querySelector('a');

    expect(link?.getAttribute('href')).toBe('https://example.test/path');
    expect(link?.getAttribute('title')).toBe('Docs');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('strips unsafe link URLs', () => {
    const html = renderFragment('[bad](javascript:alert(1))');
    const link = html.querySelector('a');

    expect(link?.textContent).toBe('bad');
    expect(link?.hasAttribute('href')).toBe(false);
    expect(link?.hasAttribute('target')).toBe(false);
    expect(link?.hasAttribute('rel')).toBe(false);
  });

  it('allows details and summary HTML fragments', () => {
    const html = renderFragment(
      '<details open><summary>More</summary><p style="color: red">Body</p></details>',
    );

    expect(html.querySelector('details')?.hasAttribute('open')).toBe(true);
    expect(html.querySelector('summary')?.textContent).toBe('More');
    expect(html.querySelector('p')?.getAttribute('style')).toContain('color: red');
  });

  it('strips scripts and event handlers', () => {
    const html = renderFragment(
      '<script>alert(1)</script><span onerror="alert(2)">safe</span>',
    );

    expect(html.querySelector('script')).toBeNull();
    expect(html.querySelector('span')?.textContent).toBe('safe');
    expect(html.querySelector('span')?.hasAttribute('onerror')).toBe(false);
  });

  it('returns empty HTML for whitespace-only input', () => {
    expect(renderMarkdownComment(' \n\t ')).toBe('');
  });
});

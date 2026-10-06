import { describe, it, expect } from 'vitest';
import {
  buildPlanDocument,
  buildPlanHtmlDocument,
  buildPlanMarkdown,
  buildPlanWordDocument,
  planExportFilename,
  planExportMime,
  type PlanExportInput,
} from './plan-export.js';

const input: PlanExportInput = {
  title: 'Move SQLMVBuilder to SharedMode',
  markdown: '## Overview\nKeep it minimal.',
  bodyHtml: '<h2>Overview</h2>\n<p>Keep it minimal.</p>',
};

describe('planExportFilename', () => {
  it('slugifies the title and appends the extension', () => {
    expect(planExportFilename('Move SQLMVBuilder to SharedMode!', 'md')).toBe(
      'move-sqlmvbuilder-to-sharedmode.md',
    );
  });

  it('falls back to a stable base when the title has no word chars', () => {
    expect(planExportFilename('***', 'html')).toBe('new-task-plan.html');
    expect(planExportFilename('', 'doc')).toBe('new-task-plan.doc');
  });

  it('trims leading/trailing separators and caps length', () => {
    const name = planExportFilename('  --Hello World--  ', 'md');
    expect(name).toBe('hello-world.md');
    const long = planExportFilename('a'.repeat(100), 'md');
    expect(long).toBe(`${'a'.repeat(60)}.md`);
  });
});

describe('buildPlanMarkdown', () => {
  it('prepends the title as an H1', () => {
    expect(buildPlanMarkdown(input)).toBe(
      '# Move SQLMVBuilder to SharedMode\n\n## Overview\nKeep it minimal.\n',
    );
  });

  it('falls back to a default title', () => {
    expect(
      buildPlanMarkdown({ ...input, title: '   ' }).startsWith(
        '# New Task plan',
      ),
    ).toBe(true);
  });
});

describe('buildPlanHtmlDocument', () => {
  it('wraps the body in a styled standalone document and escapes the title', () => {
    const html = buildPlanHtmlDocument({ ...input, title: 'A < B & C' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>A &lt; B &amp; C</title>');
    expect(html).toContain('<h1>A &lt; B &amp; C</h1>');
    expect(html).toContain(input.bodyHtml);
    expect(html).toContain('font-family');
  });

  it('uses the default title when blank', () => {
    expect(buildPlanHtmlDocument({ ...input, title: '' })).toContain(
      '<title>New Task plan</title>',
    );
  });
});

describe('buildPlanWordDocument', () => {
  it('declares the Office namespaces and Word ProgId', () => {
    const doc = buildPlanWordDocument(input);
    expect(doc).toContain('urn:schemas-microsoft-com:office:word');
    expect(doc).toContain('content="Word.Document"');
    expect(doc).toContain(input.bodyHtml);
  });

  it('uses the default title when blank', () => {
    expect(buildPlanWordDocument({ ...input, title: '  ' })).toContain(
      '<title>New Task plan</title>',
    );
  });
});

describe('planExportMime', () => {
  it('maps each format to its MIME type', () => {
    expect(planExportMime('md')).toBe('text/markdown;charset=utf-8');
    expect(planExportMime('html')).toBe('text/html;charset=utf-8');
    expect(planExportMime('doc')).toBe('application/msword');
  });
});

describe('buildPlanDocument', () => {
  it('dispatches to the right builder per format', () => {
    expect(buildPlanDocument(input, 'md')).toBe(buildPlanMarkdown(input));
    expect(buildPlanDocument(input, 'html')).toBe(
      buildPlanHtmlDocument(input),
    );
    expect(buildPlanDocument(input, 'doc')).toBe(
      buildPlanWordDocument(input),
    );
  });
});

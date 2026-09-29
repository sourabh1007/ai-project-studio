import { useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdownComment } from '../lib/markdown.js';
import { applyMarkdownFormat, type MarkdownFormat } from '../lib/markdown-format.js';

interface ToolbarButton {
  format: MarkdownFormat;
  label: string;
  title: string;
}

const TOOLBAR: ToolbarButton[] = [
  { format: 'bold', label: 'B', title: 'Bold (Ctrl/Cmd+B)' },
  { format: 'italic', label: 'I', title: 'Italic (Ctrl/Cmd+I)' },
  { format: 'strike', label: 'S', title: 'Strikethrough' },
  { format: 'code', label: '<>', title: 'Inline code' },
  { format: 'codeblock', label: '{}', title: 'Code block' },
  { format: 'link', label: 'Link', title: 'Link (Ctrl/Cmd+K)' },
  { format: 'bullet', label: 'List', title: 'Bulleted list' },
  { format: 'quote', label: 'Quote', title: 'Blockquote' },
];

/**
 * A markdown-aware comment editor: a formatting toolbar (bold/italic/code/list/
 * quote/link), a Write/Preview toggle rendering the same sanitized markdown the
 * threads use, and keyboard shortcuts (Ctrl/Cmd+B/I/K and Ctrl/Cmd+Enter to
 * submit). The value is controlled by the caller so it drops into both the
 * inline diff composer and the finding-comment dialog without owning state.
 */
export function MarkdownComposer({
  value,
  onChange,
  placeholder,
  rows = 4,
  disabled = false,
  autoFocus = false,
  ariaLabel,
  id,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  ariaLabel?: string;
  id?: string;
  onSubmit?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [pending, setPending] = useState<{ start: number; end: number } | null>(
    null,
  );
  const html = useMemo(() => renderMarkdownComment(value), [value]);

  // Restore the selection after a toolbar edit re-renders the controlled value,
  // so the cursor lands inside the freshly inserted markdown.
  useEffect(() => {
    if (pending && ref.current) {
      ref.current.focus();
      ref.current.setSelectionRange(pending.start, pending.end);
      setPending(null);
    }
  }, [pending]);

  const apply = (format: MarkdownFormat) => {
    if (disabled) {
      return;
    }
    const el = ref.current;
    const start = el ? el.selectionStart : value.length;
    const end = el ? el.selectionEnd : value.length;
    const result = applyMarkdownFormat(value, start, end, format);
    onChange(result.value);
    setPending({ start: result.selectionStart, end: result.selectionEnd });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'enter' && onSubmit) {
      event.preventDefault();
      onSubmit();
    } else if (key === 'b') {
      event.preventDefault();
      apply('bold');
    } else if (key === 'i') {
      event.preventDefault();
      apply('italic');
    } else if (key === 'k') {
      event.preventDefault();
      apply('link');
    }
  };

  return (
    <div className="md-composer">
      <div className="md-composer-bar">
        <div className="md-composer-tabs" role="tablist" aria-label="Editor mode">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'write'}
            className={`md-composer-tab${tab === 'write' ? ' is-active' : ''}`}
            onClick={() => setTab('write')}
          >
            Write
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'preview'}
            className={`md-composer-tab${tab === 'preview' ? ' is-active' : ''}`}
            onClick={() => setTab('preview')}
          >
            Preview
          </button>
        </div>
        {tab === 'write' && (
          <div className="md-composer-tools" role="toolbar" aria-label="Formatting">
            {TOOLBAR.map((button) => (
              <button
                key={button.format}
                type="button"
                className="md-composer-tool"
                title={button.title}
                aria-label={button.title}
                disabled={disabled}
                // Keep the textarea selection when a tool is clicked.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => apply(button.format)}
              >
                {button.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {tab === 'write' ? (
        <textarea
          ref={ref}
          id={id}
          className="md-composer-input textarea"
          value={value}
          placeholder={placeholder}
          rows={rows}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : value.trim().length === 0 ? (
        <p className="md-composer-empty">Nothing to preview.</p>
      ) : (
        <div
          className="md-composer-preview pr-comment-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      <p className="md-composer-hint">
        Markdown supported · Ctrl/Cmd+Enter to submit
      </p>
    </div>
  );
}

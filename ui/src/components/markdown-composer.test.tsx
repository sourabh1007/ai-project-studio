import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownComposer } from './markdown-composer.js';

function Harness({
  onSubmit,
  initial = '',
  disabled = false,
}: {
  onSubmit?: () => void;
  initial?: string;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <MarkdownComposer
      value={value}
      onChange={setValue}
      ariaLabel="Comment body"
      onSubmit={onSubmit}
      disabled={disabled}
    />
  );
}

describe('MarkdownComposer', () => {
  it('wraps the selection when a toolbar action is used', () => {
    render(<Harness initial="quick" />);
    const textarea = screen.getByLabelText('Comment body') as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 5);
    fireEvent.click(screen.getByRole('button', { name: /Bold/ }));
    expect(textarea).toHaveValue('**quick**');
  });

  it('renders a markdown preview and an empty-state hint', () => {
    render(<Harness initial="**bold**" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    fireEvent.click(screen.getByRole('tab', { name: 'Write' }));
    fireEvent.change(screen.getByLabelText('Comment body'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByText('Nothing to preview.')).toBeInTheDocument();
  });

  it('submits on Ctrl/Cmd+Enter and formats on Ctrl/Cmd+B/I/K', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} initial="x" />);
    const textarea = screen.getByLabelText('Comment body') as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 1);
    fireEvent.keyDown(textarea, { key: 'b', ctrlKey: true });
    expect(textarea).toHaveValue('**x**');
    textarea.setSelectionRange(2, 3);
    fireEvent.keyDown(textarea, { key: 'i', metaKey: true });
    expect(textarea).toHaveValue('***x***');
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
    // A modifierless key is ignored by the shortcut handler.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('does not format while disabled', () => {
    render(<Harness initial="quick" disabled />);
    const textarea = screen.getByLabelText('Comment body') as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
    expect(screen.getByRole('button', { name: /Bold/ })).toBeDisabled();
  });
});

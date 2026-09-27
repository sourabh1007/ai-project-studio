import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpCommandOptions, type McpCommandOptionsProps } from './mcp-command-options.js';

const options: McpCommandOptionsProps['options'] = [
  { flag: '--verbose', description: 'Show detailed output.' },
  { flag: '--organization', description: 'Organization to connect to.', valueHint: 'Organization name' },
  { flag: '--mode', description: 'Choose access mode.', choices: ['read-only', 'read write'] },
];

function mount(props: Partial<McpCommandOptionsProps> = {}) {
  const onChoose = vi.fn();
  const result = render(<McpCommandOptions options={options} examples={[]} onChoose={onChoose} {...props} />);
  fireEvent.click(screen.getByText('Options', { selector: 'summary' }));
  return { ...result, onChoose };
}

afterEach(cleanup);

describe('McpCommandOptions', () => {
  it('is collapsed initially and does not choose anything merely by opening', () => {
    const onChoose = vi.fn();
    render(<McpCommandOptions options={options} examples={[]} onChoose={onChoose} />);
    expect(screen.getByText('Options', { selector: 'summary' }).closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Options', { selector: 'summary' }));
    expect(screen.getByRole('button', { name: 'Add --verbose' })).toBeInTheDocument();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('adds a flag without a value and never submits its parent form', () => {
    const onChoose = vi.fn();
    const onSubmit = vi.fn((event) => event.preventDefault());
    render(<form onSubmit={onSubmit}><McpCommandOptions options={options} examples={[]} onChoose={onChoose} /></form>);
    fireEvent.click(screen.getByText('Options', { selector: 'summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add --verbose' }));
    expect(onChoose.mock.calls).toEqual([['--verbose']]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('searches flags, descriptions, and choices without choosing a suggestion', () => {
    const { onChoose } = mount();
    const search = screen.getByRole('searchbox', { name: 'Search options' });
    fireEvent.change(search, { target: { value: ' ORGANIZATION ' } });
    expect(screen.getByRole('button', { name: 'Add --organization' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add --verbose' })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'detailed' } });
    expect(screen.getByRole('button', { name: 'Add --verbose' })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'read-only' } });
    expect(screen.getByRole('button', { name: 'Add --mode' })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'no match' } });
    expect(screen.getByRole('status')).toHaveTextContent('No matching options.');
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('requires a nonblank value without guessing a default', () => {
    const { onChoose } = mount();
    const add = screen.getByRole('button', { name: 'Add --organization' });
    const input = screen.getByRole('textbox', { name: 'Value for --organization' });
    expect(input).toHaveAttribute('placeholder', 'Organization name');
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: 'myorg' } });
    fireEvent.click(add);
    expect(onChoose.mock.calls).toEqual([['--organization myorg']]);
  });

  it.each([
    ['my organization', '"my organization"'],
    ['C:\\Users\\Some Name\\', '"C:\\\\Users\\\\Some Name\\\\"'],
    ['a"b', '"a\\"b"'],
    ["O'Brien", '"O\'Brien"'],
    ['$HOME; echo ignored', '"$HOME; echo ignored"'],
    [' leading and trailing ', '" leading and trailing "'],
  ])('quotes the value %s as a single native argument', (value, quoted) => {
    const { onChoose } = mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Value for --organization' }), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Add --organization' }));
    expect(onChoose.mock.calls).toEqual([[`--organization ${quoted}`]]);
    expect(JSON.parse(quoted)).toBe(value);
  });

  it('offers declared choices without silently selecting the first', () => {
    const { onChoose } = mount();
    const select = screen.getByRole('combobox', { name: 'Value for --mode' });
    const add = screen.getByRole('button', { name: 'Add --mode' });
    expect(select).toHaveValue('');
    expect(add).toBeDisabled();
    fireEvent.change(select, { target: { value: 'read write' } });
    fireEvent.click(add);
    expect(onChoose.mock.calls).toEqual([['--mode "read write"']]);
  });

  it('requires a value even with an empty value hint or choices array', () => {
    mount({ options: [
      { flag: '--hint', description: '', valueHint: '' },
      { flag: '--choices', description: '', choices: [] },
    ] });
    expect(screen.getByRole('textbox', { name: 'Value for --hint' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Value for --choices' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add --hint' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add --choices' })).toBeDisabled();
  });

  it('adds a supplied argument example only on click and removes duplicates', () => {
    const { onChoose } = mount({ examples: [' --organization myorg ', '--organization myorg'] });
    const example = screen.getByRole('button', { name: 'Use example --organization myorg' });
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.click(example);
    expect(onChoose.mock.calls).toEqual([['--organization myorg']]);
  });

  it('rejects malformed flags, command prefixes, control characters, and oversized examples', () => {
    const { onChoose } = mount({
      options: [
        ...options,
        { flag: '--verbose', description: 'Duplicate' },
        ...['--bad\nflag', '--bad\0flag', '--foo bar', '--FOO', '-x', 'agency', '--x;echo', '--x=value']
          .map((flag) => ({ flag, description: 'Invalid flag' })),
      ],
      examples: ['agency mcp ado', 'mcp ado', 'ado --org org', '--verbose\n--other', '--verbose\0', '--verbose\n',
        '--org ' + 'x'.repeat(4096)],
    });
    expect(screen.getAllByRole('button', { name: /^Add --/ })).toHaveLength(3);
    expect(screen.queryByText('Invalid flag')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Use example/ })).not.toBeInTheDocument();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('prevents control characters or an oversized generated fragment from being added', () => {
    const { onChoose } = mount();
    const input = screen.getByRole('textbox', { name: 'Value for --organization' });
    const add = screen.getByRole('button', { name: 'Add --organization' });
    for (const value of ['org\0name', 'org\u2028name', 'x'.repeat(4096)]) {
      fireEvent.change(input, { target: { value } });
      expect(add).toBeDisabled();
      fireEvent.click(add);
    }
    expect(onChoose).not.toHaveBeenCalled();
    expect(screen.getByText(/Use a single-line value/)).toBeInTheDocument();
  });

  it('filters invalid choices and rejects a previously selected choice after options refresh', () => {
    const onChoose = vi.fn();
    const { rerender } = mount({
      options: [{ flag: '--mode', description: '', choices: ['good', 'good', 'bad\nvalue'] }],
      onChoose,
    });
    expect(screen.getAllByRole('option', { name: 'good' })).toHaveLength(1);
    expect(screen.queryByRole('option', { name: /bad/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'good' } });
    rerender(<McpCommandOptions options={[{ flag: '--mode', description: '', choices: ['new'] }]}
      examples={[]} onChoose={onChoose} />);
    expect(screen.getByRole('button', { name: 'Add --mode' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add --mode' }));
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('disables all interactive controls and callbacks while its parent is busy', () => {
    const { onChoose } = mount({ disabled: true, examples: ['--verbose'] });
    expect(screen.getByRole('searchbox')).toBeDisabled();
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('shows a concise empty state without inventing options', () => {
    mount({ options: [], examples: [] });
    expect(screen.getByText('No option suggestions available. Enter arguments above.')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

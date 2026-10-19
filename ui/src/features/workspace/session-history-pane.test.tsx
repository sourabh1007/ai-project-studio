import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionPrompt } from '../../lib/types.js';
import { SessionHistoryPane } from './session-history-pane.js';

const api = vi.hoisted(() => ({ listSessionPrompts: vi.fn() }));
vi.mock('../../app/api-context.js', () => ({ useApi: () => api }));

function prompt(index: number, text: string, response: string | null = null): SessionPrompt {
  return {
    index, text, response, at: '2026-10-16T10:00:00Z',
    answeredAt: response ? '2026-10-16T10:00:01Z' : null,
    status: response ? 'answered' : 'unanswered', durationMs: response ? 1000 : null,
  };
}

const prompts = [
  prompt(0, 'Fix the checkout bug', 'The worktree is now restored.'),
  prompt(1, 'Improve the header', 'Added **keyboard navigation** to the toolbar.'),
  prompt(2, 'Document release steps'),
];

beforeEach(() => {
  localStorage.removeItem('cw-history-pane-open');
  api.listSessionPrompts.mockReset().mockResolvedValue(prompts);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('prompt history search', () => {
  it('updates an open response dialog when generation completes, without duplicate loading text', async () => {
    vi.useFakeTimers();
    const generating = { ...prompt(0, 'Live request', 'Checking the files…'), status: 'answering' as const, answeredAt: null, durationMs: null, pending: true };
    api.listSessionPrompts.mockResolvedValue([generating]);
    render(<SessionHistoryPane sessionId="s1" />);
    await act(async () => {});
    fireEvent.click(screen.getByTitle('Open full prompt and response'));
    await act(async () => {});
    const dialog = screen.getByRole('dialog', { name: 'Prompt & response' });
    expect(within(dialog).getAllByText('Generating response…')).toHaveLength(1);
    expect(within(dialog).getByRole('img', { name: 'Generating response…' })).toBeInTheDocument();
    api.listSessionPrompts.mockResolvedValue([{ ...prompt(0, 'Live request', 'The response is complete.'), pending: true }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(within(dialog).getByText('Answered')).toBeInTheDocument();
    expect(within(dialog).getByText('The response is complete.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Generating response…')).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent('Still being saved');
  });

  it('keeps an open live turn synchronized when its persisted index changes', async () => {
    vi.useFakeTimers();
    api.listSessionPrompts.mockResolvedValue([{ ...prompt(0, 'Live request'), status: 'answering', pending: true }]);
    render(<SessionHistoryPane sessionId="s1" />);
    await act(async () => {});
    fireEvent.click(screen.getByTitle('Open full prompt and response'));
    await act(async () => {});
    api.listSessionPrompts.mockResolvedValue([prompt(3, 'Live request', 'Saved answer')]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    const dialog = screen.getByRole('dialog', { name: 'Prompt & response' });
    expect(dialog).toHaveTextContent('Answered');
    expect(dialog).toHaveTextContent('Saved answer');
    expect(dialog).toHaveTextContent('Turn4');
  });

  it('closes the previous session’s response dialog when switching sessions', async () => {
    const view = render(<SessionHistoryPane sessionId="s1" />);
    await screen.findByText('Fix the checkout bug');
    fireEvent.click(screen.getAllByTitle('Open full prompt and response')[0]);
    expect(screen.getByRole('dialog', { name: 'Prompt & response' })).toBeInTheDocument();
    await act(async () => view.rerender(<SessionHistoryPane sessionId="s2" />));
    expect(screen.queryByRole('dialog', { name: 'Prompt & response' })).not.toBeInTheDocument();
  });

  it('announces successful response copying and explicitly reports an unconfirmed clipboard write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<SessionHistoryPane sessionId="s1" />);
    await screen.findByText('Fix the checkout bug');
    fireEvent.click(screen.getAllByTitle('Open full prompt and response')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Copy response as Markdown' }));
    expect(await screen.findByRole('button', { name: 'Response copied' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Response copied to clipboard');
    expect(writeText).toHaveBeenCalledWith('The worktree is now restored.');
    writeText.mockRejectedValue(new Error('Clipboard failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Response copied' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Clipboard write could not be confirmed');
  });

  it('persists bounded history sizing and hides the handle while collapsed', async () => {
    render(<SessionHistoryPane sessionId="s1" />);
    await screen.findByText('Fix the checkout bug');
    const separator = screen.getByRole('separator', { name: 'Resize prompt history' });
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(localStorage.getItem('cw-history-pane-width')).toBe('310');
    expect(screen.getByRole('complementary')).toHaveStyle({ '--history-width': '310px' });
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator).toHaveAttribute('aria-valuenow', '560');
    fireEvent.doubleClick(separator);
    expect(separator).toHaveAttribute('aria-valuenow', '300');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse prompt history' }));
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('makes recorded turn timestamps and duration available in collapsed detail sections', async () => {
    render(<SessionHistoryPane sessionId="s1" />);
    await screen.findByText('Fix the checkout bug');
    fireEvent.click(screen.getAllByTitle('Open full prompt and response')[0]);
    const details = screen.getByText('Recorded turn details').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('Turn1');
    expect(details).toHaveTextContent('Duration1s');
    expect(details).toHaveTextContent('Answer recorded');
  });

  it('filters full prompts and responses case-insensitively without requesting history again, and clears the filter', async () => {
    render(<SessionHistoryPane sessionId="s1" />);
    await screen.findByText('Fix the checkout bug');
    const search = screen.getByRole('searchbox', { name: 'Search prompt history' });
    fireEvent.change(search, { target: { value: '  CHECKOUT  ' } });
    expect(screen.getByText('Fix the checkout bug')).toBeInTheDocument();
    expect(screen.queryByText('Improve the header')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 3 prompts')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'keyboard navigation' } });
    expect(screen.getByText('Improve the header')).toBeInTheDocument();
    expect(screen.queryByText('Fix the checkout bug')).not.toBeInTheDocument();
    expect(api.listSessionPrompts).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Clear prompt history search' }));
    expect(search).toHaveValue('');
    expect(screen.getAllByTitle('Open full prompt and response')).toHaveLength(3);
    expect(screen.getByText('3 prompts')).toBeInTheDocument();
  });

  it('distinguishes no matches from empty history and treats whitespace as an empty query', async () => {
    render(<SessionHistoryPane sessionId="s1" />);
    await screen.findByText('Fix the checkout bug');
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'no-such-prompt' } });
    expect(screen.getByText('No prompts or responses match your search.')).toBeInTheDocument();
    expect(screen.getByText('0 of 3 prompts')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: '   ' } });
    expect(screen.getAllByTitle('Open full prompt and response')).toHaveLength(3);
  });

  it('shares the filter with full-screen history and still opens the matching prompt detail', async () => {
    render(<SessionHistoryPane sessionId="s1" />);
    await screen.findByText('Fix the checkout bug');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'worktree' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open prompt history full screen' })));
    const dialog = screen.getByRole('dialog', { name: 'Prompt history' });
    expect(within(dialog).getByRole('searchbox')).toHaveValue('worktree');
    expect(within(dialog).getAllByTitle('Open full prompt and response')).toHaveLength(1);
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'release' } });
    expect(within(dialog).getByText('Document release steps')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByTitle('Open full prompt and response'));
    expect(screen.getByRole('dialog', { name: 'Prompt & response' })).toHaveTextContent('Document release steps');
  });

  it('keeps the search active as live history updates arrive', async () => {
    vi.useFakeTimers();
    render(<SessionHistoryPane sessionId="s1" />);
    await act(async () => {});
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'checkout' } });
    api.listSessionPrompts.mockResolvedValue([...prompts, prompt(3, 'Test checkout recovery')]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole('searchbox')).toHaveValue('checkout');
    expect(screen.getAllByTitle('Open full prompt and response')).toHaveLength(2);
    expect(screen.getByText('2 of 4 prompts')).toBeInTheDocument();
  });

  it('resets the search when changing sessions', async () => {
    const view = render(<SessionHistoryPane sessionId="s1" />);
    await screen.findByText('Fix the checkout bug');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'checkout' } });
    api.listSessionPrompts.mockResolvedValue([prompt(0, 'A different session')]);
    view.rerender(<SessionHistoryPane sessionId="s2" />);
    expect(await screen.findByText('A different session')).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByText('1 prompt')).toBeInTheDocument();
  });

  it('preserves loading, empty, and error states instead of reporting false search results', async () => {
    let resolve!: (value: SessionPrompt[]) => void;
    api.listSessionPrompts.mockReturnValueOnce(new Promise<SessionPrompt[]>((done) => { resolve = done; }));
    const view = render(<SessionHistoryPane sessionId="s1" />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'checkout' } });
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    await act(async () => resolve([]));
    expect(screen.getByText('No prompts recorded yet.')).toBeInTheDocument();
    api.listSessionPrompts.mockRejectedValueOnce(new Error('Offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh prompt history' }));
    expect(await screen.findByText('Couldn’t load prompt history.')).toBeInTheDocument();
    view.rerender(<SessionHistoryPane sessionId={null} />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });
});

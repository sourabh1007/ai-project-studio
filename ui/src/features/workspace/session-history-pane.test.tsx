import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('hides the fullscreen history panel completely and cancels polling without overwriting its saved normal state', async () => {
    localStorage.setItem('cw-history-pane-open', 'true');
    const changed = vi.fn();
    const view = render(<SessionHistoryPane sessionId="s1" open={false} onOpenChange={changed} hideCollapsed />);
    expect(view.container).toBeEmptyDOMElement();
    expect(api.listSessionPrompts).not.toHaveBeenCalled();
    view.rerender(<SessionHistoryPane sessionId="s1" open onOpenChange={changed} hideCollapsed />);
    await screen.findByText('Fix the checkout bug');
    const signal = api.listSessionPrompts.mock.calls[0][1].signal as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Collapse prompt history' }));
    expect(changed).toHaveBeenCalledWith(false);
    expect(localStorage.getItem('cw-history-pane-open')).toBe('true');
    view.rerender(<SessionHistoryPane sessionId="s1" open={false} onOpenChange={changed} hideCollapsed />);
    expect(view.container).toBeEmptyDOMElement();
    expect(signal.aborted).toBe(true);
    view.rerender(<SessionHistoryPane sessionId="s1" />);
    expect(screen.getByRole('button', { name: 'Collapse prompt history' })).toBeVisible();
  });

  it('expands only the response with copy/download controls and restores the prompt detail', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<SessionHistoryPane sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Fix the checkout bug/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open response full screen' }));
    const dialog = screen.getByRole('dialog', { name: 'Response' });
    expect(dialog).toHaveClass('modal-full', 'history-response-fullscreen');
    expect(within(dialog).getByText('The worktree is now restored.')).toBeInTheDocument();
    expect(within(dialog).queryByText('You asked')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Recorded turn details')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Download response as Markdown' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Download response as HTML' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy response as Markdown' }));
    expect(await within(dialog).findByRole('button', { name: 'Response copied' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('The worktree is now restored.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exit response full screen' }));
    const restored = screen.getByRole('dialog', { name: 'Prompt & response' });
    expect(restored).toHaveClass('modal-lg');
    expect(restored).not.toHaveClass('history-response-fullscreen');
    expect(within(restored).getByText('You asked')).toBeInTheDocument();
    expect(within(restored).getByText('The worktree is now restored.')).toBeInTheDocument();
  });

  it('keeps the full-screen response synchronized as a live turn completes', async () => {
    vi.useFakeTimers();
    api.listSessionPrompts.mockResolvedValue([
      { ...prompt(0, 'Live request', 'Checking files'), status: 'answering', pending: true },
    ]);
    render(<SessionHistoryPane sessionId="s1" />);
    await act(async () => {});
    fireEvent.click(screen.getByTitle('Open full prompt and response'));
    fireEvent.click(screen.getByRole('button', { name: 'Open response full screen' }));
    api.listSessionPrompts.mockResolvedValue([prompt(0, 'Live request', 'Completed response')]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    const dialog = screen.getByRole('dialog', { name: 'Response' });
    expect(within(dialog).getByText('Completed response')).toBeInTheDocument();
    expect(within(dialog).queryByText('Checking files')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exit response full screen' }));
    expect(screen.getByRole('dialog', { name: 'Prompt & response' })).toHaveTextContent('Answered');
  });

  it('dismisses the full-screen response with Escape and returns focus to history', async () => {
    render(<SessionHistoryPane sessionId="s1" />);
    const row = await screen.findByRole('button', { name: /Fix the checkout bug/ });
    row.focus();
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: 'Open response full screen' }));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Response' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(row).toHaveFocus();
  });

  it('does not offer response expansion before a response exists', async () => {
    render(<SessionHistoryPane sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Document release steps/ }));
    expect(screen.getByRole('dialog', { name: 'Prompt & response' })).toHaveTextContent('No response was recorded.');
    expect(screen.queryByRole('button', { name: 'Open response full screen' })).not.toBeInTheDocument();
  });

  it('shows newest prompts first in the panel and full-screen view without mutating API results', async () => {
    const result = Object.freeze([...prompts]);
    api.listSessionPrompts.mockResolvedValue(result);
    render(<SessionHistoryPane sessionId="s1" />);
    await screen.findByText('Fix the checkout bug');
    const rows = screen.getAllByTitle('Open full prompt and response');
    expect(rows[0]).toHaveTextContent('Document release steps');
    expect(rows[1]).toHaveTextContent('Improve the header');
    expect(rows[2]).toHaveTextContent('Fix the checkout bug');
    fireEvent.click(screen.getByRole('button', { name: 'Open prompt history full screen' }));
    const dialog = screen.getByRole('dialog', { name: 'Prompt history' });
    const expandedRows = within(dialog).getAllByTitle('Open full prompt and response');
    expect(expandedRows[0]).toHaveTextContent('Document release steps');
    expect(expandedRows[2]).toHaveTextContent('Fix the checkout bug');
    fireEvent.click(expandedRows[0]);
    expect(screen.getByRole('dialog', { name: 'Prompt & response' })).toHaveTextContent('Turn3');
    expect(result.map((entry) => entry.index)).toEqual([0, 1, 2]);
  });

  it('preserves newest-first order when filtering and clearing the search', async () => {
    render(<SessionHistoryPane sessionId="s1" />);
    await screen.findByText('Fix the checkout bug');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'the' } });
    const rows = screen.getAllByTitle('Open full prompt and response');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Improve the header');
    expect(rows[1]).toHaveTextContent('Fix the checkout bug');
    fireEvent.click(screen.getByRole('button', { name: 'Clear prompt history search' }));
    expect(screen.getAllByTitle('Open full prompt and response')[0]).toHaveTextContent('Document release steps');
  });

  it('puts a newly arriving live prompt above the recorded history', async () => {
    vi.useFakeTimers();
    render(<SessionHistoryPane sessionId="s1" />);
    await act(async () => {});
    api.listSessionPrompts.mockResolvedValue([
      ...prompts,
      { ...prompt(3, 'Newest live request'), status: 'answering', pending: true },
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    const rows = screen.getAllByTitle('Open full prompt and response');
    expect(rows[0]).toHaveTextContent('Newest live request');
    expect(rows[1]).toHaveTextContent('Document release steps');
    expect(rows[3]).toHaveTextContent('Fix the checkout bug');
  });

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

  it('keeps queued prompts separate and updates the selected reply when other requests finish first', async () => {
    vi.useFakeTimers();
    const first = { ...prompt(0, 'First request', 'A is working'), status: 'answering' as const, pending: true };
    const second = { ...prompt(1, 'Second request'), queued: true, pending: true };
    const third = { ...prompt(2, 'Third request'), queued: true, pending: true };
    api.listSessionPrompts.mockResolvedValue([first, second, third]);
    render(<SessionHistoryPane sessionId="s1" />);
    await act(async () => {});
    expect(screen.getAllByRole('img', { name: 'Queued - waiting for response' })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Second request/ }));
    let dialog = screen.getByRole('dialog', { name: 'Prompt & response' });
    expect(dialog).toHaveTextContent('This prompt is queued.');
    expect(dialog).not.toHaveTextContent('A is working');
    api.listSessionPrompts.mockResolvedValue([
      prompt(0, 'First request', 'Only A answer'),
      { ...prompt(4, 'Second request', 'Only B answer'), at: '2026-10-16T10:00:00.000Z' },
      third,
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    dialog = screen.getByRole('dialog', { name: 'Prompt & response' });
    expect(dialog).toHaveTextContent('Only B answer');
    expect(dialog).not.toHaveTextContent('Only A answer');
    expect(dialog).not.toHaveTextContent('This prompt is queued.');
    expect(dialog).toHaveTextContent('Turn5');
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
    fireEvent.click(screen.getByRole('button', { name: /Fix the checkout bug/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /Fix the checkout bug/ }));
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
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t load prompt history\. Offline/);
    view.rerender(<SessionHistoryPane sessionId={null} />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });
});

describe('prompt history freshness and recovery', () => {
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const pending = () => {
    let resolve!: (value: SessionPrompt[]) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<SessionPrompt[]>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  };
  const rowTexts = () => screen.getAllByTitle('Open full prompt and response')
    .map((row) => row.querySelector('.history-pane-prompt')?.textContent);

  it('surfaces a turn the store persists late at the top while polling, never dropping earlier ones', async () => {
    vi.useFakeTimers();
    api.listSessionPrompts.mockResolvedValue([prompt(0, 'Q1', 'A1')]);
    render(<SessionHistoryPane sessionId="s1" />);
    await tick(0);
    expect(rowTexts()).toEqual(['Q1']);
    api.listSessionPrompts.mockResolvedValue([
      prompt(0, 'Q1', 'A1'),
      { ...prompt(1, 'Q2', 'streaming…'), status: 'answering', pending: true },
    ]);
    await tick(2000);
    expect(rowTexts()).toEqual(['Q2', 'Q1']);
    api.listSessionPrompts.mockResolvedValue([prompt(0, 'Q1', 'A1'), prompt(1, 'Q2', 'final')]);
    await tick(2000);
    expect(screen.getByText('final')).toBeInTheDocument();
    expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
  });

  it('keeps the last loaded prompts visible when a refresh fails, then recovers without a manual action', async () => {
    vi.useFakeTimers();
    api.listSessionPrompts.mockResolvedValue(prompts);
    render(<SessionHistoryPane sessionId="s1" />);
    await tick(0);
    api.listSessionPrompts.mockRejectedValueOnce(new Error('Backend busy'));
    await tick(2000);
    expect(screen.getByRole('alert')).toHaveTextContent(/showing the last loaded prompts\. Backend busy/);
    expect(rowTexts()).toHaveLength(3);
    expect(screen.queryByText('No prompts recorded yet.')).not.toBeInTheDocument();
    await tick(2000);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(rowTexts()).toHaveLength(3);
  });

  it('shows a retryable error, not an empty history, when the first load fails', async () => {
    api.listSessionPrompts.mockRejectedValueOnce('boom');
    render(<SessionHistoryPane sessionId="s1" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Unknown error.');
    expect(screen.queryByText('No prompts recorded yet.')).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /Fix the checkout bug/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('abandons a hung poll, reports it, aborts the request and recovers on the next poll', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    api.listSessionPrompts.mockImplementationOnce((_id: string, options?: { signal: AbortSignal }) => {
      signals.push(options!.signal);
      return new Promise<SessionPrompt[]>(() => undefined);
    });
    render(<SessionHistoryPane sessionId="s1" pollTimeoutMs={1000} />);
    await tick(0);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    await tick(1000);
    expect(signals[0].aborted).toBe(true);
    expect(screen.getByRole('alert')).toHaveTextContent('The request took too long.');
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    await tick(2000);
    expect(rowTexts()).toHaveLength(3);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores a slow response that arrives after its poll timed out', async () => {
    vi.useFakeTimers();
    const slow = pending();
    api.listSessionPrompts.mockReturnValueOnce(slow.promise).mockResolvedValue([prompt(0, 'Fresh', 'answer')]);
    render(<SessionHistoryPane sessionId="s1" pollTimeoutMs={1000} />);
    await tick(3000);
    expect(rowTexts()).toEqual(['Fresh']);
    await act(async () => slow.resolve([prompt(0, 'Stale', 'old')]));
    expect(rowTexts()).toEqual(['Fresh']);
  });

  it('never shows or applies another session\'s history after a switch', async () => {
    api.listSessionPrompts.mockResolvedValueOnce(prompts);
    const view = render(<SessionHistoryPane sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Fix the checkout bug/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'header' } });
    const s1Late = pending();
    const s2 = pending();
    api.listSessionPrompts.mockReset();
    api.listSessionPrompts.mockReturnValueOnce(s2.promise);
    view.rerender(<SessionHistoryPane sessionId="s2" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Improve the header')).not.toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('');
    await act(async () => s1Late.resolve([prompt(0, 'From s1', 'late')]));
    await act(async () => s2.resolve([prompt(0, 'From s2', 'ok')]));
    expect(rowTexts()).toEqual(['From s2']);
    expect(api.listSessionPrompts).toHaveBeenCalledWith('s2', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('aborts in-flight work and stops polling on unmount and on session change', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    api.listSessionPrompts.mockImplementation((_id: string, options?: { signal: AbortSignal }) => {
      signals.push(options!.signal);
      return new Promise<SessionPrompt[]>(() => undefined);
    });
    const view = render(<SessionHistoryPane sessionId="s1" />);
    await tick(0);
    view.rerender(<SessionHistoryPane sessionId="s2" />);
    expect(signals[0].aborted).toBe(true);
    view.unmount();
    expect(signals[1].aborted).toBe(true);
    const calls = api.listSessionPrompts.mock.calls.length;
    await tick(60_000);
    expect(api.listSessionPrompts.mock.calls.length).toBe(calls);
  });

  it('does not touch state after unmount when a request settles late', async () => {
    const late = pending();
    api.listSessionPrompts.mockReturnValueOnce(late.promise);
    const view = render(<SessionHistoryPane sessionId="s1" />);
    view.unmount();
    await act(async () => late.reject(new Error('late failure')));
    await act(async () => {});
    expect(api.listSessionPrompts).toHaveBeenCalledTimes(1);
  });

  it('reloads immediately on reconnect and when the window returns to the foreground', async () => {
    vi.useFakeTimers();
    render(<SessionHistoryPane sessionId="s1" />);
    await tick(0);
    expect(api.listSessionPrompts).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await tick(0);
    expect(api.listSessionPrompts).toHaveBeenCalledTimes(2);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await tick(0);
    expect(api.listSessionPrompts).toHaveBeenCalledTimes(3);
  });

  it('pauses polling while hidden and resumes when visible again', async () => {
    vi.useFakeTimers();
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      render(<SessionHistoryPane sessionId="s1" />);
      await tick(0);
      await tick(10_000);
      expect(api.listSessionPrompts).toHaveBeenCalledTimes(1);
      state.mockReturnValue('visible');
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      await tick(0);
      expect(api.listSessionPrompts).toHaveBeenCalledTimes(2);
      await tick(2000);
      expect(api.listSessionPrompts).toHaveBeenCalledTimes(3);
    } finally {
      state.mockRestore();
    }
  });

  it('keeps the latest live turn and its text when the next poll is rejected as unavailable (503)', async () => {
    vi.useFakeTimers();
    api.listSessionPrompts.mockResolvedValue([
      prompt(0, 'Q1', 'A1'),
      { ...prompt(1, 'Q2', 'live streamed text'), status: 'answering', pending: true },
    ]);
    render(<SessionHistoryPane sessionId="s1" />);
    await tick(0);
    api.listSessionPrompts.mockRejectedValueOnce(new Error('Live prompt history could not be read.'));
    await tick(2000);
    expect(rowTexts()).toEqual(['Q2', 'Q1']);
    expect(screen.getByText('live streamed text')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Live prompt history could not be read/);
  });

  it('keeps the open detail on the same turn through a failed poll and a recovered one', async () => {
    vi.useFakeTimers();
    api.listSessionPrompts.mockResolvedValue([{ ...prompt(0, 'Live', 'part'), status: 'answering', pending: true }]);
    render(<SessionHistoryPane sessionId="s1" />);
    await tick(0);
    fireEvent.click(screen.getByTitle('Open full prompt and response'));
    api.listSessionPrompts.mockRejectedValueOnce(new Error('down'));
    await tick(2000);
    expect(within(screen.getByRole('dialog')).getByText('part')).toBeInTheDocument();
    api.listSessionPrompts.mockResolvedValue([prompt(0, 'Live', 'complete')]);
    await tick(2000);
    expect(within(screen.getByRole('dialog')).getByText('complete')).toBeInTheDocument();
  });
});

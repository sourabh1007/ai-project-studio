import { describe, expect, it, vi } from 'vitest';
import { createWorkTrackingSource, type TrackingContext } from './tracking-source.js';
import type { SessionPrompt } from '../copilot-history/copilot-history-contract.js';

const turn = (patch: Partial<SessionPrompt> = {}): SessionPrompt => ({
  index: 0, text: 'Fix https://github.com/o/r/pull/42', response: 'Fixed and tested.',
  at: '2026-04-04T10:00:00Z', status: 'answered', answeredAt: null, durationMs: null, ...patch,
});
function setup() {
  const context: TrackingContext = {
    featureId: 'f', repoId: 'r', name: 'Work', sessions: [{ id: 's', provider: 'copilot' }], recorded: [],
  };
  const reader = {
    page: vi.fn(() => ['f']), exists: vi.fn(() => true), context: vi.fn(() => context as TrackingContext | null),
  };
  const history = { read: () => [], prompts: vi.fn(() => []), recentPrompts: vi.fn(async () => [turn()]) };
  const source = createWorkTrackingSource({ context: reader, history });
  return { context, reader, history, source, read: () => source.read('f', new AbortController().signal) };
}
describe('bounded work evidence', () => {
  it('uses the bounded provider-neutral port, with stable prompt/response identity and actual PR URLs', async () => {
    const f = setup();
    expect(f.source.page('', 'date')).toEqual(['f']);
    expect(f.source.exists('f', 'r')).toBe(true);
    const first = await f.read();
    expect(first?.evidence.map((entry) => entry.kind)).toEqual(['prompt', 'pr', 'response']);
    expect(first?.evidence[1].text).toBe('https://github.com/o/r/pull/42');
    expect(f.history.recentPrompts).toHaveBeenCalledWith('s', 4);
    expect(f.history.prompts).not.toHaveBeenCalled();
    f.history.recentPrompts.mockResolvedValue([turn({ index: 100, pending: true })]);
    expect((await f.read())?.evidence).toEqual(first?.evidence);
  });
  it('does not churn extraction on streaming response chunks or infer completion', async () => {
    const f = setup();
    f.history.recentPrompts.mockResolvedValue([turn({ response: 'working', status: 'answering' })]);
    const first = await f.read();
    f.history.recentPrompts.mockResolvedValue([turn({ response: 'working, still', status: 'answering' })]);
    expect((await f.read())?.evidence).toEqual(first?.evidence);
    expect(first?.evidence.some((entry) => entry.kind === 'response')).toBe(false);
    f.history.recentPrompts.mockResolvedValue([turn({ response: null, status: 'unanswered' })]);
    expect((await f.read())?.evidence).toEqual(first?.evidence);
  });
  it('caps workspaces, text, and total evidence before AI; preserves recorded provenance and marks excerpts', async () => {
    const f = setup();
    f.context.sessions = Array.from({ length: 10 }, (_, index) => ({ id: `${index}`, provider: 'agency' }));
    f.context.recorded = [{
      id: 'agent', kind: 'agent', label: 'Business review', text: 'x'.repeat(10000), at: '', sessionId: null, completed: true,
    }];
    f.history.recentPrompts.mockResolvedValue(Array.from({ length: 4 }, () => turn({ text: 'x'.repeat(8000), response: 'y'.repeat(8000) })));
    const result = await f.read();
    expect(f.history.recentPrompts).toHaveBeenCalledTimes(4);
    expect(result?.evidence[0]).toMatchObject({ kind: 'agent', truncated: true, text: 'x'.repeat(3000) });
    expect(result!.evidence.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(48000);
  });
  it('does not silently fall back to unbounded history and honors missing/deleted/cancelled owners', async () => {
    const f = setup();
    f.reader.context.mockReturnValue(null);
    expect(await f.read()).toBeNull();
    f.reader.context.mockReturnValue(f.context);
    const unsupported = createWorkTrackingSource({ context: f.reader, history: { read: () => [], prompts: () => [] } });
    await expect(unsupported.read('f', new AbortController().signal)).rejects.toThrow('Bounded');
    await expect(f.source.read('f', AbortSignal.abort())).rejects.toThrow();
    f.history.recentPrompts.mockImplementation(async () => { throw new Error('history unavailable'); });
    await expect(f.read()).rejects.toThrow('unavailable');
  });
});

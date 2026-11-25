import { describe, expect, it, vi } from 'vitest';
import { createProviderHistoryReader } from './provider-history-reader.js';
import type { CopilotHistoryReader, SessionHistory } from './copilot-history-contract.js';

const history = (sessionId: string): SessionHistory => ({ sessionId, summary: sessionId, firstUserMessage: null, checkpoints: [] });

describe('provider history routing', () => {
  it('routes bounded work evidence by original provider and never falls back to full history', async () => {
    const recentPrompts = vi.fn(async () => []);
    const reader = createProviderHistoryReader({
      sessions: { get: (id) => id === 'missing' ? null : { provider: id } },
      readers: new Map([
        ['copilot', { read: () => [], prompts: () => [], recentPrompts }],
        ['old', { read: () => [], prompts: () => [] }],
      ]),
    });
    expect(await reader.recentPrompts!('copilot', 4)).toEqual([]);
    expect(recentPrompts).toHaveBeenCalledWith('copilot', 4);
    for (const id of ['old', 'unknown', 'missing']) {
      expect(() => reader.recentPrompts!(id, 4)).toThrow('bounded prompt reader');
    }
  });
  it('groups persisted providers, preserves input order and does not consult active execution policy', () => {
    const copilot: CopilotHistoryReader = { read: vi.fn((ids) => ids.map(history).reverse()), prompts: vi.fn(() => []) };
    const claude: CopilotHistoryReader = { read: vi.fn((ids) => [...ids.map(history), history('foreign')]), prompts: vi.fn(() => []) };
    const providers = new Map([['old', 'copilot'], ['new', 'claude'], ['agency', 'agency'], ['unsupported', 'other']]);
    const reader = createProviderHistoryReader({
      sessions: { get: (id) => providers.has(id) ? { provider: providers.get(id)! } : null },
      readers: new Map([['copilot', copilot], ['agency', copilot], ['claude', claude]]),
    });
    expect(reader.read(['new', 'missing', 'old', 'agency', 'unsupported', 'new'])).toEqual([history('new'), history('old'), history('agency')]);
    expect(copilot.read).toHaveBeenCalledWith(['old', 'agency']);
    expect(claude.read).toHaveBeenCalledWith(['new']);
    expect(reader.prompts('old')).toEqual([]);
    expect(reader.prompts('new')).toEqual([]);
    expect(reader.prompts('unsupported')).toEqual([]);
    expect(reader.prompts('missing')).toEqual([]);
    expect(copilot.prompts).toHaveBeenCalledWith('old');
    expect(claude.prompts).toHaveBeenCalledWith('new');
    expect(reader.read([])).toEqual([]);
  });

  it('passes through asynchronous prompt reads and their rejections', async () => {
    const failure = new Error('locked');
    const copilot = { read: () => [], prompts: vi.fn(async () => { throw failure; }) };
    const claude = { read: () => [], prompts: vi.fn(async () => [{ index: 0, text: 'q', at: '', response: null, status: 'unanswered' as const, answeredAt: null, durationMs: null }]) };
    const reader = createProviderHistoryReader({
      sessions: { get: (id) => ({ provider: id === 'a' ? 'copilot' : 'claude' }) },
      readers: new Map([['copilot', copilot], ['claude', claude]]),
    });
    await expect(reader.prompts('a')).rejects.toBe(failure);
    await expect(reader.prompts('b')).resolves.toHaveLength(1);
  });
});

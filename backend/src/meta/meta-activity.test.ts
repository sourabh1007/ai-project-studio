import { describe, expect, it } from 'vitest';

import { describeMetaActivity } from './meta-activity.js';

describe('describeMetaActivity', () => {
  it('returns null for empty or whitespace-only lines', () => {
    expect(describeMetaActivity('')).toBeNull();
    expect(describeMetaActivity('   \t ')).toBeNull();
  });

  it('shows a raw diagnostic for non-JSON lines', () => {
    expect(describeMetaActivity('starting up')).toBe('· starting up');
  });

  it('shows a raw diagnostic for JSON that is not an event object', () => {
    expect(describeMetaActivity('[1,2,3]')).toBe('· [1,2,3]');
    expect(describeMetaActivity('{"no":"type"}')).toBe('· {"no":"type"}');
  });

  it('drops streaming deltas that would flood the log', () => {
    expect(
      describeMetaActivity(JSON.stringify({ type: 'assistant.message_delta', data: { content: 'x' } })),
    ).toBeNull();
    expect(
      describeMetaActivity(JSON.stringify({ type: 'assistant.message.delta' })),
    ).toBeNull();
    expect(describeMetaActivity(JSON.stringify({ type: 'message.delta' }))).toBeNull();
  });

  it('summarises assistant messages, with a fallback when empty', () => {
    expect(
      describeMetaActivity(
        JSON.stringify({ type: 'assistant.message', data: { content: 'Analyzing the diff' } }),
      ),
    ).toBe('💬 Analyzing the diff');
    expect(
      describeMetaActivity(JSON.stringify({ type: 'assistant.message', data: {} })),
    ).toBe('💬 assistant responded');
    expect(
      describeMetaActivity(JSON.stringify({ type: 'assistant.message' })),
    ).toBe('💬 assistant responded');
  });

  it('surfaces session errors, with a fallback message', () => {
    expect(
      describeMetaActivity(JSON.stringify({ type: 'session.error', data: { message: 'boom' } })),
    ).toBe('⚠ boom');
    expect(
      describeMetaActivity(JSON.stringify({ type: 'session.error', data: {} })),
    ).toBe('⚠ session error');
    expect(
      describeMetaActivity(JSON.stringify({ type: 'session.error' })),
    ).toBe('⚠ session error');
  });

  it('describes tool events by phase and name', () => {
    expect(
      describeMetaActivity(JSON.stringify({ type: 'tool.execution_start', data: { name: 'read' } })),
    ).toBe('🔧 running read');
    expect(
      describeMetaActivity(JSON.stringify({ type: 'tool.execution_complete', data: { tool: 'grep' } })),
    ).toBe('🔧 finished grep');
    expect(
      describeMetaActivity(JSON.stringify({ type: 'tool.end' })),
    ).toBe('🔧 finished');
    expect(
      describeMetaActivity(JSON.stringify({ type: 'tool.other', data: {} })),
    ).toBe('🔧 tool');
  });

  it('shows reasoning text when present and skips it when empty', () => {
    expect(
      describeMetaActivity(JSON.stringify({ type: 'reasoning', data: { text: 'thinking' } })),
    ).toBe('🧠 thinking');
    expect(
      describeMetaActivity(JSON.stringify({ type: 'reasoning.delta', data: {} })),
    ).toBeNull();
    expect(describeMetaActivity(JSON.stringify({ type: 'reasoning' }))).toBeNull();
  });

  it('falls back to the event type for any other typed event', () => {
    expect(describeMetaActivity(JSON.stringify({ type: 'session.start' }))).toBe(
      '· session.start',
    );
  });

  it('clips over-long content to a bounded length', () => {
    const long = 'a'.repeat(400);
    const out = describeMetaActivity(
      JSON.stringify({ type: 'assistant.message', data: { content: long } }),
    );
    expect(out?.startsWith('💬 ')).toBe(true);
    expect(out?.endsWith('…')).toBe(true);
    expect((out ?? '').length).toBeLessThan(180);
  });
});

import { describe, it, expect } from 'vitest';
import {
  applyRefineTemplate,
  buildRefinePrompt,
  DEFAULT_REFINE_PROMPT_TEMPLATE,
  extractRefineJson,
  parseRefineResponse,
  renderTranscript,
  type RefineChatMessage,
} from './refine-chat.js';

function fence(json: string): string {
  return ['```json', json, '```'].join('\n');
}

describe('applyRefineTemplate', () => {
  it('replaces every occurrence and leaves unknown placeholders', () => {
    expect(applyRefineTemplate('{{a}}-{{a}}-{{b}}-{{c}}', { a: 'x', b: 'y' })).toBe(
      'x-x-y-{{c}}',
    );
  });
});

describe('renderTranscript', () => {
  it('marks an empty conversation', () => {
    expect(renderTranscript([])).toBe('(no messages yet)');
  });

  it('labels each speaker and trims content', () => {
    const messages: RefineChatMessage[] = [
      { role: 'user', content: '  hi  ' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(renderTranscript(messages)).toBe('User: hi\nAssistant: hello');
  });
});

describe('buildRefinePrompt', () => {
  it('injects the inputs', () => {
    const prompt = buildRefinePrompt(DEFAULT_REFINE_PROMPT_TEMPLATE, {
      artifactLabel: 'test scenarios',
      featureContext: '  a feature  ',
      artifact: '  the artifact  ',
      revisedHint: 'shape hint',
      messages: [{ role: 'user', content: 'change it' }],
      message: '  change it  ',
    });
    expect(prompt).toContain('test scenarios');
    expect(prompt).toContain('a feature');
    expect(prompt).toContain('the artifact');
    expect(prompt).toContain('shape hint');
    expect(prompt).toContain('User: change it');
  });

  it('falls back for blank context and artifact', () => {
    const prompt = buildRefinePrompt(DEFAULT_REFINE_PROMPT_TEMPLATE, {
      artifactLabel: 'plan',
      featureContext: '   ',
      artifact: '   ',
      revisedHint: 'hint',
      messages: [],
      message: 'hi',
    });
    expect(prompt).toContain('(none provided)');
    expect(prompt).toContain('(empty)');
  });
});

describe('extractRefineJson', () => {
  it('prefers a fenced block', () => {
    expect(extractRefineJson(fence('{"a":1}'))).toBe('{"a":1}');
  });

  it('falls back to the brace span in prose', () => {
    expect(extractRefineJson('noise {"a":1} tail')).toBe('{"a":1}');
  });

  it('returns null when there is no object span', () => {
    expect(extractRefineJson('no json')).toBeNull();
    expect(extractRefineJson('} out of order {')).toBeNull();
  });
});

describe('parseRefineResponse', () => {
  it('parses a reply and a revised artifact', () => {
    const text = fence(
      JSON.stringify({ reply: 'done', revised: { scenarios: [] } }),
    );
    expect(parseRefineResponse(text)).toEqual({
      reply: 'done',
      revised: { scenarios: [] },
    });
  });

  it('defaults revised to null when absent', () => {
    expect(parseRefineResponse(fence('{"reply":"hi"}'))).toEqual({
      reply: 'hi',
      revised: null,
    });
  });

  it('uses the raw text when the reply is blank', () => {
    const text = fence('{"reply":"   ","revised":null}');
    const parsed = parseRefineResponse(text);
    expect(parsed.reply).toContain('"reply"');
    expect(parsed.revised).toBeNull();
  });

  it('treats the whole text as the reply when json is malformed', () => {
    const text = fence('{"reply": not json}');
    expect(parseRefineResponse(text)).toEqual({
      reply: text.trim(),
      revised: null,
    });
  });

  it('treats the whole text as the reply when there is no json', () => {
    expect(parseRefineResponse('just chatting')).toEqual({
      reply: 'just chatting',
      revised: null,
    });
  });
});

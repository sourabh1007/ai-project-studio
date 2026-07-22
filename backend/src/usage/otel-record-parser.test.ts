import { describe, it, expect } from 'vitest';
import { parseOtelLine } from './otel-record-parser.js';

describe('otel-record-parser', () => {
  it('returns null for blank and malformed lines', () => {
    expect(parseOtelLine('')).toBeNull();
    expect(parseOtelLine('   ')).toBeNull();
    expect(parseOtelLine('{not json')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseOtelLine('null')).toBeNull();
    expect(parseOtelLine('5')).toBeNull();
  });

  it('parses a span record with defaults for missing fields', () => {
    const line = JSON.stringify({
      type: 'span',
      name: 'chat gpt-5.4-mini',
      startTime: [10, 500_000_000],
      endTime: [12, 0],
      attributes: { 'gen_ai.operation.name': 'chat' },
      resource: { attributes: { 'session.id': 's1' } },
    });
    const record = parseOtelLine(line);
    expect(record).toEqual({
      kind: 'span',
      name: 'chat gpt-5.4-mini',
      startTime: [10, 500_000_000],
      endTime: [12, 0],
      attributes: { 'gen_ai.operation.name': 'chat' },
      resource: { attributes: { 'session.id': 's1' } },
    });
  });

  it('applies fallbacks for a span missing optional fields', () => {
    const record = parseOtelLine(JSON.stringify({ type: 'span' }));
    expect(record).toEqual({
      kind: 'span',
      name: '',
      startTime: [0, 0],
      endTime: [0, 0],
      attributes: {},
      resource: { attributes: {} },
    });
  });

  it('parses a metric record and defaults dataPoints', () => {
    expect(
      parseOtelLine(
        JSON.stringify({ type: 'metric', name: 'gen_ai.client.token.usage', dataPoints: [{ x: 1 }] }),
      ),
    ).toEqual({ kind: 'metric', name: 'gen_ai.client.token.usage', dataPoints: [{ x: 1 }] });
    expect(parseOtelLine(JSON.stringify({ type: 'metric' }))).toEqual({
      kind: 'metric',
      name: '',
      dataPoints: [],
    });
  });

  it('classifies unknown types as other', () => {
    expect(parseOtelLine(JSON.stringify({ type: 'log' }))).toEqual({
      kind: 'other',
    });
  });

  it('coerces null attributes/resource and non-numeric hrTime to safe defaults', () => {
    const record = parseOtelLine(
      JSON.stringify({
        type: 'span',
        attributes: null,
        resource: null,
        startTime: ['x', null],
        endTime: [3, 4],
      }),
    );
    expect(record).toEqual({
      kind: 'span',
      name: '',
      startTime: [0, 0],
      endTime: [3, 4],
      attributes: {},
      resource: { attributes: {} },
    });
  });
});

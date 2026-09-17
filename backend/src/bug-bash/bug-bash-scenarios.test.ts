import { describe, it, expect } from 'vitest';
import {
  extractJsonObject,
  parseResults,
  parseScenarios,
} from './bug-bash-scenarios.js';

function fence(json: string): string {
  return ['```json', json, '```'].join('\n');
}

describe('extractJsonObject', () => {
  it('prefers a fenced json block', () => {
    expect(extractJsonObject(fence('{"a":1}'))).toBe('{"a":1}');
  });

  it('falls back to the first..last brace span in prose', () => {
    expect(extractJsonObject('noise {"a":1} tail')).toBe('{"a":1}');
  });

  it('returns null when there is no object span', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('} out of order {')).toBeNull();
  });
});

describe('parseScenarios', () => {
  it('parses a full scenario list and trims/filters fields', () => {
    const text = fence(
      JSON.stringify({
        scenarios: [
          {
            title: '  Empty input  ',
            input: '  ""  ',
            steps: ['  run it  ', '   ', 'observe'],
            expectedOutput: ' an error ',
            confirmation: ' none ',
          },
        ],
      }),
    );
    expect(parseScenarios(text)).toEqual([
      {
        title: 'Empty input',
        input: '""',
        steps: ['run it', 'observe'],
        expectedOutput: 'an error',
        confirmation: 'none',
      },
    ]);
  });

  it('defaults optional fields to empty', () => {
    const text = fence(JSON.stringify({ scenarios: [{ title: 'Bare' }] }));
    expect(parseScenarios(text)).toEqual([
      {
        title: 'Bare',
        input: '',
        steps: [],
        expectedOutput: '',
        confirmation: '',
      },
    ]);
  });

  it('drops scenarios with a blank title', () => {
    const text = fence(
      JSON.stringify({ scenarios: [{ title: '   ' }, { title: 'Keep' }] }),
    );
    expect(parseScenarios(text).map((s) => s.title)).toEqual(['Keep']);
  });

  it('returns [] when no json object exists', () => {
    expect(parseScenarios('nope')).toEqual([]);
  });

  it('returns [] when the json does not match the schema', () => {
    expect(parseScenarios(fence('{"scenarios":"nope"}'))).toEqual([]);
  });
});

describe('parseResults', () => {
  it('parses results and trims observations', () => {
    const text = fence(
      JSON.stringify({
        results: [
          { id: 'scenario-1', status: 'pass', observations: '  worked  ' },
          { id: 'scenario-2', status: 'fail', observations: 'broke' },
        ],
      }),
    );
    expect(parseResults(text)).toEqual([
      { id: 'scenario-1', status: 'pass', observations: 'worked' },
      { id: 'scenario-2', status: 'fail', observations: 'broke' },
    ]);
  });

  it('defaults a missing status to blocked and missing observations to empty', () => {
    const text = fence(JSON.stringify({ results: [{ id: 'scenario-1' }] }));
    expect(parseResults(text)).toEqual([
      { id: 'scenario-1', status: 'blocked', observations: '' },
    ]);
  });

  it('drops entries with a blank id', () => {
    const text = fence(
      JSON.stringify({
        results: [{ id: '  ', status: 'pass' }, { id: 'scenario-1' }],
      }),
    );
    expect(parseResults(text).map((r) => r.id)).toEqual(['scenario-1']);
  });

  it('returns [] when no json object exists', () => {
    expect(parseResults('nope')).toEqual([]);
  });

  it('returns [] when the json does not match the schema', () => {
    expect(parseResults(fence('{"results":[{"status":"pass"}]}'))).toEqual([]);
  });
});

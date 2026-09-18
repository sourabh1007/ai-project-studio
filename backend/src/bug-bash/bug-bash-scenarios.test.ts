import { describe, it, expect } from 'vitest';
import {
  extractJsonObject,
  parseAreas,
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
      {
        id: 'scenario-1',
        status: 'pass',
        observations: 'worked',
        ran: true,
        actualOutput: '',
        blockedReason: null,
        diagnostics: '',
      },
      {
        id: 'scenario-2',
        status: 'fail',
        observations: 'broke',
        ran: true,
        actualOutput: '',
        blockedReason: null,
        diagnostics: '',
      },
    ]);
  });

  it('defaults a missing status to blocked and missing observations to empty', () => {
    const text = fence(JSON.stringify({ results: [{ id: 'scenario-1' }] }));
    expect(parseResults(text)).toEqual([
      {
        id: 'scenario-1',
        status: 'blocked',
        observations: '',
        ran: false,
        actualOutput: '',
        blockedReason: 'other',
        diagnostics: '',
      },
    ]);
  });

  it('captures ran, actualOutput, blockedReason and diagnostics and trims them', () => {
    const text = fence(
      JSON.stringify({
        results: [
          {
            id: 'scenario-1',
            status: 'blocked',
            ran: false,
            actualOutput: '  nothing happened  ',
            blockedReason: 'permission',
            diagnostics: '  401 from api  ',
          },
        ],
      }),
    );
    expect(parseResults(text)).toEqual([
      {
        id: 'scenario-1',
        status: 'blocked',
        observations: '',
        ran: false,
        actualOutput: 'nothing happened',
        blockedReason: 'permission',
        diagnostics: '401 from api',
      },
    ]);
  });

  it('forces blockedReason to null for a non-blocked status even when supplied', () => {
    const text = fence(
      JSON.stringify({
        results: [
          { id: 'scenario-1', status: 'pass', ran: false, blockedReason: 'permission' },
        ],
      }),
    );
    const [result] = parseResults(text);
    expect(result.blockedReason).toBeNull();
    expect(result.ran).toBe(false);
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

describe('parseAreas', () => {
  it('parses areas and trims fields', () => {
    const text = fence(
      JSON.stringify({
        areas: [
          { title: '  Input parsing  ', focus: '  malformed input  ' },
          { title: 'Concurrency', focus: 'races' },
        ],
      }),
    );
    expect(parseAreas(text)).toEqual([
      { title: 'Input parsing', focus: 'malformed input' },
      { title: 'Concurrency', focus: 'races' },
    ]);
  });

  it('falls back the focus to the title when missing', () => {
    const text = fence(JSON.stringify({ areas: [{ title: 'Errors' }] }));
    expect(parseAreas(text)).toEqual([{ title: 'Errors', focus: 'Errors' }]);
  });

  it('drops areas with a blank title', () => {
    const text = fence(
      JSON.stringify({ areas: [{ title: '  ' }, { title: 'Keep' }] }),
    );
    expect(parseAreas(text).map((a) => a.title)).toEqual(['Keep']);
  });

  it('returns [] when no json object exists', () => {
    expect(parseAreas('nope')).toEqual([]);
  });

  it('returns [] when the json does not match the schema', () => {
    expect(parseAreas(fence('{"areas":"nope"}'))).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  auditScenarioEvidence,
  extractJsonObject,
  parseAreas,
  parsePrerequisites,
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
          {
            id: 'scenario-1',
            status: 'pass',
            observations: '  worked  ',
            actualOutput: 'returned 200',
          },
          {
            id: 'scenario-2',
            status: 'fail',
            observations: 'broke',
            diagnostics: '500 error',
          },
        ],
      }),
    );
    expect(parseResults(text)).toEqual([
      {
        id: 'scenario-1',
        status: 'pass',
        observations: 'worked',
        ran: true,
        actualOutput: 'returned 200',
        blockedReason: null,
        diagnostics: '',
        reproScript: '',
      },
      {
        id: 'scenario-2',
        status: 'fail',
        observations: 'broke',
        ran: true,
        actualOutput: '',
        blockedReason: null,
        diagnostics: '500 error',
        reproScript: '',
      },
    ]);
  });

  it('parses and trims a reproScript when the tester supplies one', () => {
    const text = fence(
      JSON.stringify({
        results: [
          {
            id: 'scenario-1',
            status: 'pass',
            actualOutput: 'returned 200',
            reproScript: '  curl -s localhost/health  ',
          },
        ],
      }),
    );
    expect(parseResults(text)[0].reproScript).toBe('curl -s localhost/health');
  });

  it('marks a verdict with no actualOutput or diagnostics as not really run', () => {
    const text = fence(
      JSON.stringify({
        results: [
          { id: 'scenario-1', status: 'pass', observations: 'looked fine' },
          { id: 'scenario-2', status: 'fail', ran: true, observations: 'no evidence' },
        ],
      }),
    );
    const results = parseResults(text);
    expect(results.map((r) => ({ id: r.id, status: r.status, ran: r.ran }))).toEqual([
      { id: 'scenario-1', status: 'pass', ran: false },
      { id: 'scenario-2', status: 'fail', ran: false },
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
        reproScript: '',
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
        reproScript: '',
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

describe('auditScenarioEvidence', () => {
  const evidenced = {
    status: 'pass' as const,
    actualOutput: 'returned 200',
    diagnostics: 'GET /health → 200',
    reproScript: 'curl -s localhost/health',
  };

  it('returns no gaps for a fully-evidenced pass/fail verdict', () => {
    expect(auditScenarioEvidence(evidenced)).toEqual([]);
    expect(auditScenarioEvidence({ ...evidenced, status: 'fail' })).toEqual([]);
  });

  it('flags each missing artefact for a pass/fail verdict', () => {
    expect(
      auditScenarioEvidence({
        status: 'pass',
        actualOutput: '   ',
        diagnostics: '',
        reproScript: '',
      }),
    ).toEqual(['actual output', 'diagnostics/logs', 'a repro script']);
  });

  it('flags only the repro script when output and logs are present', () => {
    expect(auditScenarioEvidence({ ...evidenced, reproScript: '' })).toEqual([
      'a repro script',
    ]);
  });

  it('requires no evidence for a blocked or pending scenario', () => {
    expect(
      auditScenarioEvidence({
        status: 'blocked',
        actualOutput: '',
        diagnostics: '',
        reproScript: '',
      }),
    ).toEqual([]);
    expect(
      auditScenarioEvidence({
        status: 'pending',
        actualOutput: '',
        diagnostics: '',
        reproScript: '',
      }),
    ).toEqual([]);
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

describe('parsePrerequisites', () => {
  it('parses questions, trims fields and defaults a missing detail', () => {
    const text = fence(
      JSON.stringify({
        prerequisites: [
          { question: '  Which account?  ', detail: '  to connect  ' },
          { question: 'Endpoint?' },
        ],
      }),
    );
    expect(parsePrerequisites(text)).toEqual([
      { question: 'Which account?', detail: 'to connect', options: [] },
      { question: 'Endpoint?', detail: '', options: [] },
    ]);
  });

  it('trims, dedupes and drops blank answer options', () => {
    const text = fence(
      JSON.stringify({
        prerequisites: [
          {
            question: 'Enabled?',
            options: ['  Yes  ', 'No', 'Yes', '   ', 'Unsure'],
          },
        ],
      }),
    );
    expect(parsePrerequisites(text)[0].options).toEqual([
      'Yes',
      'No',
      'Unsure',
    ]);
  });

  it('drops entries with a blank question', () => {
    const text = fence(
      JSON.stringify({ prerequisites: [{ question: '  ' }, { question: 'Keep' }] }),
    );
    expect(parsePrerequisites(text).map((p) => p.question)).toEqual(['Keep']);
  });

  it('returns [] when no json object exists', () => {
    expect(parsePrerequisites('nope')).toEqual([]);
  });

  it('returns [] when the json does not match the schema', () => {
    expect(parsePrerequisites(fence('{"prerequisites":"nope"}'))).toEqual([]);
  });
});

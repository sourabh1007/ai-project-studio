import { describe, it, expect } from 'vitest';
import {
  applyTemplate,
  buildDecomposePrompt,
  buildGeneratePrompt,
  buildReportPrompt,
  buildTesterPrompt,
  DEFAULT_DECOMPOSE_PROMPT_TEMPLATE,
  DEFAULT_GENERATE_PROMPT_TEMPLATE,
  DEFAULT_REPORT_PROMPT_TEMPLATE,
  DEFAULT_TESTER_PROMPT_TEMPLATE,
  NO_SETUP_MARKER,
  renderResult,
  renderScenario,
  summarizeResults,
  WHOLE_FEATURE_FOCUS,
} from './bug-bash-prompt.js';
import type { BugBashScenario } from './bug-bash-contract.js';

function scenario(overrides: Partial<BugBashScenario> = {}): BugBashScenario {
  return {
    id: 'scenario-1',
    title: 'Empty input',
    input: '""',
    steps: ['run it', 'observe'],
    expectedOutput: 'an error',
    confirmation: '',
    status: 'pending',
    observations: '',
    ran: false,
    actualOutput: '',
    blockedReason: null,
    testerId: null,
    diagnostics: '',
    ...overrides,
  };
}

describe('applyTemplate', () => {
  it('replaces every occurrence of a placeholder', () => {
    expect(applyTemplate('{{a}}-{{a}}-{{b}}', { a: 'x', b: 'y' })).toBe('x-x-y');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(applyTemplate('{{a}}-{{c}}', { a: 'x' })).toBe('x-{{c}}');
  });
});

describe('buildGeneratePrompt', () => {
  it('injects the trimmed inputs and focus', () => {
    const prompt = buildGeneratePrompt(DEFAULT_GENERATE_PROMPT_TEMPLATE, {
      featureInfo: '  A feature  ',
      setupInfo: '  docs here  ',
      focus: '  boundary values  ',
    });
    expect(prompt).toContain('A feature');
    expect(prompt).toContain('docs here');
    expect(prompt).toContain('boundary values');
    expect(prompt).not.toContain(NO_SETUP_MARKER);
  });

  it('substitutes a marker when setup info is blank', () => {
    const prompt = buildGeneratePrompt(DEFAULT_GENERATE_PROMPT_TEMPLATE, {
      featureInfo: 'A feature',
      setupInfo: '   ',
    });
    expect(prompt).toContain(NO_SETUP_MARKER);
  });

  it('falls back to a whole-feature focus when none is given', () => {
    const prompt = buildGeneratePrompt(DEFAULT_GENERATE_PROMPT_TEMPLATE, {
      featureInfo: 'A feature',
      setupInfo: 'docs',
      focus: '   ',
    });
    expect(prompt).toContain(WHOLE_FEATURE_FOCUS);
  });
});

describe('buildDecomposePrompt', () => {
  it('injects the inputs and the max area count', () => {
    const prompt = buildDecomposePrompt(DEFAULT_DECOMPOSE_PROMPT_TEMPLATE, {
      featureInfo: '  A feature  ',
      setupInfo: '   ',
      maxAreas: 4,
    });
    expect(prompt).toContain('A feature');
    expect(prompt).toContain(NO_SETUP_MARKER);
    expect(prompt).toContain('at most 4 distinct');
  });
});

describe('renderScenario', () => {
  it('renders steps, input, expected output and confirmation', () => {
    const text = renderScenario(scenario({ confirmation: 'need a token' }));
    expect(text).toContain('Scenario scenario-1: Empty input');
    expect(text).toContain('1. run it');
    expect(text).toContain('2. observe');
    expect(text).toContain('- Input: ""');
    expect(text).toContain('- Expected output: an error');
    expect(text).toContain('- Must confirm first: need a token');
  });

  it('falls back for missing steps/input/expected output and omits confirmation', () => {
    const text = renderScenario(
      scenario({ steps: [], input: '', expectedOutput: '' }),
    );
    expect(text).toContain('(no steps provided)');
    expect(text).toContain('- Input: (none)');
    expect(text).toContain('- Expected output: (unspecified)');
    expect(text).not.toContain('Must confirm');
  });
});

describe('buildTesterPrompt', () => {
  it('renders every assigned scenario', () => {
    const prompt = buildTesterPrompt(DEFAULT_TESTER_PROMPT_TEMPLATE, {
      featureInfo: 'A feature',
      setupInfo: '',
      scenarios: [scenario(), scenario({ id: 'scenario-2', title: 'Boundary' })],
    });
    expect(prompt).toContain('A feature');
    expect(prompt).toContain(NO_SETUP_MARKER);
    expect(prompt).toContain('scenario-1');
    expect(prompt).toContain('scenario-2');
  });
});

describe('renderResult', () => {
  it('renders status, ran, steps to replicate, actual output and observations', () => {
    const text = renderResult(
      scenario({
        status: 'fail',
        ran: true,
        actualOutput: 'it threw',
        observations: 'crashed',
      }),
    );
    expect(text).toContain('- Status: fail');
    expect(text).toContain('- Actually ran: yes');
    expect(text).toContain('- Steps to replicate:');
    expect(text).toContain('1. run it');
    expect(text).toContain('- Actual output: it threw');
    expect(text).toContain('- Observations: crashed');
  });

  it('renders the blocked reason and diagnostics when present', () => {
    const text = renderResult(
      scenario({
        status: 'blocked',
        ran: false,
        blockedReason: 'permission',
        diagnostics: '401 from api',
      }),
    );
    expect(text).toContain('- Actually ran: no');
    expect(text).toContain('- Blocked reason: permission (needs access)');
    expect(text).toContain('- Diagnostics: 401 from api');
  });

  it('omits the blocked reason line when a blocked scenario has no reason', () => {
    const text = renderResult(scenario({ status: 'blocked', blockedReason: null }));
    expect(text).toContain('- Status: blocked');
    expect(text).not.toContain('- Blocked reason:');
  });

  it('falls back when observations, actual output and steps are empty', () => {
    const text = renderResult(scenario({ steps: [], input: '', expectedOutput: '' }));
    expect(text).toContain('(none reported)');
    expect(text).toContain('(no steps provided)');
    expect(text).toContain('- Input: (none)');
    expect(text).toContain('- Expected output: (unspecified)');
    expect(text).toContain('- Actual output: (none reported)');
    // A non-blocked scenario with no diagnostics omits those lines.
    expect(text).not.toContain('- Blocked reason:');
    expect(text).not.toContain('- Diagnostics:');
  });
});

describe('buildReportPrompt', () => {
  it('injects feature info and rendered results', () => {
    const prompt = buildReportPrompt(DEFAULT_REPORT_PROMPT_TEMPLATE, {
      featureInfo: 'A feature',
      scenarios: [scenario({ status: 'pass', observations: 'ok' })],
    });
    expect(prompt).toContain('A feature');
    expect(prompt).toContain('- Status: pass');
  });
});

describe('summarizeResults', () => {
  it('summarizes a mix of pass/fail/blocked and splits blocked by access', () => {
    const report = summarizeResults([
      scenario({ id: 's1', title: 'A', status: 'pass', ran: true }),
      scenario({ id: 's2', title: 'B', status: 'fail', ran: true, observations: 'bug' }),
      scenario({
        id: 's3',
        title: 'C',
        status: 'blocked',
        blockedReason: 'permission',
      }),
      scenario({
        id: 's4',
        title: 'D',
        status: 'blocked',
        blockedReason: 'environment',
      }),
    ]);
    expect(report).toContain(
      'Ran 2 of 4 scenarios: 1 passed, 1 failed, 2 blocked (1 needing access).',
    );
    expect(report).toContain('## Bugs found');
    expect(report).toContain('- B: bug');
    expect(report).toContain('## Blocked — needs access');
    expect(report).toContain('- C: (no details)');
    expect(report).toContain('## Blocked — could not run');
    expect(report).toContain('- D [environment not ready]: (no details)');
    expect(report).toContain('## Passed');
    expect(report).toContain('- A');
    // Per-scenario reproducible detail for every scenario.
    expect(report).toContain('## Scenario details');
    expect(report).toContain('### A');
    expect(report).toContain('### C');
    expect(report).toContain('- Steps to replicate:');
    expect(report).toContain('- Actual output: (none reported)');
    expect(report).toContain('- Status: blocked (not run)');
  });

  it('renders a blocked scenario with no reason under could-not-run', () => {
    const report = summarizeResults([
      scenario({ id: 's1', title: 'A', status: 'blocked', blockedReason: null }),
    ]);
    expect(report).toContain('## Blocked — could not run');
    expect(report).toContain('- A: (no details)');
    expect(report).not.toContain('## Blocked — needs access');
  });

  it('omits the empty sections and uses the singular form', () => {
    const report = summarizeResults([
      scenario({ id: 's1', title: 'A', status: 'pass', ran: true, steps: [] }),
    ]);
    expect(report).toContain('Ran 1 of 1 scenario:');
    expect(report).not.toContain('## Bugs found');
    expect(report).not.toContain('## Blocked');
    expect(report).toContain('## Passed');
    // The detail section renders even with no steps.
    expect(report).toContain('## Scenario details');
    expect(report).toContain('(no steps provided)');
  });

  it('renders a failing scenario without observations', () => {
    const report = summarizeResults([
      scenario({ id: 's2', title: 'B', status: 'fail', observations: '' }),
    ]);
    expect(report).toContain('- B: (no details)');
  });
});

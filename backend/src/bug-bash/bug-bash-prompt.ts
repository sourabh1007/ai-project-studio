/**
 * Pure prompt builders for the Bug Bash agent.
 *
 * Bug Bash drives up to three kinds of AI turn: a *generate* turn where an
 * analyst mines the feature description + repository code for edge-case
 * scenarios, per-tester *run* turns that execute a group of accepted scenarios,
 * and a *report* turn where the lead compiles the findings. Every prompt is
 * template driven so the wording can be tuned from the agent's settings without
 * a code change; the dynamic inputs are injected here at run time.
 *
 * Keeping the builders pure lets the 100% coverage gate exercise every branch
 * without invoking a provider.
 */

import type { BugBashScenario } from './bug-bash-contract.js';

/**
 * Substitute every `{{key}}` placeholder in a template with its value. Missing
 * placeholders are left untouched so a partially-filled template still renders.
 */
export function applyTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let output = template;
  for (const [key, value] of Object.entries(vars)) {
    output = output.split(`{{${key}}}`).join(value);
  }
  return output;
}

/** Fallback text used when the user leaves the setup information blank. */
export const NO_SETUP_MARKER = '(no setup information provided)';

/**
 * The default scenario-generation prompt for the analyst. Placeholders:
 * {{featureInfo}}, {{setupInfo}}.
 */
export const DEFAULT_GENERATE_PROMPT_TEMPLATE = [
  'You are a meticulous QA analyst planning a bug bash for a feature. Read the',
  'feature description, the setup information, and the ACTUAL code in the current',
  'working directory. Do NOT modify any files — produce test scenarios only.',
  '',
  'Feature information:',
  '{{featureInfo}}',
  '',
  'Setup information (documentation, sample programs, how to run/test it):',
  '{{setupInfo}}',
  '',
  'Investigate the code paths that implement this feature and design test',
  'scenarios that are most likely to BREAK it. Focus on edge cases: boundary',
  'values, empty/malformed input, concurrency, error handling, unusual',
  'configurations, and interactions the happy path ignores. Ground every',
  'scenario in behaviour the code actually has.',
  '',
  'Respond with ONLY a JSON object in a ```json code block, no prose, shaped:',
  '{"scenarios":[{',
  '"title":"what this scenario tests",',
  '"input":"the exact input to feed in",',
  '"steps":["ordered step using the setup info","..."],',
  '"expectedOutput":"the correct/expected behaviour",',
  '"confirmation":"anything the user must confirm or provide before running,',
  ' or an empty string if nothing"',
  '}]}',
].join('\n');

/**
 * The default tester prompt: execute one group of accepted scenarios.
 * Placeholders: {{featureInfo}}, {{setupInfo}}, {{scenarios}}.
 */
export const DEFAULT_TESTER_PROMPT_TEMPLATE = [
  'You are a tester sub-agent in a bug bash. Execute ONLY the scenarios assigned',
  'to you below against the feature, using the setup information to run it. Other',
  'testers are handling other scenarios in parallel — stay within your own.',
  '',
  'Feature information:',
  '{{featureInfo}}',
  '',
  'Setup information (how to run/test the feature):',
  '{{setupInfo}}',
  '',
  'Your assigned scenarios:',
  '{{scenarios}}',
  '',
  'For each scenario: perform the steps, compare the actual behaviour against the',
  'expected output, and decide a status — "pass" (behaved as expected), "fail" (a',
  'bug: it did not), or "blocked" (could not run it, e.g. missing setup). Keep',
  'observations concise and specific (what you saw, and for a failure why it is a',
  'bug). Do NOT modify source files to make a scenario pass.',
  '',
  'Respond with ONLY a JSON object in a ```json code block, no prose, shaped:',
  '{"results":[{"id":"<scenario id>","status":"pass",',
  '"observations":"what happened"}]}',
].join('\n');

/**
 * The default report prompt for the lead. Placeholders: {{featureInfo}},
 * {{results}}.
 */
export const DEFAULT_REPORT_PROMPT_TEMPLATE = [
  'You are the lead agent compiling the final report for a bug bash. Your testers',
  'ran the scenarios below and reported the results. Review them and write a',
  'clear, well-formatted markdown report for the feature owner.',
  '',
  'Feature information:',
  '{{featureInfo}}',
  '',
  'Scenario results from the testers:',
  '{{results}}',
  '',
  'Write the report in markdown with these sections:',
  '- "## Summary": one short paragraph — how many scenarios ran, how many passed',
  '  vs failed, and the overall health of the feature.',
  '- "## Bugs found": a bullet per failing scenario with what breaks and why it',
  '  matters. Omit the section when nothing failed.',
  '- "## Blocked": a bullet per blocked scenario and what was missing. Omit when',
  '  none were blocked.',
  '- "## Passed": a short bullet list of what worked.',
  'Be concise and specific. Do not invent results that were not reported.',
].join('\n');

/** Render the analyst scenario-generation prompt from the user's inputs. */
export function buildGeneratePrompt(
  template: string,
  input: { featureInfo: string; setupInfo: string },
): string {
  return applyTemplate(template, {
    featureInfo: input.featureInfo.trim(),
    setupInfo: input.setupInfo.trim() || NO_SETUP_MARKER,
  });
}

/** Render one scenario as a labelled block for a tester/report prompt. */
export function renderScenario(scenario: BugBashScenario): string {
  const steps =
    scenario.steps.length > 0
      ? scenario.steps.map((step, index) => `  ${index + 1}. ${step}`).join('\n')
      : '  (no steps provided)';
  const lines = [
    `Scenario ${scenario.id}: ${scenario.title}`,
    `- Input: ${scenario.input || '(none)'}`,
    '- Steps:',
    steps,
    `- Expected output: ${scenario.expectedOutput || '(unspecified)'}`,
  ];
  if (scenario.confirmation) {
    lines.push(`- Must confirm first: ${scenario.confirmation}`);
  }
  return lines.join('\n');
}

/** Render the tester prompt for one group of scenarios. */
export function buildTesterPrompt(
  template: string,
  input: {
    featureInfo: string;
    setupInfo: string;
    scenarios: BugBashScenario[];
  },
): string {
  return applyTemplate(template, {
    featureInfo: input.featureInfo.trim(),
    setupInfo: input.setupInfo.trim() || NO_SETUP_MARKER,
    scenarios: input.scenarios.map(renderScenario).join('\n\n'),
  });
}

/** Render one scenario's result as a labelled block for the report prompt. */
export function renderResult(scenario: BugBashScenario): string {
  return [
    `Scenario ${scenario.id}: ${scenario.title}`,
    `- Status: ${scenario.status}`,
    `- Observations: ${scenario.observations || '(none reported)'}`,
  ].join('\n');
}

/** Render the lead report prompt from the run scenarios. */
export function buildReportPrompt(
  template: string,
  input: { featureInfo: string; scenarios: BugBashScenario[] },
): string {
  return applyTemplate(template, {
    featureInfo: input.featureInfo.trim(),
    results: input.scenarios.map(renderResult).join('\n\n'),
  });
}

/**
 * Compile a plain deterministic report from scenario results, used as a fallback
 * when the lead's report turn returns nothing so a run always yields a report.
 */
export function summarizeResults(scenarios: BugBashScenario[]): string {
  const passed = scenarios.filter((s) => s.status === 'pass');
  const failed = scenarios.filter((s) => s.status === 'fail');
  const blocked = scenarios.filter((s) => s.status === 'blocked');
  const lines: string[] = [
    '## Summary',
    `Ran ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}: ` +
      `${passed.length} passed, ${failed.length} failed, ${blocked.length} blocked.`,
  ];
  if (failed.length > 0) {
    lines.push('', '## Bugs found');
    for (const s of failed) {
      lines.push(`- ${s.title}: ${s.observations || '(no details)'}`);
    }
  }
  if (blocked.length > 0) {
    lines.push('', '## Blocked');
    for (const s of blocked) {
      lines.push(`- ${s.title}: ${s.observations || '(no details)'}`);
    }
  }
  if (passed.length > 0) {
    lines.push('', '## Passed');
    for (const s of passed) {
      lines.push(`- ${s.title}`);
    }
  }
  return lines.join('\n');
}

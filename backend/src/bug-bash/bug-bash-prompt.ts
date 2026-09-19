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

import type {
  BugBashBlockedReason,
  BugBashScenario,
} from './bug-bash-contract.js';

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

/** Fallback text used when the user provides no extra information. */
export const NO_OTHER_MARKER = '(no additional information provided)';

/**
 * Focus injected when a generation turn is not scoped to a specific area (e.g.
 * the deterministic single-analyst fallback), telling the analyst to cover the
 * whole feature.
 */
export const WHOLE_FEATURE_FOCUS = 'the entire feature, end to end';

/**
 * The default decomposition prompt for the lead analyst. It divides the feature
 * into disjoint focus areas so separate analyst sub-agents can design scenarios
 * for each in parallel. Placeholders: {{featureInfo}}, {{setupInfo}},
 * {{maxAreas}}.
 */
export const DEFAULT_DECOMPOSE_PROMPT_TEMPLATE = [
  'You are the lead QA analyst planning a bug bash for a feature. Read the',
  'feature description, the setup information, and the ACTUAL code in the current',
  'working directory. Do NOT modify any files.',
  '',
  'Feature information:',
  '{{featureInfo}}',
  '',
  'Setup information (documentation, sample programs, how to run/test it):',
  '{{setupInfo}}',
  '',
  'Divide the testing surface of this feature into at most {{maxAreas}} distinct',
  'focus areas so separate analysts can design edge-case scenarios for each in',
  'parallel WITHOUT overlap. Each area should be a cohesive slice of behaviour —',
  'a code path, an input class, a configuration, an integration, or a failure',
  'mode — grounded in what the code actually does. Prefer fewer, meatier areas',
  'over many thin ones.',
  '',
  'Respond with ONLY a JSON object in a ```json code block, no prose, shaped:',
  '{"areas":[{',
  '"title":"short area name",',
  '"focus":"what to probe in this area and why it is likely to break"',
  '}]}',
].join('\n');

/**
 * The default scenario-generation prompt for an analyst. Placeholders:
 * {{featureInfo}}, {{setupInfo}}, {{focus}}.
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
  'Your assigned focus area (other analysts cover the rest — stay within yours):',
  '{{focus}}',
  '',
  'Investigate the code paths that implement this feature and design test',
  'scenarios that are most likely to BREAK it within your focus area. Focus on',
  'edge cases: boundary values, empty/malformed input, concurrency, error',
  'handling, unusual configurations, and interactions the happy path ignores.',
  'Ground every scenario in behaviour the code actually has.',
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
  'bug: it did not), or "blocked" (could not run it). Set "ran" to true ONLY when',
  'you actually executed the steps; false when you could not attempt them. Record',
  'the concrete "actualOutput" you observed, keep "observations" as a concise note',
  '(for a failure, why it is a bug). A "pass" or "fail" MUST be backed by evidence',
  '— a concrete "actualOutput" and/or "diagnostics"; a verdict with neither is',
  'treated as NOT actually run, so never claim a pass you did not really execute.',
  'When a scenario is blocked, categorise it with',
  '"blockedReason": "permission" (you lacked access/rights/credentials), or one of',
  '"environment" (setup/config missing), "tooling" (a required tool was absent), or',
  '"other". Put any commands run, logs, errors, or telemetry in "diagnostics". For',
  'every scenario you actually ran, also produce a "reproScript": a self-contained,',
  'runnable script or code snippet (bash/PowerShell/HTTP/program code as fits the',
  'feature) a developer can execute locally to reproduce the scenario and confirm',
  'the same result — include the exact input, the command(s), and how to check the',
  'expected vs actual output. Record every identifier, GUID, ActivityId, status',
  'code, path, and value IN FULL — never abbreviate, shorten, or elide with "…" or',
  '"..."; a developer must be able to copy the exact value. Do NOT modify source',
  'files to make a scenario pass.',
  '',
  'Respond with ONLY a JSON object in a ```json code block, no prose, shaped:',
  '{"results":[{"id":"<scenario id>","status":"pass","ran":true,',
  '"actualOutput":"what actually happened","observations":"concise note",',
  '"blockedReason":"permission|environment|tooling|other (only when blocked)",',
  '"diagnostics":"commands run, logs, errors, telemetry",',
  '"reproScript":"a runnable script/code a developer can run locally to reproduce it"}]}',
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
  '- "## Blocked — needs access": a bullet per scenario blocked on permission',
  '  (missing access/rights/credentials) and exactly what access was missing.',
  '  Omit when none were blocked on access.',
  '- "## Blocked — could not run": a bullet per scenario blocked for a',
  '  non-permission reason (environment, tooling, or other) and what was missing.',
  '  Omit when none apply.',
  '- "## Passed": a short bullet list of what worked.',
  '- "## Evidence audit": a bullet per scenario whose pass/fail verdict is missing',
  '  evidence (see each scenario\'s "Evidence gaps" line) naming exactly what is',
  '  absent — actual output, diagnostics/logs, or a repro script — so gaps are not',
  '  hidden behind a green result. Omit the section only when every verdict is',
  '  fully evidenced.',
  '- "## Scenario details": a subsection (### <scenario title>) for EVERY',
  '  scenario, each stating its status (pass/fail/blocked), whether it actually',
  '  ran, the exact steps to replicate it, the expected output, the actual output',
  '  observed, and the repro script a developer can run locally when one was',
  '  produced. This is the reproducible record the owner uses to act on each',
  '  result.',
  'Be concise and specific. Do not invent results that were not reported.',
].join('\n');

/**
 * The default prerequisites prompt. It asks the analyst to read the feature
 * description, the setup/other information, and the ACTUAL code, then identify
 * the concrete information it still needs from the user for the bug bash
 * scenarios to actually run (access, endpoints, credentials, sample data,
 * environment, configuration, etc.). The questions are always derived from the
 * specific feature — never a fixed checklist. Placeholders: {{featureInfo}},
 * {{setupInfo}}, {{otherInfo}}.
 */
export const DEFAULT_PREREQUISITES_PROMPT_TEMPLATE = [
  'You are the lead QA analyst preparing a bug bash for a feature. Before any',
  'scenarios are designed, determine what information you need from the user for',
  'the scenarios to ACTUALLY run and be verifiable end to end. Read the feature',
  'description, the setup information, the additional information, and the ACTUAL',
  'code in the current working directory. Do NOT modify any files.',
  '',
  'Feature information:',
  '{{featureInfo}}',
  '',
  'Setup information (documentation, sample programs, how to run/test it):',
  '{{setupInfo}}',
  '',
  'Additional information:',
  '{{otherInfo}}',
  '',
  'Identify the specific, concrete pieces of information still MISSING that a',
  'tester needs to exercise this feature — e.g. access/credentials, endpoints/',
  'connection strings, sample data or accounts, required environment/config,',
  'feature flags, or how to observe results. Ask only what genuinely blocks a',
  'real run, and never ask about anything already provided above.',
  '',
  'ALWAYS validate permissions and packages explicitly. From the code and the',
  'description work out which permissions/access rights (roles, scopes,',
  'credentials, account access) and which packages/dependencies/tools (SDKs,',
  'CLIs, runtimes, libraries) the tester must have to run this feature. For each',
  'one, check whether the information above already confirms it is available. If',
  'a required permission, package, tool, or dependency is NOT already confirmed',
  'above, add an explicit question asking whether the user has it (or can grant/',
  'install it) — do NOT assume it is present. Name the exact permission or',
  'package in the question and offer ["Yes","No"] options where it is a',
  'have-it-or-not check.',
  '',
  'Write each question so it is EFFORTLESS to answer. Follow these rules strictly:',
  '- Ask for exactly ONE piece of information per question. Never combine two',
  '  asks (no "and"/"or" that hides a second question); split them instead.',
  '- Keep the question to a single short sentence (aim for 20 words or fewer).',
  '  Put no background, justification, or code references in the question text.',
  '- Be concrete and specific: name the exact value, path, account, or setting',
  '  you need, so the user can answer in a few words.',
  '- Whenever a small, known set of likely answers exists, provide them as',
  '  "options" so the user can just pick one instead of typing. Options must be',
  '  short (a few words each). Include options for yes/no questions',
  '  (["Yes","No"]) and for clear enumerations. Leave "options" empty ONLY when',
  '  the answer is genuinely open-ended (e.g. a path, URL, or free-text value).',
  '- Put the short reason it is needed in "detail" (one line), NOT in the',
  '  question.',
  '',
  'Prefer a few high-value questions over many trivial ones. If nothing is',
  'missing, return an empty list.',
  '',
  'Respond with ONLY a JSON object in a ```json code block, no prose, shaped:',
  '{"prerequisites":[{',
  '"question":"one concise, single-fact question",',
  '"detail":"one short line on why it is needed",',
  '"options":["short option","short option"]',
  '}]}',
  'Use an empty array for "options" when the answer is open-ended.',
].join('\n');

/** Render the analyst scenario-generation prompt from the user's inputs. */
export function buildGeneratePrompt(
  template: string,
  input: { featureInfo: string; setupInfo: string; focus?: string },
): string {
  return applyTemplate(template, {
    featureInfo: input.featureInfo.trim(),
    setupInfo: input.setupInfo.trim() || NO_SETUP_MARKER,
    focus: input.focus?.trim() || WHOLE_FEATURE_FOCUS,
  });
}

/** Render the prerequisites-identification prompt from the user's inputs. */
export function buildPrerequisitesPrompt(
  template: string,
  input: { featureInfo: string; setupInfo: string; otherInfo: string },
): string {
  return applyTemplate(template, {
    featureInfo: input.featureInfo.trim(),
    setupInfo: input.setupInfo.trim() || NO_SETUP_MARKER,
    otherInfo: input.otherInfo.trim() || NO_OTHER_MARKER,
  });
}
export function buildDecomposePrompt(
  template: string,
  input: { featureInfo: string; setupInfo: string; maxAreas: number },
): string {
  return applyTemplate(template, {
    featureInfo: input.featureInfo.trim(),
    setupInfo: input.setupInfo.trim() || NO_SETUP_MARKER,
    maxAreas: String(input.maxAreas),
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

/** Human-readable label for each blocked-reason category. */
export const BLOCKED_REASON_LABEL: Record<BugBashBlockedReason, string> = {
  permission: 'needs access',
  environment: 'environment not ready',
  tooling: 'tooling missing',
  other: 'could not run',
};

/** Render one scenario's result as a labelled block for the report prompt. */
export function renderResult(scenario: BugBashScenario): string {
  const steps =
    scenario.steps.length > 0
      ? scenario.steps.map((step, index) => `  ${index + 1}. ${step}`).join('\n')
      : '  (no steps provided)';
  const lines = [
    `Scenario ${scenario.id}: ${scenario.title}`,
    `- Status: ${scenario.status}`,
    `- Actually ran: ${scenario.ran ? 'yes' : 'no'}`,
  ];
  if (scenario.status === 'blocked' && scenario.blockedReason) {
    lines.push(
      `- Blocked reason: ${scenario.blockedReason} (${BLOCKED_REASON_LABEL[scenario.blockedReason]})`,
    );
  }
  lines.push(
    `- Input: ${scenario.input || '(none)'}`,
    '- Steps to replicate:',
    steps,
    `- Expected output: ${scenario.expectedOutput || '(unspecified)'}`,
    `- Actual output: ${scenario.actualOutput || '(none reported)'}`,
    `- Observations: ${scenario.observations || '(none reported)'}`,
  );
  if (scenario.diagnostics) {
    lines.push(`- Diagnostics: ${scenario.diagnostics}`);
  }
  if (scenario.reproScript) {
    lines.push(`- Repro script:\n${scenario.reproScript}`);
  }
  if (scenario.evidenceGaps.length > 0) {
    lines.push(`- Evidence gaps: missing ${scenario.evidenceGaps.join(', ')}`);
  }
  return lines.join('\n');
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
  const blockedAccess = blocked.filter((s) => s.blockedReason === 'permission');
  const blockedOther = blocked.filter((s) => s.blockedReason !== 'permission');
  const ranCount = scenarios.filter((s) => s.ran).length;
  const lines: string[] = [
    '## Summary',
    `Ran ${ranCount} of ${scenarios.length} scenario` +
      `${scenarios.length === 1 ? '' : 's'}: ${passed.length} passed, ` +
      `${failed.length} failed, ${blocked.length} blocked ` +
      `(${blockedAccess.length} needing access).`,
  ];
  if (failed.length > 0) {
    lines.push('', '## Bugs found');
    for (const s of failed) {
      lines.push(`- ${s.title}: ${s.observations || '(no details)'}`);
    }
  }
  if (blockedAccess.length > 0) {
    lines.push('', '## Blocked — needs access');
    for (const s of blockedAccess) {
      lines.push(`- ${s.title}: ${s.observations || '(no details)'}`);
    }
  }
  if (blockedOther.length > 0) {
    lines.push('', '## Blocked — could not run');
    for (const s of blockedOther) {
      const reason = s.blockedReason
        ? ` [${BLOCKED_REASON_LABEL[s.blockedReason]}]`
        : '';
      lines.push(`- ${s.title}${reason}: ${s.observations || '(no details)'}`);
    }
  }
  if (passed.length > 0) {
    lines.push('', '## Passed');
    for (const s of passed) {
      lines.push(`- ${s.title}`);
    }
  }
  const withGaps = scenarios.filter((s) => s.evidenceGaps.length > 0);
  if (withGaps.length > 0) {
    lines.push('', '## Evidence audit');
    for (const s of withGaps) {
      lines.push(`- ${s.title}: missing ${s.evidenceGaps.join(', ')}`);
    }
  }
  lines.push('', '## Scenario details');
  for (const s of scenarios) {
    const steps =
      s.steps.length > 0
        ? s.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')
        : '(no steps provided)';
    lines.push(
      '',
      `### ${s.title}`,
      `- Status: ${s.status}${s.ran ? '' : ' (not run)'}`,
      `- Input: ${s.input || '(none)'}`,
      '- Steps to replicate:',
      steps,
      `- Expected output: ${s.expectedOutput || '(unspecified)'}`,
      `- Actual output: ${s.actualOutput || '(none reported)'}`,
      `- Observations: ${s.observations || '(none reported)'}`,
    );
    if (s.reproScript) {
      lines.push('- Repro script:', '```', s.reproScript, '```');
    }
    if (s.evidenceGaps.length > 0) {
      lines.push(`- Evidence gaps: missing ${s.evidenceGaps.join(', ')}`);
    }
  }
  return lines.join('\n');
}

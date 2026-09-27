/**
 * The per-perspective, three-part prompt system for the Review Board.
 *
 * Every review lens is assembled from three independently configurable
 * sections plus one fixed machine-readable response envelope:
 *
 *   1. Common guidance   — shared across every lens: how to review, be concise,
 *                          stay grounded in the changed code, and which
 *                          languages/config formats to expect. Carries the PR
 *                          context placeholders.
 *   2. Perspective focus — what THIS lens must dig into, tied to the change.
 *   3. Issue format      — how findings/rationale for THIS lens should read so
 *                          the result is concise and paste-ready as a comment.
 *
 * Sections 1–3 are user-editable from the Review Board agent settings (each is
 * a `reviewBoard.*` config field). The response envelope is fixed so the parser
 * contract can never be broken by an edit.
 *
 * Kept pure (no provider, no config import) so the 100% coverage gate can
 * exercise every branch and so `config.ts` can import the defaults without a
 * cycle.
 */

/** The complete, fixed universe of review lenses the board can render. */
export const REVIEW_PERSPECTIVE_IDS = [
  'problem-solution',
  'architecture',
  'impact-blast-radius',
  'code-quality',
  'performance',
  'observability',
  'configuration',
  'api-contract',
  'accessibility',
  'backward-compatibility',
  'data-contract',
  'rollback-safety',
  'deployment',
  'testing',
  'security',
  'final-decision',
] as const;

/** One of the board's fixed lens ids. */
export type ReviewPerspectiveId = (typeof REVIEW_PERSPECTIVE_IDS)[number];

/** The two `reviewBoard.*` config keys that back one lens' editable prompt. */
export interface PerspectiveConfigKeys {
  focus: string;
  issueFormat: string;
}

/**
 * Maps each lens id to the flat `reviewBoard` config keys that hold its focus
 * and issue-format sections. Flat keys (not a nested object) so each is a
 * single editable string field in the agent settings.
 */
export const PERSPECTIVE_CONFIG_KEYS: Record<
  ReviewPerspectiveId,
  PerspectiveConfigKeys
> = {
  'problem-solution': {
    focus: 'problemSolutionFocus',
    issueFormat: 'problemSolutionIssueFormat',
  },
  architecture: {
    focus: 'architectureFocus',
    issueFormat: 'architectureIssueFormat',
  },
  'impact-blast-radius': {
    focus: 'impactBlastRadiusFocus',
    issueFormat: 'impactBlastRadiusIssueFormat',
  },
  'code-quality': {
    focus: 'codeQualityFocus',
    issueFormat: 'codeQualityIssueFormat',
  },
  performance: {
    focus: 'performanceFocus',
    issueFormat: 'performanceIssueFormat',
  },
  observability: {
    focus: 'observabilityFocus',
    issueFormat: 'observabilityIssueFormat',
  },
  configuration: {
    focus: 'configurationFocus',
    issueFormat: 'configurationIssueFormat',
  },
  'api-contract': {
    focus: 'apiContractFocus',
    issueFormat: 'apiContractIssueFormat',
  },
  accessibility: {
    focus: 'accessibilityFocus',
    issueFormat: 'accessibilityIssueFormat',
  },
  'backward-compatibility': {
    focus: 'backwardCompatibilityFocus',
    issueFormat: 'backwardCompatibilityIssueFormat',
  },
  'data-contract': {
    focus: 'dataContractFocus',
    issueFormat: 'dataContractIssueFormat',
  },
  'rollback-safety': {
    focus: 'rollbackSafetyFocus',
    issueFormat: 'rollbackSafetyIssueFormat',
  },
  deployment: {
    focus: 'deploymentFocus',
    issueFormat: 'deploymentIssueFormat',
  },
  testing: {
    focus: 'testingFocus',
    issueFormat: 'testingIssueFormat',
  },
  security: {
    focus: 'securityFocus',
    issueFormat: 'securityIssueFormat',
  },
  'final-decision': {
    focus: 'finalDecisionFocus',
    issueFormat: 'finalDecisionIssueFormat',
  },
};

/** Human-readable display name for each lens, used to label its settings. */
export const PERSPECTIVE_LABELS: Record<ReviewPerspectiveId, string> = {
  'problem-solution': 'Problem ↔ Solution',
  architecture: 'Architecture & Code Flow',
  'impact-blast-radius': 'Impact & Blast Radius',
  'code-quality': 'Code Quality',
  performance: 'Performance',
  observability: 'Observability',
  configuration: 'Configuration',
  'api-contract': 'API / Contract Impact',
  accessibility: 'Accessibility',
  'backward-compatibility': 'Backward Compatibility',
  'data-contract': 'Data Contract & Schema',
  'rollback-safety': 'Rollback Safety',
  deployment: 'Deployment & Rollout',
  testing: 'Testing',
  security: 'Security',
  'final-decision': 'Final Decision',
};

/** The PR-evidence placeholders every perspective focus section can use. */
export const COMMON_PROMPT_PLACEHOLDERS = [
  'lensName',
  'lensPurpose',
  'prNumber',
  'prTitle',
  'baseBranch',
  'filesChanged',
  'description',
  'modelDigest',
  'changedFiles',
] as const;

/**
 * Section 1 — shared review guidance. Placeholders are filled at run time with
 * the concrete PR evidence. Deliberately language-agnostic: it names the
 * primary languages/config formats but tells the model to apply whatever the
 * changed file actually uses.
 */
export const DEFAULT_COMMON_REVIEW_GUIDANCE = [
  'You are a senior staff engineer reviewing ONE pull request through a single',
  'named lens. Work only from the evidence below — never guess about code you',
  'were not shown, and never restate generic best practices.',
  '',
  'How to review:',
  '- Be concise and direct. No preamble, no filler, no lecturing. Short, plain',
  '  sentences a busy engineer can act on immediately.',
  '- Go deep on THIS lens only; ignore concerns that belong to another lens.',
  '- Tie every observation to a specific changed file and, where you can, the',
  '  exact symbol/region. An observation you cannot ground in a listed file is',
  '  invalid — leave it out.',
  '- The change may be in C#, C++, or Java (primary), another language, or in',
  '  configuration such as XML, YAML, JSON, .props/.csproj, Gradle/Maven, or',
  '  shell. Apply the idioms, tooling and failure modes of whatever language or',
  '  format each changed file actually uses.',
  '',
  '## Review lens: {{lensName}}',
  'Purpose: {{lensPurpose}}',
  '',
  '## Pull request',
  '- Number: #{{prNumber}}',
  '- Title: {{prTitle}}',
  '- Base branch: {{baseBranch}}',
  '- Files changed: {{filesChanged}}',
  '',
  '## Description',
  '{{description}}',
  '',
  '## Derived project model',
  '{{modelDigest}}',
  '',
  '## Changed files',
  '{{changedFiles}}',
].join('\n');

/**
 * The fixed machine-readable response contract, appended after the three
 * editable sections. NOT user-editable: this is the exact shape the parser
 * consumes, so keeping it out of the configurable sections means an edit can
 * change the review's emphasis but never break parsing.
 */
export const RESPONSE_ENVELOPE = [
  '## Response format',
  'Include evidence "location": { "path": "<repo-relative path>", "line": 1,',
  '  "side": "RIGHT" | "LEFT" } ONLY when exact coordinates are known from the captured diff.',
  'Use a positive 1-based line on that side. Keep "source" as the human-readable citation.',
  'If coordinates are unknown, set "location" to null or omit it. Never invent coordinates',
  'or derive a line from a symbol name, file ordering, or a summary. Deletions belong on LEFT.',
  'Reply with ONLY a fenced ```json code block containing a single object:',
  '{',
  '  "skipped": boolean — true only if this lens genuinely does not apply,',
  '  "reason": string — required when skipped: one sentence why it does not',
  '    apply,',
  '  "summary": string — one or two concrete sentences naming what you',
  '    inspected and the verdict; no generic phrasing,',
  '  "rationale": [ { "label": string, "detail": string } ] — the',
  '    evidence-backed reasoning behind the verdict, using the labels this',
  "    lens' issue-format section asked for; every detail references a concrete",
  '    file/symbol,',
  '  "checks": [ { "item": string, "finding": string,',
  '    "status": "pass" | "concern" | "na" } ] — the audit trail this lens',
  '    asked for (leave empty only when the lens explicitly says to),',
  '  "findings": [ {',
  '    "title": short imperative headline naming the affected file/symbol,',
  '    "detail": the concise, paste-ready comment — the problem, its exact',
  '      location (file + symbol), and the concrete fix, in as few words as',
  '      make it actionable,',
  '    "severity": "critical" | "high" | "medium" | "low" | "suggestion",',
  '    "evidence": [ { "source": "<path> — <symbol/region>", "reason": how this',
  '      specific code demonstrates the finding, "confidence": 0..1 } ]',
  '  } ]',
  '}',
  'Return an empty "findings" array when the change is clean for this lens, but',
  'still fill "summary", "rationale" and "checks" with the concrete evidence you',
  'based that verdict on. Never assume "green". Do not add any prose outside the',
  'code block.',
].join('\n');

/** Section 2 + Section 3 defaults for one lens. */
export interface PerspectivePromptParts {
  /** Section 2 — what this lens digs into, tied to the change. */
  focus: string;
  /** Section 3 — how this lens' findings/rationale should read. */
  issueFormat: string;
}

function lines(...parts: string[]): string {
  return parts.join('\n');
}

/**
 * Hand-authored Section 2/3 defaults for every lens. Each focus is specific to
 * the lens and pushes the model to dig into the actual change; each issue
 * format sets the rationale labels and the tone/precision of findings so the
 * output is concise and directly usable.
 */
export const DEFAULT_PERSPECTIVE_PROMPTS: Record<
  ReviewPerspectiveId,
  PerspectivePromptParts
> = {
  'problem-solution': {
    focus: lines(
      '## Focus for this lens — Problem ↔ Solution',
      'Decide one thing: does this change actually solve the problem it set out',
      'to solve? Judge the change as a whole — do NOT grade files one by one.',
      '',
      'The problem this PR targets (from the description + any linked work item):',
      '{{distilledProblem}}',
      '',
      'What the PR implements (synthesize the approach, do not list files):',
      '{{solutionDigest}}',
      '',
      'Weigh the solution against the problem: does it fully address the stated',
      'need? Call out every unaddressed requirement, scope gap, or mismatch —',
      'that reasoning is what the reader needs most.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Use EXACTLY these four rationale labels, in order: "Problem",',
      '"Solution implemented", "Why they align", "Verdict". Keep each to one or',
      'two plain sentences — no file-by-file grading, no jargon dump.',
      'Leave "checks" empty: this lens is holistic, not line-by-line.',
      'File one finding per real gap where the solution fails to solve the',
      'problem (empty when it fully solves it); the finding names the unmet need',
      'and what is missing to close it.',
    ),
  },
  architecture: {
    focus: lines(
      '## Focus for this lens — Architecture & Code Flow',
      'Trace how control and data actually flow through the changed code and',
      'confirm the change fits the existing structure and boundaries. Dig into:',
      '- Dependencies that now cross a module/layer boundary the wrong way.',
      '- Responsibilities placed in the wrong component; leaked or duplicated',
      '  logic; abstractions that no longer hold.',
      '- Control/data-flow changes that break an existing invariant or contract.',
      'Name the entry point the PR touched and follow it through the symbols it',
      'changed — do not review in the abstract.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Flow" (the path you traced), "Fit" (how it sits in',
      'the existing structure), "Verdict". Each finding names the boundary or',
      'invariant broken, the file/symbol where, and the structural fix — not a',
      'style nit. Reserve high/critical for a broken boundary or invariant.',
    ),
  },
  'impact-blast-radius': {
    focus: lines(
      '## Focus for this lens — Impact & Blast Radius',
      'Map everything this change can reach before it is approved. Dig into:',
      '- Callers/dependents of every changed symbol, and cross-module effects.',
      '- Shared state, configuration, and runtime areas the change perturbs.',
      '- Behaviour changes that ripple beyond the edited file.',
      'Follow the change outward from each touched symbol to what depends on it.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Reach" (what the change touches), "Unhandled effect",',
      '"Verdict". Each finding names a specific downstream file/symbol put at',
      'risk and the concrete guard or test needed. Severity scales with how many',
      'consumers are affected and how silently they break.',
    ),
  },
  'code-quality': {
    focus: lines(
      '## Focus for this lens — Code Quality',
      'Assess readability and maintainability of the changed code. Dig into:',
      '- Naming, structure, and duplication introduced by the change.',
      '- Dead code, unclear control flow, and unclear or swallowed error paths.',
      '- Complexity that a smaller, clearer form would remove.',
      'Judge only what the PR changed, not pre-existing code around it.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Strengths", "Concerns", "Verdict". Keep findings small',
      'and directly actionable, each naming the file/symbol and the concrete',
      'improvement. Most items here are "low" or "suggestion"; only raise higher',
      'when clarity problems risk real defects.',
    ),
  },
  performance: {
    focus: lines(
      '## Focus for this lens — Performance',
      'Judge latency and throughput impact of the change. Dig into:',
      '- Added allocations, copies, or boxing on hot paths.',
      '- N+1 access, repeated work in loops, or avoidable synchronous I/O.',
      '- Blocking/sync-over-async, lock contention, and algorithmic complexity',
      '  changes (call out Big-O where it shifts).',
      'Tie each concern to the specific changed loop/call, not a general worry.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Hot path", "Cost", "Verdict". Quantify where you can',
      '(complexity, per-call cost, allocation count). Each finding names the',
      'file/symbol, the cost it adds, and the cheaper approach. Severity scales',
      'with how hot the path is and the size of the regression.',
    ),
  },
  observability: {
    focus: lines(
      '## Focus for this lens — Observability',
      'Judge how diagnosable the changed behaviour is in production. Dig into:',
      '- New or changed failure paths that log/emit nothing.',
      '- Missing metrics/traces for a new operation, or lost context on errors.',
      '- Log levels/messages that would mislead an on-call engineer.',
      'Point at the specific changed path that would be dark during an incident.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Signals present", "Gaps", "Verdict". Each finding',
      'names the unlogged failure path or missing metric (file/symbol) and the',
      'concrete signal to add. Reserve higher severity for silent failures on',
      'critical paths.',
    ),
  },
  configuration: {
    focus: lines(
      '## Focus for this lens — Configuration',
      'Judge the correctness and safety of configuration the change touches',
      '(XML, YAML, JSON, .props/.csproj, Gradle/Maven, env, feature flags).',
      'Dig into:',
      '- New keys without a safe default or validation.',
      '- Schema/format errors, wrong types, or environment-specific values',
      '  hardcoded where they should be injected.',
      '- Backward compatibility of config consumers when a key changes.',
      'Name the exact config file and key.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Keys touched", "Risks", "Verdict". Each finding names',
      'the config file + key, the concrete problem (missing default, invalid',
      'schema, breaking change), and the fix. Severity scales with production',
      'blast radius of a mis-set value.',
    ),
  },
  'api-contract': {
    focus: lines(
      '## Focus for this lens — API / Contract Impact',
      'Judge whether the change alters a public or internal contract. Dig into:',
      '- Changed signatures, return types, nullability, or thrown errors.',
      '- Serialization/wire shape, status codes, and versioned surfaces.',
      '- Semantic behaviour changes behind an unchanged signature.',
      'For each, decide breaking vs non-breaking and who consumes it.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Contract surface", "Compatibility", "Verdict". Each',
      'finding marks the change BREAKING or NON-BREAKING, names the symbol and',
      'the affected consumer, and gives the migration or versioning step.',
      'Breaking changes to a published surface are at least "high".',
    ),
  },
  accessibility: {
    focus: lines(
      '## Focus for this lens — Accessibility',
      'Judge whether UI the change touches stays usable for everyone. Dig into:',
      '- Semantics/roles, labels and alt text, and programmatic name/state.',
      '- Keyboard operability and focus order for new/changed controls.',
      '- Colour contrast and non-text cues.',
      'Point at the specific changed element/component.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Checked", "Barriers", "Verdict". Each finding names',
      'the element/component, the barrier (with the WCAG idea in plain terms),',
      'and the concrete fix. Severity scales with how completely it blocks a',
      'user of assistive tech.',
    ),
  },
  'backward-compatibility': {
    focus: lines(
      '## Focus for this lens — Backward Compatibility',
      'Judge whether existing consumers of this library/SDK keep working. Dig',
      'into:',
      '- Removed, renamed, or re-typed public surface.',
      '- Behavioural changes behind an unchanged signature.',
      '- Default changes that silently alter existing callers.',
      'Assume real downstream code depends on today\u2019s behaviour.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Public surface", "Breakage", "Verdict". Each finding',
      'marks BREAKING vs SAFE, names the symbol and the consumer scenario that',
      'breaks, and the migration note or deprecation path. A silent behavioural',
      'break is at least "high".',
    ),
  },
  'data-contract': {
    focus: lines(
      '## Focus for this lens — Data Contract & Schema',
      'Judge schema and data-contract compatibility for the change. Dig into:',
      '- Added/removed/renamed fields, type or nullability changes.',
      '- Forward/backward compatibility for already-persisted or in-flight data.',
      '- Missing or unsafe migrations and serialization mismatches.',
      'Name the exact schema/field and the data that already exists in the wild.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Schema change", "Compatibility", "Verdict". Each',
      'finding names the field/schema, whether old and new data still read',
      'correctly, and the migration required. Data loss or unreadable existing',
      'records is "critical".',
    ),
  },
  'rollback-safety': {
    focus: lines(
      '## Focus for this lens — Rollback Safety',
      'Judge whether the change can be safely reverted. Dig into:',
      '- Destructive or irreversible operations (drops, deletes, in-place',
      '  rewrites) in the changed infrastructure/state.',
      '- Forward-only migrations with no down path.',
      '- Ordering that leaves the system wedged if rolled back midway.',
      'Name the specific resource/operation that blocks a clean rollback.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Reversibility", "Hazards", "Verdict". Each finding',
      'names the irreversible/destructive change (file/resource) and the safe',
      'rollback path it needs. An unrecoverable step is at least "high".',
    ),
  },
  deployment: {
    focus: lines(
      '## Focus for this lens — Deployment & Rollout',
      'Judge how safely the change reaches production. Dig into:',
      '- Rollout ordering, migrations run before/after code, and zero-downtime',
      '  needs.',
      '- Feature-flag gating and safe defaults during a partial rollout.',
      '- Environment/config drift the change assumes but does not provision.',
      'Name the specific sequencing or flag requirement.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Rollout path", "Risks", "Verdict". Each finding names',
      'the deployment hazard (file/step), the sequencing or flag it requires,',
      'and what breaks without it. Anything that risks downtime is at least',
      '"high".',
    ),
  },
  testing: {
    focus: lines(
      '## Focus for this lens — Testing',
      'Judge whether the change is adequately tested. Dig into:',
      '- New or changed branches/paths with no covering test.',
      '- Edge cases, error paths, and boundaries left unexercised.',
      '- Weak assertions or tests that would pass even if the code regressed.',
      'Name the specific changed symbol/branch that lacks a real test.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Coverage", "Gaps", "Verdict". Each finding names the',
      'untested symbol/branch (file) and the specific test to add, including the',
      'case it must assert. Severity scales with how likely the gap hides a',
      'defect on a critical path.',
    ),
  },
  security: {
    focus: lines(
      '## Focus for this lens — Security',
      'Judge the security impact of the change. Dig into:',
      '- Untrusted input reaching a sensitive sink (injection, path traversal,',
      '  command/SQL, unsafe deserialization).',
      '- AuthN/AuthZ gaps, missing validation, and secrets or sensitive data in',
      '  code/logs.',
      '- Unsafe crypto, SSRF, and resource-exhaustion vectors.',
      'Trace source \u2192 sink in the changed code; do not speculate beyond it.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Attack surface", "Findings", "Verdict". Each finding',
      'names the source and the sink (file/symbol), the concrete exploit it',
      'enables, and the fix. Severity follows exploitability and impact — a',
      'reachable injection or authz bypass is "critical" or "high".',
    ),
  },
  'final-decision': {
    focus: lines(
      '## Focus for this lens — Final Decision',
      'Synthesize the change into a single merge recommendation. Weigh the',
      'concrete risks visible in the diff and description: correctness,',
      'contract/data breaks, security, and test adequacy. This lens does not',
      'hunt new low-level nits — it decides whether the change is safe to merge',
      'and names any hard blocker that must be resolved first.',
    ),
    issueFormat: lines(
      '## How to report for this lens',
      'Rationale labels: "Blocking", "Non-blocking", "Decision". Keep "checks"',
      'empty. File a finding ONLY for a genuine merge blocker (name it and what',
      'must change); return an empty findings array when the change is mergeable',
      'as-is. The verdict must be a clear, one-line merge recommendation.',
    ),
  },
};

/**
 * Assemble a lens' full prompt from the three editable sections and the fixed
 * response envelope, then substitute the run-time PR evidence. Kept trivial and
 * pure: the caller owns which config strings and vars to pass, so a single code
 * path serves every lens.
 */
export function buildReviewPrompt(input: {
  common: string;
  focus: string;
  issueFormat: string;
  vars: Record<string, string>;
}): string {
  const assembled = [
    input.common,
    input.focus,
    input.issueFormat,
    RESPONSE_ENVELOPE,
  ].join('\n\n');
  let output = assembled;
  for (const [key, value] of Object.entries(input.vars)) {
    output = output.split(`{{${key}}}`).join(value);
  }
  return output;
}

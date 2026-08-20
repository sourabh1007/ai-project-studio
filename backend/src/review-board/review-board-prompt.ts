/**
 * Pure prompt builders for the AI layer of the Project Review Board.
 *
 * Two prompts are produced here, both fully derived from the change's evidence
 * (never hardcoded to a product/language/service): one asks the model to author
 * evidence-backed findings per perspective, the other powers the context-aware
 * review agent. Keeping them pure lets the 100% coverage gate exercise every
 * branch without invoking a provider.
 */

import type {
  ReviewBoard,
  ReviewBoardChatMessage,
  ReviewPerspective,
  ProjectModel,
} from './review-board-contract.js';

/** Truncate `value` to `max` characters with an ellipsis marker. */
function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** A compact, evidence-first digest of the derived project model. */
function modelDigest(model: ProjectModel): string {
  const languages = [...model.primaryLanguages, ...model.secondaryLanguages];
  const lines = [
    `Project type: ${model.projectType} (${Math.round(
      model.projectTypeConfidence * 100,
    )}% confidence)`,
    `Languages: ${languages.join(', ') || 'none detected'}`,
    `Deployment model: ${model.deploymentModel || 'none detected'}`,
    `Changed components (${model.changedComponents.length}): ${
      model.changedComponents.join(', ') || 'none'
    }`,
    `Blast-radius dimensions: ${model.blastRadiusDimensions.join(', ') || 'none'}`,
    `Configuration systems: ${
      model.configurationSystems.map((c) => c.name).join(', ') || 'none'
    }`,
    `Contracts: ${model.contracts.map((c) => c.name).join(', ') || 'none'}`,
    `Test signals: ${model.testSignals.map((t) => t.name).join(', ') || 'none'}`,
  ];
  return lines.join('\n');
}

/** The perspective menu the model must key its findings against. */
function perspectiveMenu(perspectives: ReviewPerspective[]): string {
  return perspectives
    .map((p) => `- ${p.id}: ${p.name} — ${p.why}`)
    .join('\n');
}

/** A bounded, enumerated list of the concrete files the change touched. */
function changedFilesDigest(paths: readonly string[], max: number): string {
  if (paths.length === 0) {
    return '(no changed files were resolved from the change graph)';
  }
  const shown = paths.slice(0, max);
  const lines = shown.map((p) => `- ${p}`);
  if (paths.length > shown.length) {
    lines.push(`- …and ${paths.length - shown.length} more changed file(s)`);
  }
  return lines.join('\n');
}

/** The evidence contract both finding prompts share, kept identical. */
const EVIDENCE_RULES: readonly string[] = [
  '## Rules — grounded, specific, no generic review',
  'Every finding MUST be tied to concrete changed code. A finding is invalid',
  'and must be omitted unless it satisfies ALL of the following:',
  '1. It names at least one specific file from "Changed files" (and, where you',
  '   can, the exact function/class/symbol or region within it) in the',
  '   evidence "source" — never cite "the code", "the change" or the PR as a',
  '   whole.',
  '2. The "detail" states three things explicitly: (a) the precise problem,',
  '   (b) WHERE it is (file + symbol), and (c) the concrete fix or the exact',
  '   thing to verify — not vague advice like "ensure proper error handling".',
  '3. The "reason" in each evidence entry explains how that specific file/symbol',
  '   demonstrates the problem, linking the change to its effect.',
  'Do not restate best practices, do not speculate about code you were not',
  'shown, and do not raise a finding you cannot pin to a listed file. If you',
  'cannot ground it in the evidence, leave it out.',
  '',
];

/**
 * Build the findings prompt. The model receives the derived project model, the
 * PR identity/description and the exact perspective ids it may use, and must
 * reply with a single fenced JSON array of findings — each keyed to one of the
 * given perspective ids and backed by at least one piece of evidence.
 */
export function buildFindingsPrompt(input: {
  board: ReviewBoard;
  description: string | null;
  changedPaths: readonly string[];
  config: { maxContextChars: number };
}): string {
  const { board } = input;
  const description = clamp(
    (input.description ?? '').trim() || '(no description provided)',
    input.config.maxContextChars,
  );
  const ids = board.perspectives.map((p) => p.id).join(', ');
  return [
    'You are a meticulous staff engineer reviewing a pull request. Produce',
    'concrete, evidence-backed review findings — never generic advice. Only',
    'raise a finding when the provided evidence supports it; if a perspective',
    'has nothing worth flagging, omit it.',
    '',
    '## Pull request',
    `- Number: #${board.pull.number}`,
    `- Title: ${board.pull.title}`,
    `- Base branch: ${board.baseBranch ?? 'unknown'}`,
    `- Files changed: ${board.changedFiles}`,
    '',
    '## Description',
    description,
    '',
    '## Derived project model',
    modelDigest(board.model),
    '',
    '## Changed files',
    changedFilesDigest(input.changedPaths, 80),
    '',
    '## Perspectives you may file findings under',
    perspectiveMenu(board.perspectives),
    '',
    ...EVIDENCE_RULES,
    '## Response format',
    'Reply with ONLY a fenced ```json code block containing an array of',
    'findings. Each finding is an object:',
    '{',
    `  "perspectiveId": one of [${ids}],`,
    '  "title": short imperative headline naming the affected file/symbol,',
    '  "detail": problem + exact location (file + symbol) + concrete fix,',
    '  "severity": one of "critical" | "high" | "medium" | "low" | "suggestion",',
    '  "evidence": [ { "source": "<path> — <symbol/region>", "reason": how this',
    '    specific code demonstrates the finding, "confidence": 0..1 } ]',
    '}',
    'Return an empty array [] if the change looks clean. Do not wrap the array',
    'in any other object and do not add prose outside the code block.',
  ].join('\n');
}

/**
 * Build the per-perspective findings prompt. The model reviews the change
 * through exactly one lens and either returns findings for it or explicitly
 * skips it with a reason (e.g. "no public contracts changed"). This drives the
 * board's live, per-perspective progress.
 */
export function buildPerspectivePrompt(input: {
  board: ReviewBoard;
  perspective: ReviewPerspective;
  description: string | null;
  changedPaths: readonly string[];
  config: { maxContextChars: number };
}): string {
  const { board, perspective } = input;
  const description = clamp(
    (input.description ?? '').trim() || '(no description provided)',
    input.config.maxContextChars,
  );
  return [
    'You are a meticulous staff engineer reviewing a pull request through ONE',
    'specific lens. Produce concrete, evidence-backed findings for this lens —',
    'never generic advice. If, and only if, this lens genuinely does not apply',
    'to the change, skip it and say why in one sentence.',
    '',
    `## Review lens: ${perspective.name}`,
    `Purpose: ${perspective.why}`,
    '',
    '## Pull request',
    `- Number: #${board.pull.number}`,
    `- Title: ${board.pull.title}`,
    `- Base branch: ${board.baseBranch ?? 'unknown'}`,
    `- Files changed: ${board.changedFiles}`,
    '',
    '## Description',
    description,
    '',
    '## Derived project model',
    modelDigest(board.model),
    '',
    '## Changed files',
    changedFilesDigest(input.changedPaths, 80),
    '',
    ...EVIDENCE_RULES,
    '## Response format',
    'Reply with ONLY a fenced ```json code block containing a single object:',
    '{',
    '  "skipped": boolean — true only if this lens does not apply,',
    '  "reason": string — required when skipped: why it does not apply,',
    '  "summary": string — REQUIRED whether or not you found issues: one or two',
    '    sentences stating exactly what you checked to reach this rating. Name the',
    '    specific files/symbols you inspected and what you verified about them. No',
    '    generic phrasing — it must be concrete enough that a reader can audit it,',
    '  "rationale": [ {  — REQUIRED: an ordered, evidence-backed narrative that',
    '      justifies the rating so a reader never has to assume the verdict.',
    '      Use labels natural to this lens. For a problem/solution lens use',
    '      exactly: "Problem", "Solution implemented", "Why they align",',
    '      "Verdict". Every detail MUST reference concrete code (file/symbol)',
    '      from the change — never a generic statement.',
    '    "label": the step label,',
    '    "detail": the concrete, code-referenced explanation for this step } ],',
    '  "checks": [ {  — REQUIRED: a line-by-line audit trail of what you actually',
    '      inspected. One entry per concrete thing you looked at.',
    '    "item": the specific file/symbol or aspect inspected (e.g. path — symbol),',
    '    "finding": what you observed there, in one concrete sentence,',
    '    "status": one of "pass" | "concern" | "na" } ],',
    '  "findings": [ {',
    '    "title": short imperative headline naming the affected file/symbol,',
    '    "detail": problem + exact location (file + symbol) + concrete fix,',
    '    "severity": one of "critical" | "high" | "medium" | "low" | "suggestion",',
    '    "evidence": [ { "source": "<path> — <symbol/region>", "reason": how this',
    '      specific code demonstrates the finding, "confidence": 0..1 } ]',
    '  } ]',
    '}',
    'When the lens applies but the change is clean, set skipped=false and return',
    'an empty findings array. Do not add prose outside the code block.',
  ].join('\n');
}
export function buildAgentChatPrompt(input: {
  board: ReviewBoard;
  perspective: ReviewPerspective | null;
  messages: ReviewBoardChatMessage[];
  config: { maxContextChars: number };
}): string {
  const { board, perspective, messages } = input;
  const focus = perspective
    ? [
        '',
        `## Focused perspective: ${perspective.name}`,
        `Why on the board: ${perspective.why}`,
        `Status: ${perspective.status} · Risk: ${perspective.risk}`,
        perspective.findings.length > 0
          ? `Findings:\n${perspective.findings
              .map((f) => `- [${f.severity}] ${f.title}: ${f.detail}`)
              .join('\n')}`
          : 'Findings: none recorded yet.',
      ].join('\n')
    : '';
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
  return clamp(
    [
      'You are the Engineering Review Agent for a pull request review board.',
      'Answer the user precisely and cite the evidence you rely on. If asked to',
      'draft a PR comment, produce ready-to-paste text. Keep answers focused.',
      '',
      '## Pull request',
      `- Number: #${board.pull.number}`,
      `- Title: ${board.pull.title}`,
      `- Recommendation so far: ${board.recommendation}`,
      `- Open findings: ${board.summary.open} (${board.summary.blocking} blocking)`,
      '',
      '## Derived project model',
      modelDigest(board.model),
      focus,
      '',
      '## Conversation',
      transcript,
      '',
      'Assistant:',
    ].join('\n'),
    input.config.maxContextChars,
  );
}

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

/**
 * Build the findings prompt. The model receives the derived project model, the
 * PR identity/description and the exact perspective ids it may use, and must
 * reply with a single fenced JSON array of findings — each keyed to one of the
 * given perspective ids and backed by at least one piece of evidence.
 */
export function buildFindingsPrompt(input: {
  board: ReviewBoard;
  description: string | null;
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
    '## Perspectives you may file findings under',
    perspectiveMenu(board.perspectives),
    '',
    '## Response format',
    'Reply with ONLY a fenced ```json code block containing an array of',
    'findings. Each finding is an object:',
    '{',
    `  "perspectiveId": one of [${ids}],`,
    '  "title": short imperative headline,',
    '  "detail": 1-3 sentences explaining the concern and what to check,',
    '  "severity": one of "critical" | "high" | "medium" | "low" | "suggestion",',
    '  "evidence": [ { "source": what you looked at, "reason": why it supports',
    '    this finding, "confidence": 0..1 } ]',
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
    '## Response format',
    'Reply with ONLY a fenced ```json code block containing a single object:',
    '{',
    '  "skipped": boolean — true only if this lens does not apply,',
    '  "reason": string — required when skipped: why it does not apply,',
    '  "findings": [ {',
    '    "title": short imperative headline,',
    '    "detail": 1-3 sentences explaining the concern and what to check,',
    '    "severity": one of "critical" | "high" | "medium" | "low" | "suggestion",',
    '    "evidence": [ { "source": what you looked at, "reason": why it supports',
    '      this finding, "confidence": 0..1 } ]',
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

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
  ReviewFinding,
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
    'an empty findings array — but you MUST still populate a non-empty',
    '`rationale` and non-empty `checks` that prove, with concrete file/symbol',
    'references, exactly what you inspected and why the change is sound for this',
    'lens. An approved/clean verdict with an empty rationale or empty checks is',
    'INVALID: never assume "green" — always show the evidence you based it on.',
    'Do not add prose outside the code block.',
  ].join('\n');
}
/** The id of the Problem ↔ Solution lens, which gets a dedicated prompt. */
export const PROBLEM_SOLUTION_PERSPECTIVE_ID = 'problem-solution';

/**
 * The minimal per-file signal the solution digest needs. Kept structural (no
 * import from the pr-review contract) so this pure module stays decoupled.
 */
export interface SolutionNode {
  path: string;
  module: string | null;
  category: 'code' | 'test';
  kind: 'changed' | 'boundary';
  changeKind: string | null;
  /** What this PR changed in the file (distilled), when known. */
  whatChanged: string;
  /** What the file does independent of this PR, when known. */
  whatItDoes: string;
  /** The per-file unified diff, when available. */
  diff: string;
}

/** The best available per-file signal describing what the change did. */
function solutionNodeSignal(node: SolutionNode): string | null {
  const whatChanged = node.whatChanged.trim();
  if (whatChanged) return whatChanged;
  const diff = node.diff.trim();
  if (diff) return clamp(diff, 500);
  const whatItDoes = node.whatItDoes.trim();
  if (whatItDoes) return `Existing role: ${whatItDoes}`;
  return null;
}

/**
 * A general, holistic digest of what the PR *implements* — grouped material the
 * model synthesizes into a plain-English "solution implemented" narrative. It
 * deliberately carries per-file signal (distilled `whatChanged` or a bounded
 * diff) as raw evidence, but is fed to a prompt that forbids file-by-file
 * grading, so the model produces a general assessment rather than a file audit.
 */
export function buildSolutionDigest(input: {
  title: string;
  nodes: readonly SolutionNode[];
  maxChars: number;
}): string {
  const changed = input.nodes.filter((n) => n.kind === 'changed');
  if (changed.length === 0) {
    return '(no changed files were resolved from the change graph)';
  }
  const code = changed.filter((n) => n.category === 'code').length;
  const test = changed.length - code;
  const lines: string[] = [
    `PR "${input.title}" changes ${changed.length} file(s) — ${code} code, ${test} test.`,
    '',
  ];
  const shown = changed.slice(0, 60);
  for (const node of shown) {
    const suffix = node.changeKind ? ` — ${node.changeKind}` : '';
    const module = node.module ? ` (${node.module})` : '';
    lines.push(`- ${node.path}${module}${suffix}`);
    const signal = solutionNodeSignal(node);
    if (signal) lines.push(`  ${signal}`);
  }
  if (changed.length > shown.length) {
    lines.push(`- …and ${changed.length - shown.length} more changed file(s)`);
  }
  return clamp(lines.join('\n'), input.maxChars);
}

/**
 * Build the dedicated prompt for the **Problem ↔ Solution** lens. Unlike the
 * generic per-perspective prompt (which demands file/symbol-grounded findings),
 * this asks for a *general*, plain-English judgement: what problem the PR
 * targets (from the description + any linked work item + the distilled problem
 * statement), what the change implements as a solution, and — the crux —
 * whether the solution actually solves that problem. It never grades files one
 * by one; the verdict is about problem/solution alignment as a whole.
 */
export function buildProblemSolutionPrompt(input: {
  board: ReviewBoard;
  perspective: ReviewPerspective;
  description: string | null;
  problemStatement: string | null;
  problemSufficient: boolean;
  solutionDigest: string;
  config: { maxContextChars: number };
}): string {
  const { board } = input;
  // Keep each section modest so the assembled prompt stays under the cold-path
  // inline delivery threshold (a large attachment is blocked by some
  // environments' content-access policies). A general problem/solution
  // assessment does not need the full context budget.
  const sectionBudget = Math.min(input.config.maxContextChars, 6_000);
  const description = clamp(
    (input.description ?? '').trim() || '(no description provided)',
    sectionBudget,
  );
  const distilled =
    input.problemStatement && input.problemStatement.trim() && input.problemSufficient
      ? clamp(input.problemStatement.trim(), sectionBudget)
      : '(no self-contained problem statement could be distilled from the ' +
        'description — derive the problem from the description above and any ' +
        'linked work item it references)';
  return [
    'You are a staff engineer deciding one thing: does this pull request\'s',
    'solution actually solve the problem it set out to solve? Judge the change',
    'as a whole — a general, plain-English assessment. Do NOT evaluate files',
    'one by one and do NOT produce a file-by-file audit; this lens is about the',
    'problem and the solution, not individual lines.',
    '',
    '## Pull request',
    `- Number: #${board.pull.number}`,
    `- Title: ${board.pull.title}`,
    `- Files changed: ${board.changedFiles}`,
    '',
    '## The problem this PR targets',
    'Raw PR description (may embed a linked work item):',
    description,
    '',
    'Distilled problem statement:',
    distilled,
    '',
    '## What the PR implements (the solution)',
    'Synthesize a GENERAL description of the solution from the change below —',
    'what capability or behaviour it introduces or fixes. Do not list files.',
    input.solutionDigest,
    '',
    '## What to decide',
    '1. Problem: state, in plain language, the problem the PR is solving (from',
    '   the description + linked work item). Be specific about the user-facing',
    '   or system need — not a summary of the code.',
    '2. Solution implemented: describe generally what the change does to address',
    '   it — the approach, not a file list.',
    '3. Why they align: explain concretely why the solution does (or does not)',
    '   solve the stated problem. Call out any unaddressed requirement, scope',
    '   gap, or mismatch. This is the reasoning the reader most needs.',
    '4. Verdict: rate the alignment. Approve (low risk) only when the solution',
    '   clearly and fully addresses the problem. Raise the risk / needs-review',
    '   when there are gaps, and record each gap as a finding.',
    '',
    '## Response format',
    'Reply with ONLY a fenced ```json code block containing a single object:',
    '{',
    '  "skipped": false,',
    '  "summary": string — REQUIRED: one or two plain sentences of the form',
    '    "The problem is …; the solution …; they align because … (or the gap',
    '    is …), so it is rated <verdict>." No file names, no jargon dump,',
    '  "rationale": [  — REQUIRED: exactly these four steps, in this order,',
    '      each a concrete plain-English explanation (no file-by-file grading):',
    '    { "label": "Problem", "detail": the problem the PR targets },',
    '    { "label": "Solution implemented", "detail": what the change does },',
    '    { "label": "Why they align", "detail": why the solution does or does',
    '      not solve the problem, naming any gap },',
    '    { "label": "Verdict", "detail": the rating and the one-line reason } ],',
    '  "checks": [] — leave empty; this lens is general, not line-by-line,',
    '  "findings": [ {  — one per real gap where the solution fails to solve the',
    '      problem; empty when the solution fully solves it:',
    '    "title": short headline naming the unmet need or mismatch,',
    '    "detail": what part of the problem is not solved and what is missing,',
    '    "severity": one of "critical" | "high" | "medium" | "low" | "suggestion",',
    '    "evidence": [ { "source": the unmet requirement or the change area that',
    '      leaves it unmet, "reason": why it is unsolved, "confidence": 0..1 } ]',
    '  } ]',
    '}',
    'Never assume the change is fine: your "Why they align" MUST give the',
    'reasoning, so the reader never has to guess why it was approved. Do not add',
    'prose outside the code block.',
  ].join('\n');
}

/**
 * Render one finding for the agent's context, listing the evidence sources
 * (file paths / signals) it draws on so the agent can point the reviewer at the
 * concrete code a question refers to instead of asking "which code?".
 */
function renderChatFinding(f: ReviewFinding): string {
  const sources = f.evidence
    .map((e) => e.source)
    .filter((s) => s.trim().length > 0);
  const where =
    sources.length > 0 ? `\n   Evidence: ${sources.join(', ')}` : '';
  return `- [${f.severity}] ${f.title}: ${f.detail}${where}`;
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
          ? `Findings the reviewer is looking at:\n${perspective.findings
              .map((f) => renderChatFinding(f))
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
      ...ratingChangeProtocol(perspective),
      '## Conversation',
      transcript,
      '',
      'Assistant:',
    ].join('\n'),
    input.config.maxContextChars,
  );
}

/**
 * The instructions that let the agent *change* the focused perspective's rating
 * — but only when genuinely convinced by concrete, code-referenced evidence.
 * When no perspective is focused there is nothing to re-rate, so the protocol
 * is omitted entirely and the agent can only answer.
 */
function ratingChangeProtocol(
  perspective: ReviewPerspective | null,
): string[] {
  if (perspective === null) return [];
  return [
    '## Changing this rating',
    `The focused perspective "${perspective.name}" is currently rated`,
    `status="${perspective.status}", risk="${perspective.risk}". You MAY revise`,
    'that rating, but ONLY when the user has given you concrete, verifiable',
    'evidence — specific files/symbols and reasoning — that proves the current',
    'rating is wrong. Stay skeptical: do NOT change a rating on assertion,',
    'opinion, or pressure alone, and never invent evidence. If you are not',
    'convinced, keep the rating and explain, in prose, exactly what evidence',
    'would convince you.',
    '',
    'When — and only when — you are convinced, end your reply with a single',
    'fenced ```json object (and nothing after it):',
    '```json',
    '{',
    '  "status": one of "approved" | "needs-review" | "warning" | "blocked" |',
    '    "not-applicable",',
    '  "risk": one of "low" | "medium" | "high" | "critical" | "unknown",',
    '  "summary": one or two sentences stating what you re-checked to reach the',
    '    new rating, naming the specific files/symbols,',
    '  "rationale": [ { "label": step label, "detail": concrete, code-referenced',
    '    explanation } ]  — non-empty, justifying the new rating,',
    '  "justification": one sentence naming the exact evidence from this',
    '    discussion that changed your mind',
    '}',
    '```',
    'If you are NOT changing the rating, do not include any json block at all.',
    '',
  ];
}

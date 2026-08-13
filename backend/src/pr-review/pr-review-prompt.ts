import type { PrReviewConfig } from './config.js';
import type { PrReviewPull } from './pr-review-contract.js';
import {
  INSUFFICIENT_MARKER,
  PROBLEM_STATEMENT_HEADING,
} from './pr-review-parser.js';
import { changedTestMethodNames } from './test-method-diff.js';

/** Shared budgets for the text embedded in review prompts. */
export interface PrReviewPromptBudget {
  /** Character budget for the embedded repository context. */
  maxContextChars: number;
}

/** Substitutes every `{{key}}` placeholder in a template with its value. */
function applyTemplate(template: string, vars: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(vars)) {
    output = output.split(`{{${key}}}`).join(value);
  }
  return output;
}

function clamp(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function pullHeader(pull: PrReviewPull, baseBranch: string | null): string {
  return (
    `## Pull request\n- Number: #${pull.number}\n- Title: ${pull.title}\n` +
    `- URL: ${pull.url}\n- Base branch: ${baseBranch ?? 'unknown'}`
  );
}

/**
 * Step 1 — distil the problem statement strictly from the PR description. The
 * model must NOT invent a problem: when the description is empty or too thin it
 * replies with the `INSUFFICIENT:` marker and a one-line reason. The wording is
 * fully config-driven (see {@link PrReviewConfig.problemStatementPromptTemplate})
 * so it can be reviewed and tuned from the Settings page.
 */
export function buildProblemStatementPrompt(input: {
  pull: PrReviewPull;
  baseBranch: string | null;
  description: string | null;
  config: PrReviewConfig;
}): string {
  const { pull, baseBranch, description, config } = input;
  return applyTemplate(config.problemStatementPromptTemplate, {
    untrusted: config.untrustedNotice,
    pullHeader: pullHeader(pull, baseBranch),
    description: description?.trim() || config.emptyDescriptionPlaceholder,
    problemHeading: PROBLEM_STATEMENT_HEADING,
    insufficientMarker: INSUFFICIENT_MARKER,
  });
}

/**
 * Lazy per-file explanation — given a single changed file's diff, describe in
 * plain English what the file does in the codebase and what this PR changed in
 * it. Kept tiny and file-scoped so it runs fast on demand when a file is
 * clicked. The response is a strict JSON object so it parses deterministically.
 * All wording is config-driven so it can be reviewed and tuned from Settings.
 */
export function buildFileExplanationPrompt(input: {
  path: string;
  changeKind: string;
  problemStatement: string;
  diff: string;
  budget: PrReviewPromptBudget;
  config: PrReviewConfig;
  /** True for a test file — asks for a per-test-method change breakdown. */
  isTest?: boolean;
}): string {
  const { path, changeKind, problemStatement, diff, budget, config, isTest } =
    input;
  const methodNames = isTest ? changedTestMethodNames(diff) : [];
  const methodsShape = isTest ? config.fileExplanationMethodsShape : '';
  const methodsGuidance = isTest
    ? config.fileExplanationTestGuidance +
      (methodNames.length > 0
        ? applyTemplate(config.fileExplanationTestMethodsKnown, {
            methods: methodNames.map((name) => `"${name}"`).join(', '),
          })
        : config.fileExplanationTestMethodsUnknown)
    : '';
  return applyTemplate(config.fileExplanationPromptTemplate, {
    untrusted: config.untrustedNotice,
    path,
    changeKind,
    problemStatement,
    diff: clamp(diff.trim() || '(empty diff)', budget.maxContextChars),
    methodsShape,
    methodsGuidance,
  });
}

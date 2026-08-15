import type { PrReviewConfig } from './config.js';
import type {
  ChangeGraphCategory,
  ChangeGraphEdge,
  ChangeGraphNode,
  ChangeGraphProject,
  PrReviewChatMessage,
  PrReviewPull,
} from './pr-review-contract.js';
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

/**
 * Renders the change graph for one category as a compact, human-readable brief
 * the chat assistant grounds its answers on: the problem statement, the changed
 * files grouped under their module boxes (with any explanation already known),
 * the external callers, and the static references between changed files. Pure so
 * it is trivially testable and carries no IO.
 */
export function summarizeChangeGraph(input: {
  category: ChangeGraphCategory;
  problemStatement: string;
  projects: readonly ChangeGraphProject[];
  nodes: readonly ChangeGraphNode[];
  edges: readonly ChangeGraphEdge[];
}): string {
  const { category, problemStatement, projects, nodes, edges } = input;
  const inCategory = nodes.filter((n) => n.category === category);
  const changed = inCategory.filter((n) => n.kind === 'changed');
  const boundary = inCategory.filter((n) => n.kind === 'boundary');
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  const paths = new Set(inCategory.map((n) => n.path));

  const lines: string[] = [];
  lines.push(`## Change graph (${category})`);
  lines.push(`Problem statement: ${problemStatement}`);
  lines.push(
    `${changed.length} changed ${category === 'test' ? 'test' : 'code'} file(s) ` +
      `across ${new Set(changed.map((n) => n.projectId)).size} module(s).`,
  );

  const byProject = new Map<string, ChangeGraphNode[]>();
  for (const node of changed) {
    const bucket = byProject.get(node.projectId) ?? [];
    bucket.push(node);
    byProject.set(node.projectId, bucket);
  }
  lines.push('### Changed files by module');
  if (byProject.size === 0) {
    lines.push('- (none)');
  }
  for (const [projectId, files] of byProject) {
    lines.push(`- ${nameOf.get(projectId) ?? projectId} (${files.length} file(s)):`);
    for (const file of files) {
      const detail = file.whatChanged.trim();
      lines.push(
        `  - ${file.path} [${file.changeKind ?? 'changed'}]` +
          (detail ? ` — ${detail}` : ''),
      );
    }
  }

  lines.push('### External callers (files outside the diff that reference the change)');
  if (boundary.length === 0) {
    lines.push('- (none discovered)');
  }
  for (const node of boundary) {
    lines.push(`- ${node.path}`);
  }

  const shownEdges = edges.filter((e) => paths.has(e.from) && paths.has(e.to));
  lines.push('### References (from → to)');
  if (shownEdges.length === 0) {
    lines.push('- (none)');
  }
  for (const edge of shownEdges) {
    const symbols = edge.calls.map((c) => c.symbol).filter(Boolean);
    const via = symbols.length > 0 ? ` (uses ${[...new Set(symbols)].join(', ')})` : '';
    lines.push(`- ${edge.from} → ${edge.to}${via}`);
  }

  return lines.join('\n');
}

/** Formats prior chat turns for the {{conversation}} slot; empty → placeholder. */
function renderConversation(
  history: readonly PrReviewChatMessage[],
  placeholder: string,
): string {
  if (history.length === 0) {
    return placeholder;
  }
  return history
    .map((m) => `${m.role === 'user' ? 'Reviewer' : 'Assistant'}: ${m.content}`)
    .join('\n');
}

/**
 * Builds the tool-less prompt for one turn of the change-graph "explain this
 * diagram" chat. The graph is summarised into the prompt so the answer is
 * grounded strictly in the diagram; the last message is the question and the
 * earlier ones are the running conversation. All wording is config-driven so it
 * can be reviewed and tuned from the Settings page.
 */
export function buildChangeGraphChatPrompt(input: {
  category: ChangeGraphCategory;
  graphSummary: string;
  messages: readonly PrReviewChatMessage[];
  budget: PrReviewPromptBudget;
  config: PrReviewConfig;
}): string {
  const { category, graphSummary, messages, budget, config } = input;
  const history = messages.slice(0, -1);
  const question = messages[messages.length - 1]?.content ?? '';
  return applyTemplate(config.graphChatPromptTemplate, {
    untrusted: config.untrustedNotice,
    category,
    graphSummary: clamp(graphSummary, budget.maxContextChars),
    conversation: renderConversation(history, config.graphChatNoHistoryPlaceholder),
    question,
  });
}

import type {
  ChangeGraphCategory,
  ChangeGraphEdge,
  ChangeGraphStep,
  PrReview,
} from './pr-review-contract.js';

/**
 * Composes the Markdown block that AI Project Studio writes into a pull
 * request's description: the distilled problem statement plus the deterministic
 * change graph rendered as a Mermaid diagram (which GitHub and Azure DevOps both
 * render inline). The block is delimited by HTML-comment markers so it can be
 * re-applied idempotently — updating the block in place rather than appending a
 * new copy — while leaving the author's own description untouched.
 *
 * All functions here are pure and deterministic (no AI, no IO), so the exact
 * bytes written to the PR are unit-testable.
 */

export const PR_REVIEW_BLOCK_START =
  '<!-- ai-project-studio:pr-review:start -->';
export const PR_REVIEW_BLOCK_END = '<!-- ai-project-studio:pr-review:end -->';

/** Makes a string safe to embed inside a Mermaid `"..."` label. */
function sanitizeLabel(text: string): string {
  return text.replace(/"/g, "'").replace(/\s+/g, ' ').trim();
}

/** The final path segment of a repo-relative path. */
function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter((part) => part.length > 0);
  return segments[segments.length - 1] ?? path;
}

/** The label for an edge: its first call symbol, with a `+N` overflow count. */
function edgeLabel(edge: ChangeGraphEdge): string {
  if (edge.calls.length === 0) {
    return '';
  }
  const [first, ...rest] = edge.calls;
  const suffix = rest.length > 0 ? ` +${rest.length}` : '';
  return sanitizeLabel(`${first.symbol}${suffix}`);
}

/**
 * Renders the change graph for one category (code/test) as a Mermaid flowchart:
 * each project is a subgraph of its changed files, and directed edges carry the
 * referenced symbol. Returns an empty string when the category has no nodes.
 */
export function buildChangeGraphMermaid(
  graph: ChangeGraphStep,
  category: ChangeGraphCategory,
): string {
  const nodes = graph.nodes.filter((node) => node.category === category);
  if (nodes.length === 0) {
    return '';
  }
  const idByPath = new Map<string, string>();
  nodes.forEach((node, index) => idByPath.set(node.path, `n${index}`));

  const nameByProject = new Map(graph.projects.map((p) => [p.id, p.name]));
  const byProject = new Map<string, typeof nodes>();
  for (const node of nodes) {
    const list = byProject.get(node.projectId) ?? [];
    list.push(node);
    byProject.set(node.projectId, list);
  }

  const lines: string[] = ['flowchart LR'];
  let group = 0;
  for (const [projectId, list] of byProject) {
    const name = nameByProject.get(projectId) ?? projectId;
    lines.push(`  subgraph g${group}["${sanitizeLabel(name)}"]`);
    for (const node of list) {
      lines.push(`    ${idByPath.get(node.path)}["${sanitizeLabel(basename(node.path))}"]`);
    }
    lines.push('  end');
    group += 1;
  }
  for (const edge of graph.edges) {
    const from = idByPath.get(edge.from);
    const to = idByPath.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const label = edgeLabel(edge);
    lines.push(label ? `  ${from} -->|"${label}"| ${to}` : `  ${from} --> ${to}`);
  }
  return lines.join('\n');
}

/**
 * The Markdown section (without the delimiting markers) describing a review: its
 * problem statement and the code-change graph diagram when one is available.
 */
export function buildPrReviewSection(review: PrReview): string {
  const parts: string[] = ['## AI Project Studio review', '', '### Problem statement', ''];
  const problem = review.problemStatement;
  if (problem.content && problem.sufficient) {
    parts.push(problem.content.trim());
  } else {
    parts.push(
      '_The pull request description did not contain enough detail to derive a problem statement._',
    );
  }

  const mermaid = buildChangeGraphMermaid(review.changeGraph, 'code');
  if (mermaid) {
    parts.push('', '### Change graph', '', '```mermaid', mermaid, '```');
  }
  return parts.join('\n').trim();
}

/**
 * Inserts (or replaces) the managed review block inside an existing PR body,
 * preserving everything the author wrote outside the markers.
 */
export function upsertPrReviewBlock(body: string, section: string): string {
  const block = `${PR_REVIEW_BLOCK_START}\n${section}\n${PR_REVIEW_BLOCK_END}`;
  const start = body.indexOf(PR_REVIEW_BLOCK_START);
  const end = body.indexOf(PR_REVIEW_BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = body.slice(0, start);
    const after = body.slice(end + PR_REVIEW_BLOCK_END.length);
    return `${before.trimEnd()}\n${block}\n${after.trimStart()}`.trim();
  }
  const existing = body.trim();
  return existing ? `${existing}\n\n${block}` : block;
}

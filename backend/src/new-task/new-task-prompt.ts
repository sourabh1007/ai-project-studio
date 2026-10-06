/**
 * Pure prompt builders for the New Task agent.
 *
 * The agent takes a user's problem statement plus free-form context and drives
 * two AI turns: first a *planning* turn that produces a concrete, reviewable
 * implementation plan, then — once the user accepts it — an *implementation*
 * turn that actually edits the repository worktree. Both prompts are template
 * driven so the exact wording can be tuned from the agent's settings without a
 * code change; the dynamic problem/context/plan is injected here at run time.
 *
 * Keeping the builders pure lets the 100% coverage gate exercise every branch
 * without invoking a provider.
 */

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

/** Fallback text used when the user leaves the context blank. */
export const NO_CONTEXT_MARKER = '(no additional context provided)';

/** The default planning prompt. Placeholders: {{problem}}, {{context}}. */
export const DEFAULT_PLAN_PROMPT_TEMPLATE = [
  'You are an expert software engineer planning a change in this repository.',
  'Work only from the problem statement, the context, and the actual code you',
  'can read in the current working directory. Do NOT modify any files in this',
  'turn — produce a plan only.',
  '',
  'Problem statement:',
  '{{problem}}',
  '',
  'Additional context:',
  '{{context}}',
  '',
  'Investigate the relevant code, then write a SHORT plan a reviewer can approve',
  'at a glance. Be terse: use phrases, not paragraphs. No preamble, no filler, do',
  'not restate the problem. Group the work into a few small, clearly-labelled',
  'categories, each a few one-line steps, and explain structure with compact',
  'ASCII diagrams rather than prose. Use this shape:',
  '',
  '## Overview',
  'One or two sentences on the approach — no more. Then a small ASCII diagram of',
  'the overall flow or before→after, in a fenced code block, e.g.:',
  '```',
  'Request ─▶ Controller ─▶ Service ─▶ Repo',
  '                 │',
  '                 └─▶ emits event ─▶ UI',
  '```',
  '',
  '## <Category>  (group by area, e.g. Backend / UI / Data — 2 to 5 categories)',
  '1. `path/to/file` — what changes, in a short phrase.',
  '2. …',
  'Add a tiny ASCII diagram in a ``` code block ONLY when it makes a step clearer',
  '(a flow, a tree, or a before/after). Keep diagrams to a few lines — not art —',
  'and omit them where they add nothing.',
  '',
  '## Validation',
  '- How it is tested and what could break — one line each.',
  '',
  'Rules: keep every step to a single line; ground each path in a file that',
  'actually exists (or a new file the plan clearly adds); stay focused on the',
  'stated problem — no unrelated work.',
  '',
  'Finally, as the VERY LAST line of your response, output a single machine-read',
  'metadata comment EXACTLY in this form (and nothing after it):',
  '<!--NEWTASK-META {"title":"<=72 char imperative task title","summary":"1-2 sentence plain-English summary of the solution"} -->',
  'The title names the task (e.g. "Add retry to the upload client"); the summary',
  'describes what the change does. Keep both concise and free of markdown.',
].join('\n');

/**
 * Marker the planner appends so the service can lift a concise title + solution
 * summary out of the streamed plan. An HTML comment keeps it invisible in any
 * markdown viewer if a stray copy survives.
 */
const PLAN_META_RE = /<!--\s*NEWTASK-META\s*(\{[\s\S]*?\})\s*-->/g;

/** Strips every NEWTASK-META comment (even malformed ones) from the plan body. */
const PLAN_META_STRIP_RE = /<!--\s*NEWTASK-META[\s\S]*?-->/g;

/** The plan body plus the concise title/summary lifted from its meta trailer. */
export interface PlanResult {
  /** The plan markdown with the meta trailer removed. */
  plan: string;
  /** Concise task title, or null when the planner emitted none. */
  title: string | null;
  /** One-to-two sentence solution summary, or null when none was emitted. */
  summary: string | null;
}

/**
 * Lift the `NEWTASK-META` trailer (a title + solution summary) out of a planning
 * turn's output and return the plan body with every such marker stripped. The
 * last well-formed marker wins; malformed or absent markers degrade to null
 * fields so planning never breaks on a bad turn.
 */
export function parsePlanResult(raw: string): PlanResult {
  let title: string | null = null;
  let summary: string | null = null;
  for (const match of raw.matchAll(PLAN_META_RE)) {
    try {
      const parsed = JSON.parse(match[1]) as Record<string, unknown>;
      if (typeof parsed.title === 'string' && parsed.title.trim().length > 0) {
        title = parsed.title.trim();
      }
      if (
        typeof parsed.summary === 'string' &&
        parsed.summary.trim().length > 0
      ) {
        summary = parsed.summary.trim();
      }
    } catch {
      // Ignore a malformed marker and keep scanning for a valid one.
    }
  }
  const plan = raw.replace(PLAN_META_STRIP_RE, '').trim();
  return { plan, title, summary };
}

/**
 * The default implementation prompt. Placeholders: {{problem}}, {{context}},
 * {{plan}}.
 */
export const DEFAULT_IMPLEMENT_PROMPT_TEMPLATE = [
  'You are an expert software engineer implementing an approved change in this',
  'repository. The plan below was reviewed and accepted by the user — follow it.',
  'Make the actual code edits in the current working directory now.',
  '',
  'Problem statement:',
  '{{problem}}',
  '',
  'Additional context:',
  '{{context}}',
  '',
  'Approved plan:',
  '{{plan}}',
  '',
  'Implement the plan end to end: edit the necessary files, keep the change',
  'surgical and complete, follow the repository\'s existing conventions, and',
  'update directly-related tests or docs. Do NOT commit, push, or open a pull',
  'request — the tooling handles that. When you are done, end with a one-line',
  'summary of what you changed.',
].join('\n');

/** Render the planning prompt from the user's inputs. */
export function buildPlanPrompt(
  template: string,
  input: { problem: string; context: string; suggestion?: string },
): string {
  const context = input.context.trim();
  const suggestion = input.suggestion?.trim();
  const contextWithFeedback = suggestion
    ? `${context ? `${context}\n\n` : ''}Reviewer feedback on the previous plan to address:\n${suggestion}`
    : context;
  return applyTemplate(template, {
    problem: input.problem.trim(),
    context: contextWithFeedback || NO_CONTEXT_MARKER,
  });
}

/** Render the implementation prompt from the inputs plus the accepted plan. */
export function buildImplementPrompt(
  template: string,
  input: { problem: string; context: string; plan: string },
): string {
  return applyTemplate(template, {
    problem: input.problem.trim(),
    context: input.context.trim() || NO_CONTEXT_MARKER,
    plan: input.plan.trim(),
  });
}

/**
 * The default "clarify the problem statement" prompt. It does NOT touch the
 * repository and NEVER plans — it only helps the user sharpen their ask before
 * planning: it rewrites the problem statement to be clear and well-scoped, and
 * lists the concrete pieces of information that are still missing. The model
 * must answer as strict JSON so the service can parse it deterministically.
 * Placeholders: {{problem}}, {{context}}.
 */
export const DEFAULT_CLARIFY_PROMPT_TEMPLATE = [
  'You are an expert software engineer helping a user sharpen a task request',
  'BEFORE any planning or coding happens. Do NOT modify files, do NOT write a',
  'plan, and do NOT investigate the repository. Work only from the text below.',
  '',
  'Problem statement:',
  '{{problem}}',
  '',
  'Additional context:',
  '{{context}}',
  '',
  'Do two things:',
  '1. Rewrite the problem statement so it is clear, specific, and well-scoped —',
  '   a crisp paragraph an engineer could act on. Preserve the user\'s intent and',
  '   every concrete detail they gave (links, names, constraints). Do NOT invent',
  '   facts; if something is unknown, leave it out rather than guessing.',
  '2. List the specific pieces of information still MISSING that would make this',
  '   task unambiguous and ready to plan — e.g. affected files/modules, acceptance',
  '   criteria, constraints, edge cases, environments, or links. Each item is a',
  '   short noun phrase the user can answer, not a full sentence.',
  '',
  'Respond with STRICT JSON only — no markdown, no commentary — in exactly this',
  'shape:',
  '{',
  '  "improvedProblem": "the rewritten problem statement as a single string",',
  '  "missingInfo": ["short phrase", "short phrase", ...]',
  '}',
  'Return between 0 and 6 missingInfo items (omit any that are already answered).',
].join('\n');

/** The parsed result of a clarify turn. */
export interface ClarifyResult {
  improvedProblem: string;
  missingInfo: string[];
}

/** Render the clarify prompt from the user's current inputs. */
export function buildClarifyPrompt(
  template: string,
  input: { problem: string; context: string },
): string {
  return applyTemplate(template, {
    problem: input.problem.trim(),
    context: input.context.trim() || NO_CONTEXT_MARKER,
  });
}

/**
 * Parse the strict-JSON clarify response. The model occasionally wraps JSON in
 * prose or a ```json fence, so the first balanced `{…}` object is extracted
 * before parsing. Malformed output degrades gracefully to a usable result
 * (the original text as the improved statement, no missing-info items) so the
 * UI never breaks on a bad turn.
 */
export function parseClarifyResponse(
  raw: string,
  fallbackProblem: string,
): ClarifyResult {
  const empty: ClarifyResult = {
    improvedProblem: fallbackProblem.trim(),
    missingInfo: [],
  };
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return empty;
  }
  const record = parsed as Record<string, unknown>;
  const improved =
    typeof record.improvedProblem === 'string' &&
    record.improvedProblem.trim().length > 0
      ? record.improvedProblem.trim()
      : empty.improvedProblem;
  const missingInfo = Array.isArray(record.missingInfo)
    ? record.missingInfo
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];
  return { improvedProblem: improved, missingInfo };
}

/**
 * The default decomposition prompt for the manager agent. It reads the plan and
 * splits it into independent, file-disjoint slices so several worker agents can
 * implement it in parallel without clobbering each other. Placeholders:
 * {{problem}}, {{context}}, {{plan}}, {{maxWorkers}}.
 */
export const DEFAULT_DECOMPOSE_PROMPT_TEMPLATE = [
  'You are the lead agent orchestrating a team of specialized AI sub-agents about',
  'to implement an approved change in this repository. Do NOT edit any files in',
  'this turn. Read the plan and the actual code, then split the work into',
  'independent slices that sub-agents can implement in parallel.',
  '',
  'Problem statement:',
  '{{problem}}',
  '',
  'Additional context:',
  '{{context}}',
  '',
  'Approved plan:',
  '{{plan}}',
  '',
  'Rules for the split:',
  '- Produce between 1 and {{maxWorkers}} slices. Whenever the change touches',
  '  more than one file, split it into at least TWO slices so the work runs in',
  '  parallel; fall back to a single slice ONLY when the whole change is confined',
  '  to one file or the files are too tightly coupled to separate.',
  '- Each slice owns a DISJOINT set of files — no file may appear in two slices,',
  '  so sub-agents never edit the same file concurrently.',
  '- Group files that must change together (e.g. a module and its test) into the',
  '  same slice.',
  '- Assign each slice a specialization: "developer" for production/source code',
  '  work, or "tester" for slices that are primarily writing or updating tests.',
  '- Ground every path in a file that exists or a new file the plan clearly adds.',
  '',
  'Respond with ONLY a JSON object in a ```json code block, no prose, shaped:',
  '{"workers":[{"title":"short label","description":"what this slice does",',
  '"role":"developer","files":["repo/relative/path.ts"]}]}',
].join('\n');

/**
 * The default sub-agent prompt: implement one file-disjoint slice of the plan.
 * Placeholders: {{problem}}, {{context}}, {{plan}}, {{title}}, {{description}},
 * {{files}}, {{role}}.
 */
export const DEFAULT_WORKER_PROMPT_TEMPLATE = [
  'You are a {{role}} sub-agent on a team implementing an approved change in this',
  'repository. Several sub-agents are working in parallel in the SAME working',
  'directory, so you must edit ONLY the files assigned to you below. Do not',
  'touch any other file — another sub-agent owns it.',
  '',
  'Problem statement:',
  '{{problem}}',
  '',
  'Additional context:',
  '{{context}}',
  '',
  'Full approved plan (for context — implement only your slice):',
  '{{plan}}',
  '',
  'Your slice: {{title}}',
  '{{description}}',
  '',
  'Files you own (edit only these):',
  '{{files}}',
  '',
  'Implement your slice completely and surgically, following the repository\'s',
  'existing conventions. Do NOT build the whole repository, run the full test',
  'suite, commit, push, or open a pull request — the lead agent handles',
  'verification afterwards. End with a one-line summary of what you changed.',
].join('\n');

/**
 * The default lead-agent review prompt: integrate the sub-agents' changes, fix
 * any seams, and build ONLY the affected projects. Placeholders: {{problem}},
 * {{context}}, {{plan}}.
 */
export const DEFAULT_REVIEW_PROMPT_TEMPLATE = [
  'You are the lead agent reviewing the change your team of sub-agents just',
  'implemented in this repository worktree. The sub-agents edited their own files',
  'in parallel; your job is to integrate and verify the result.',
  '',
  'Problem statement:',
  '{{problem}}',
  '',
  'Additional context:',
  '{{context}}',
  '',
  'Approved plan:',
  '{{plan}}',
  '',
  'Do the following:',
  '- Inspect the combined changes (use git status/diff) and confirm they satisfy',
  '  the plan and fit together — fix any integration seams, missing wiring, or',
  '  inconsistencies between the slices.',
  '- Determine which project(s) actually contain the changed files and build and',
  '  test ONLY those project(s). Do NOT build or test the entire repository —',
  '  scope every build/test command to the changed project(s).',
  '- If a build or test fails, fix the cause and re-run just that project.',
  'Do NOT commit, push, or open a pull request — the tooling handles that. End',
  'with a one-line summary of what you verified and any fixes you made.',
].join('\n');

/** Render the manager decomposition prompt. */
export function buildDecomposePrompt(
  template: string,
  input: {
    problem: string;
    context: string;
    plan: string;
    maxWorkers: number;
  },
): string {
  return applyTemplate(template, {
    problem: input.problem.trim(),
    context: input.context.trim() || NO_CONTEXT_MARKER,
    plan: input.plan.trim(),
    maxWorkers: String(input.maxWorkers),
  });
}

/** Render a sub-agent prompt for one file-disjoint slice of the plan. */
export function buildWorkerPrompt(
  template: string,
  input: {
    problem: string;
    context: string;
    plan: string;
    title: string;
    description: string;
    files: string[];
    role: string;
  },
): string {
  const files =
    input.files.length > 0
      ? input.files.map((file) => `- ${file}`).join('\n')
      : '- (no specific files were assigned; implement the whole plan)';
  return applyTemplate(template, {
    problem: input.problem.trim(),
    context: input.context.trim() || NO_CONTEXT_MARKER,
    plan: input.plan.trim(),
    title: input.title.trim(),
    description: input.description.trim(),
    files,
    role: input.role.trim() || 'developer',
  });
}

/** Render the manager review/verify prompt. */
export function buildReviewPrompt(
  template: string,
  input: { problem: string; context: string; plan: string },
): string {
  return applyTemplate(template, {
    problem: input.problem.trim(),
    context: input.context.trim() || NO_CONTEXT_MARKER,
    plan: input.plan.trim(),
  });
}

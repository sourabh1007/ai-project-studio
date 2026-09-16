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
  'Investigate the relevant code, then write a clear, concrete implementation',
  'plan a reviewer can approve. Use short markdown sections:',
  '- "Summary": one paragraph on the approach.',
  '- "Files to change": a bullet per file with what changes and why.',
  '- "Steps": an ordered list of the edits to make.',
  '- "Risks & tests": how the change is validated and what could break.',
  'Ground every file path in something that actually exists. Keep it focused on',
  'solving the stated problem — no unrelated work.',
].join('\n');

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
  '- Produce between 1 and {{maxWorkers}} slices. Prefer fewer when the change',
  '  is small; only add a slice when it can proceed independently.',
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

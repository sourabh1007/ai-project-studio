import type { CreateSkillInput } from './skills-contract.js';

/**
 * A curated starter library of reusable skills seeded on first run so the
 * Skills view is useful out of the box. Each entry is an `instruction` skill
 * with a recommended scope: `feature` for project-wide context that should
 * apply to every session under a feature (coding standards, system design), and
 * `session` for one-off task context. Users can freely edit or delete these;
 * they are only seeded when the library is empty (see {@link seedBuiltinSkills}).
 */
export const BUILTIN_SKILLS: readonly CreateSkillInput[] = [
  {
    name: 'Project Discovery & Planning Questions',
    kind: 'instruction',
    recommendedScope: 'feature',
    instructions: [
      'Before planning a new project or feature, act as a product/tech lead and',
      'ask a focused, prioritized set of clarifying questions — do NOT start',
      'building until the picture is clear. Adapt the questions dynamically to',
      'what is already known; skip anything already answered and ask sharper',
      'follow-ups based on my replies. Cover, roughly in this order:',
      '',
      '1. Problem & goal: What problem are we solving, and what does success look',
      '   like? What is explicitly out of scope?',
      '2. Users & use cases: Who uses this, and what are the top 3 flows?',
      '3. Constraints: Deadlines, budget, team size, existing stack, must-use or',
      '   must-avoid technologies, compliance/regulatory needs.',
      '4. Scale & non-functional needs: Expected load, latency, availability,',
      '   security, privacy, and data-retention requirements.',
      '5. Data & integrations: Key entities, sources of truth, third-party',
      '   systems and APIs to integrate with.',
      '6. Risks & unknowns: Biggest technical risks and open questions.',
      '',
      'Ask no more than a handful of questions at a time. When enough is known,',
      'summarize the requirements as a short brief and confirm it with me before',
      'proposing a plan.',
    ].join('\n'),
  },
  {
    name: 'Research Kickoff Context',
    kind: 'instruction',
    recommendedScope: 'session',
    instructions: [
      'This session is for research/investigation, not implementation. Before',
      'diving in, establish and restate:',
      '',
      '- Objective: the single question this research must answer.',
      '- Key sub-questions: 3-5 concrete things to find out.',
      '- Sources: where to look (codebase, docs, web, prior art) and what counts',
      '  as authoritative.',
      '- Deliverable: the shape of the output (comparison table, recommendation,',
      '  design sketch).',
      '',
      'While researching: timebox the effort, cite sources for every non-obvious',
      'claim, and clearly separate verified facts from assumptions. Finish with a',
      'concise summary: findings, a recommendation with rationale, trade-offs,',
      'and any remaining open questions. Do not write production code unless I',
      'explicitly ask.',
    ].join('\n'),
  },
  {
    name: 'System Design Planning',
    kind: 'instruction',
    recommendedScope: 'feature',
    instructions: [
      'Before writing code for a non-trivial feature, produce a lightweight,',
      'iterative system design proportional to the scope. Include:',
      '',
      '1. Requirements: functional requirements plus non-functional ones (scale,',
      '   latency, availability, consistency, security).',
      '2. High-level architecture: the main components and how they interact',
      '   (a simple diagram-in-text or bullet flow is fine).',
      '3. Data model: key entities, relationships, and ownership.',
      '4. Interfaces/contracts: the important APIs, events, or function',
      '   signatures at the boundaries.',
      '5. Key flows: walk through the 1-2 most important end-to-end paths.',
      '6. Trade-offs & alternatives: what you chose and what you rejected, and',
      '   why.',
      '7. Failure modes & observability: how it degrades, and how we would know.',
      '8. Rollout: migration, backward compatibility, and a phased plan.',
      '',
      'Keep it concise; prefer the simplest design that meets the requirements.',
      'Confirm the design with me before implementing.',
    ].join('\n'),
  },
  {
    name: 'Coding Standards — General',
    kind: 'instruction',
    recommendedScope: 'any',
    instructions: [
      'Follow these language-agnostic engineering standards for all code:',
      '',
      '- Clarity first: descriptive names, small single-purpose functions, and',
      '  early returns over deep nesting.',
      '- Consistency: match the surrounding code style and use the project’s',
      '  existing linter/formatter rather than introducing new conventions.',
      '- Correctness: validate inputs at boundaries, handle errors explicitly',
      '  (never swallow them), and avoid off-by-one and null/undefined pitfalls.',
      '- Security: never hardcode secrets, sanitize external input, and apply',
      '  least privilege.',
      '- Tests: add or update tests for every behavior change; cover edge cases,',
      '  not just the happy path.',
      '- Comments: explain WHY when intent is non-obvious; do not narrate WHAT the',
      '  code already says.',
      '- Small changes: keep diffs focused and reviewable; do not refactor',
      '  unrelated code. Write clear, descriptive commit messages.',
    ].join('\n'),
  },
  {
    name: 'Coding Standards — TypeScript / JavaScript',
    kind: 'instruction',
    recommendedScope: 'feature',
    instructions: [
      'Apply industry-standard TypeScript/JavaScript conventions:',
      '',
      '- Use TypeScript in strict mode; avoid `any` (prefer `unknown` + narrowing',
      '  or precise types/interfaces).',
      '- Prefer `const`, immutability, and pure functions; avoid side effects at',
      '  module import time.',
      '- Use async/await over raw Promise chains; always handle rejections.',
      '- Handle null/undefined explicitly; enable and respect strict null checks.',
      '- Prefer named exports for shared modules; keep modules cohesive.',
      '- Lint and format with the project’s ESLint + Prettier config.',
      '- Model data with discriminated unions where it helps exhaustiveness.',
      '- Write tests with the project’s runner (e.g. Vitest/Jest) for new logic.',
    ].join('\n'),
  },
  {
    name: 'Coding Standards — Python',
    kind: 'instruction',
    recommendedScope: 'feature',
    instructions: [
      'Apply industry-standard Python conventions:',
      '',
      '- Follow PEP 8 style and PEP 257 docstrings; add type hints (PEP 484).',
      '- Format with `black` and lint with `ruff`/`flake8`; sort imports.',
      '- Prefer f-strings, comprehensions (in moderation), and `pathlib` over',
      '  os.path.',
      '- Use context managers (`with`) for resources; avoid mutable default',
      '  arguments.',
      '- Keep functions small and typed; raise specific exceptions, never bare',
      '  `except:`.',
      '- Use virtual environments; pin dependencies.',
      '- Write tests with `pytest`, including edge cases and error paths.',
    ].join('\n'),
  },
  {
    name: 'Coding Standards — Go',
    kind: 'instruction',
    recommendedScope: 'feature',
    instructions: [
      'Apply idiomatic Go conventions (Effective Go):',
      '',
      '- Format with `gofmt`/`goimports`; keep code `golangci-lint`-clean.',
      '- Handle every error explicitly; wrap with context using `fmt.Errorf`',
      '  ("%w") and check with errors.Is/As.',
      '- Keep interfaces small; accept interfaces, return concrete structs.',
      '- Pass `context.Context` as the first parameter for I/O and cancellation.',
      '- Avoid naked returns in long functions; name results only for clarity.',
      '- Prefer composition over inheritance-like patterns; avoid premature',
      '  abstraction.',
      '- Write table-driven tests with the standard `testing` package.',
    ].join('\n'),
  },
  {
    name: 'Coding Standards — Java',
    kind: 'instruction',
    recommendedScope: 'feature',
    instructions: [
      'Apply industry-standard Java conventions:',
      '',
      '- Follow the Google/Oracle style guide; format consistently and keep',
      '  Checkstyle/SpotBugs clean.',
      '- Favor immutability (`final` fields, immutable value objects) and',
      '  composition over inheritance.',
      '- Return `Optional` instead of null for absent values; validate arguments.',
      '- Use try-with-resources for closeables; never ignore exceptions.',
      '- Use dependency injection rather than static singletons.',
      '- Use Streams and generics where they improve readability, not to show off.',
      '- Write tests with JUnit 5 (and Mockito where appropriate).',
    ].join('\n'),
  },
  {
    name: 'Coding Standards — C# / .NET',
    kind: 'instruction',
    recommendedScope: 'feature',
    instructions: [
      'Apply industry-standard C#/.NET conventions:',
      '',
      '- Follow Microsoft’s C# conventions and the project’s .editorconfig;',
      '  enable analyzers and nullable reference types.',
      '- Use async/await for I/O and propagate `CancellationToken`; never',
      '  block on async (`.Result`/`.Wait()`).',
      '- Prefer `var` when the type is obvious; use expression-bodied members and',
      '  pattern matching where they aid clarity.',
      '- Dispose resources with `using`/`await using`; implement IDisposable',
      '  correctly.',
      '- Use records for immutable DTOs; keep LINQ readable.',
      '- Register dependencies via DI; avoid service-locator patterns.',
      '- Write tests with xUnit (or the project’s framework).',
    ].join('\n'),
  },
  {
    name: 'Before You Code',
    kind: 'instruction',
    recommendedScope: 'session',
    instructions: [
      'Run this quick checklist before writing code for a task in this session:',
      '',
      '1. Restate the task and its acceptance criteria in one or two sentences.',
      '2. Identify the smallest correct change that satisfies it.',
      '3. Locate the files, patterns, and conventions to follow; reuse existing',
      '   utilities instead of adding new ones.',
      '4. Plan the tests you will add or update, including edge and error cases.',
      '5. Note risks and anything that could break existing behavior.',
      '6. Implement in small steps, then run the build/lint/tests and confirm the',
      '   original goal is met with no unrelated changes.',
    ].join('\n'),
  },
  {
    name: 'Definition of Done',
    kind: 'instruction',
    recommendedScope: 'any',
    instructions: [
      'Treat work as complete only when it meets this bar — applies equally to a',
      'whole feature or a single session task:',
      '',
      '- Behavior: implemented and matches the request; edge and error cases',
      '  handled; no regressions in existing behavior.',
      '- Tests: added/updated for every behavior change and passing; coverage',
      '  gates (if any) are green.',
      '- Build & lint: the project builds and the linter/formatter are clean.',
      '- Scope: the diff is focused; no unrelated or drive-by changes.',
      '- Docs: user-facing or architectural docs updated when behavior changed.',
      '- Verification: reproduce the original goal/symptom and confirm the result',
      '  before declaring done — do not claim success without evidence.',
    ].join('\n'),
  },
];

/** Minimal service surface the seeder needs — a subset of SkillsService. */
export interface SkillSeedTarget {
  listSkills(): { name: string }[];
  createSkill(input: CreateSkillInput): unknown;
}

/**
 * Seeds the built-in starter library. A built-in is created only when no
 * existing skill shares its name, so the curated set appears alongside any
 * skills the user already has, never duplicates across restarts, and does not
 * fight a user who renames or edits a seeded skill. Returns the number seeded.
 */
export function seedBuiltinSkills(target: SkillSeedTarget): number {
  const existing = new Set(target.listSkills().map((s) => s.name));
  let seeded = 0;
  for (const skill of BUILTIN_SKILLS) {
    if (existing.has(skill.name)) {
      continue;
    }
    target.createSkill(skill);
    seeded += 1;
  }
  return seeded;
}

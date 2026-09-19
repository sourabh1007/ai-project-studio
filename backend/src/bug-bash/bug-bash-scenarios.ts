/**
 * Pure parsers for the Bug Bash agent's model responses.
 *
 * The analyst returns a JSON list of scenarios; each tester returns a JSON list
 * of per-scenario results. Both are pulled out of a possibly-fenced, possibly-
 * prose-wrapped response and validated with zod, with tolerant fallbacks so a
 * malformed response degrades gracefully instead of throwing. Keeping this pure
 * lets the 100% coverage gate exercise every branch without a provider.
 */

import { z } from 'zod';
import type {
  BugBashBlockedReason,
  BugBashScenario,
  BugBashScenarioStatus,
} from './bug-bash-contract.js';

/** A scenario as parsed from the analyst, before an id is assigned. */
export interface ParsedScenario {
  title: string;
  input: string;
  steps: string[];
  expectedOutput: string;
  confirmation: string;
}

/** A per-scenario result as parsed from a tester. */
export interface ParsedResult {
  id: string;
  status: BugBashScenarioStatus;
  observations: string;
  /** Whether the tester actually executed the steps. */
  ran: boolean;
  /** The concrete output/behaviour observed, empty when none reported. */
  actualOutput: string;
  /** For a blocked result, the category of blocker; null otherwise. */
  blockedReason: BugBashBlockedReason | null;
  /** Free-form diagnostic/telemetry detail, empty when none reported. */
  diagnostics: string;
  /** A runnable script/code to reproduce the scenario locally, empty when none. */
  reproScript: string;
}

/** A focus area as parsed from the lead analyst's decomposition turn. */
export interface ParsedArea {
  title: string;
  focus: string;
}

/** A prerequisite question as parsed from the analyst, before an id is assigned. */
export interface ParsedPrerequisite {
  question: string;
  detail: string;
  options: string[];
}

/**
 * Pull the first JSON object out of a model response, tolerating a ```json
 * fence and surrounding prose. Returns null when no object-shaped span exists.
 */
export function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  return candidate.slice(start, end + 1);
}

const scenariosSchema = z.object({
  scenarios: z.array(
    z.object({
      title: z.string(),
      input: z.string().optional(),
      steps: z.array(z.string()).optional(),
      expectedOutput: z.string().optional(),
      confirmation: z.string().optional(),
    }),
  ),
});

/**
 * Parse the analyst's scenario list. Blank titles are dropped (a scenario with
 * nothing to test is useless). Returns an empty array when the response can't be
 * parsed, so the caller can surface "no scenarios were generated" rather than
 * crash.
 */
export function parseScenarios(text: string): ParsedScenario[] {
  const json = extractJsonObject(text);
  if (!json) {
    return [];
  }
  let parsed: z.infer<typeof scenariosSchema>;
  try {
    parsed = scenariosSchema.parse(JSON.parse(json));
  } catch {
    return [];
  }
  const scenarios: ParsedScenario[] = [];
  for (const raw of parsed.scenarios) {
    const title = raw.title.trim();
    if (title.length === 0) {
      continue;
    }
    scenarios.push({
      title,
      input: (raw.input ?? '').trim(),
      steps: (raw.steps ?? [])
        .map((step) => step.trim())
        .filter((step) => step.length > 0),
      expectedOutput: (raw.expectedOutput ?? '').trim(),
      confirmation: (raw.confirmation ?? '').trim(),
    });
  }
  return scenarios;
}

const resultsSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['pass', 'fail', 'blocked']).optional(),
      observations: z.string().optional(),
      ran: z.boolean().optional(),
      actualOutput: z.string().optional(),
      blockedReason: z
        .enum(['permission', 'environment', 'tooling', 'other'])
        .optional(),
      diagnostics: z.string().optional(),
      reproScript: z.string().optional(),
    }),
  ),
});

/**
 * Parse a tester's per-scenario results. Entries without an id are dropped (they
 * cannot be matched back to a scenario). Returns an empty array when the
 * response can't be parsed, leaving the affected scenarios `blocked`.
 *
 * `ran` reflects whether the scenario *really* executed: the tester's claim
 * (explicit `ran`, or implied by a pass/fail verdict) is only trusted when it
 * is corroborated by concrete evidence — a non-empty `actualOutput` or
 * `diagnostics`. A verdict with no evidence is treated as not run, so an
 * unverified "pass" cannot masquerade as a genuine execution. `blockedReason`
 * only applies to a `blocked` result — it is forced to null otherwise and
 * defaults to `other` when a blocked result omits it.
 */
export function parseResults(text: string): ParsedResult[] {
  const json = extractJsonObject(text);
  if (!json) {
    return [];
  }
  let parsed: z.infer<typeof resultsSchema>;
  try {
    parsed = resultsSchema.parse(JSON.parse(json));
  } catch {
    return [];
  }
  const results: ParsedResult[] = [];
  for (const raw of parsed.results) {
    const id = raw.id.trim();
    if (id.length === 0) {
      continue;
    }
    const status = raw.status ?? 'blocked';
    const actualOutput = (raw.actualOutput ?? '').trim();
    const diagnostics = (raw.diagnostics ?? '').trim();
    const reproScript = (raw.reproScript ?? '').trim();
    // Only trust that a scenario really ran when the tester backs the verdict
    // with concrete evidence — an observed actual output or captured
    // diagnostics/telemetry. A pass/fail (or an explicit ran:true) with no
    // evidence is treated as not actually run, so an unverified "pass" surfaces
    // as PASS + NOT RUN instead of masquerading as a genuine execution.
    const claimedRun = raw.ran ?? (status === 'pass' || status === 'fail');
    const ran = claimedRun && (actualOutput !== '' || diagnostics !== '');
    const blockedReason =
      status === 'blocked' ? (raw.blockedReason ?? 'other') : null;
    results.push({
      id,
      status,
      observations: (raw.observations ?? '').trim(),
      ran,
      actualOutput,
      blockedReason,
      diagnostics,
      reproScript,
    });
  }
  return results;
}

/**
 * Audit one scenario's evidence, returning the corroborating artefacts a
 * `pass`/`fail` verdict is missing. This is the deterministic check the evidence
 * auditor (a developer/tech-PM role) runs so a verdict cannot ship without the
 * proof a developer needs to trust and replay it:
 *
 * - `actual output` — the concrete behaviour the tester observed.
 * - `diagnostics/logs` — the commands/logs/telemetry captured while running.
 * - `a repro script` — the runnable script a developer can execute locally.
 *
 * Only `pass`/`fail` verdicts require evidence; a `blocked` or `pending`
 * scenario never ran, so it returns no gaps. An empty result means the verdict
 * is fully evidenced.
 */
export function auditScenarioEvidence(
  scenario: Pick<
    BugBashScenario,
    'status' | 'actualOutput' | 'diagnostics' | 'reproScript'
  >,
): string[] {
  if (scenario.status !== 'pass' && scenario.status !== 'fail') {
    return [];
  }
  const gaps: string[] = [];
  if (scenario.actualOutput.trim() === '') {
    gaps.push('actual output');
  }
  if (scenario.diagnostics.trim() === '') {
    gaps.push('diagnostics/logs');
  }
  if (scenario.reproScript.trim() === '') {
    gaps.push('a repro script');
  }
  return gaps;
}

const areasSchema = z.object({
  areas: z.array(
    z.object({
      title: z.string(),
      focus: z.string().optional(),
    }),
  ),
});

/**
 * Parse the lead analyst's focus areas. Areas with a blank title are dropped;
 * a missing focus falls back to the title so the area still has something to
 * probe. Returns an empty array when the response can't be parsed, letting the
 * caller fall back to a single whole-feature analyst.
 */
export function parseAreas(text: string): ParsedArea[] {
  const json = extractJsonObject(text);
  if (!json) {
    return [];
  }
  let parsed: z.infer<typeof areasSchema>;
  try {
    parsed = areasSchema.parse(JSON.parse(json));
  } catch {
    return [];
  }
  const areas: ParsedArea[] = [];
  for (const raw of parsed.areas) {
    const title = raw.title.trim();
    if (title.length === 0) {
      continue;
    }
    areas.push({ title, focus: (raw.focus ?? '').trim() || title });
  }
  return areas;
}

const prerequisitesSchema = z.object({
  prerequisites: z.array(
    z.object({
      question: z.string(),
      detail: z.string().optional(),
      options: z.array(z.string()).optional(),
    }),
  ),
});

/**
 * Parse the analyst's dynamically-generated prerequisite questions. Entries with
 * a blank question are dropped (there is nothing to answer). Blank/duplicate
 * options are trimmed away so the UI only offers real choices. Returns an empty
 * array when the response can't be parsed, so the caller can surface "no
 * prerequisites were identified" rather than crash.
 */
export function parsePrerequisites(text: string): ParsedPrerequisite[] {
  const json = extractJsonObject(text);
  if (!json) {
    return [];
  }
  let parsed: z.infer<typeof prerequisitesSchema>;
  try {
    parsed = prerequisitesSchema.parse(JSON.parse(json));
  } catch {
    return [];
  }
  const prerequisites: ParsedPrerequisite[] = [];
  for (const raw of parsed.prerequisites) {
    const question = raw.question.trim();
    if (question.length === 0) {
      continue;
    }
    const options: string[] = [];
    for (const option of raw.options ?? []) {
      const trimmed = option.trim();
      if (trimmed.length > 0 && !options.includes(trimmed)) {
        options.push(trimmed);
      }
    }
    prerequisites.push({ question, detail: (raw.detail ?? '').trim(), options });
  }
  return prerequisites;
}

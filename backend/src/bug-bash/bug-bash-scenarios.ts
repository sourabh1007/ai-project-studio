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
import type { BugBashScenarioStatus } from './bug-bash-contract.js';

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
}

/** A focus area as parsed from the lead analyst's decomposition turn. */
export interface ParsedArea {
  title: string;
  focus: string;
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
    }),
  ),
});

/**
 * Parse a tester's per-scenario results. Entries without an id are dropped (they
 * cannot be matched back to a scenario). Returns an empty array when the
 * response can't be parsed, leaving the affected scenarios `blocked`.
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
    results.push({
      id,
      status: raw.status ?? 'blocked',
      observations: (raw.observations ?? '').trim(),
    });
  }
  return results;
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

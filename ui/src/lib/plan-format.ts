/**
 * Formatting helpers for a New Task plan.
 *
 * The planner often narrates its investigation ("I'll fetch the PRs, let me
 * read the manifests…") before the actual plan. That narrative is valuable
 * *live* — it streams into the Plan tab's analysis timeline — but it is noise
 * in the final, reviewable plan, which should start at the first heading
 * (e.g. `## Overview`). {@link stripPlanPreamble} drops everything before the
 * first markdown heading so the rendered plan is clean.
 */

/**
 * Remove any prose that precedes the first markdown ATX heading. A heading is a
 * line that starts with 1–6 `#` followed by whitespace, so inline `#(macro)` or
 * `#1` references are never mistaken for one. When the plan has no heading the
 * trimmed text is returned unchanged.
 */
export function stripPlanPreamble(plan: string): string {
  const text = (plan ?? '').trim();
  if (text.length === 0) return '';
  const match = text.match(/^#{1,6}[ \t]+\S/m);
  if (!match || match.index === undefined || match.index === 0) {
    return text;
  }
  return text.slice(match.index).trim();
}

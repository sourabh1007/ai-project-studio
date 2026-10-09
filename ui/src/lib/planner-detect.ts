/**
 * Heuristics that read a free-text Planner entry and decide what the user most
 * likely wants to do with it. The Planner surfaces the detected `primary`
 * action prominently and offers the others as secondary choices, so these rules
 * only need to pick the best default — never the only option.
 */

/** The three ways a task can be launched into the workspace. */
export type PlannerIntent = 'review' | 'agent' | 'session';

export interface DetectedIntent {
  /** The best-guess launch action for the typed text. */
  primary: PlannerIntent;
  /** A resolved pull-request number when the text clearly names one. */
  pullNumber: number | null;
}

/**
 * Extracts a pull-request number when the text carries a *strong* PR signal: a
 * GitHub/Azure DevOps pull URL, or a `PR`/`pull request`/`#` reference next to
 * a number. Unlike a loose "last number in the string" match, this avoids
 * treating incidental digits (years, counts) as pull requests.
 */
export function detectPullNumber(text: string): number | null {
  const value = text.trim();
  if (!value) {
    return null;
  }
  const url = value.match(/(?:pull|pullrequest|pull-request|pulls)\/(\d+)/i);
  if (url) {
    return Number(url[1]);
  }
  const labelled = value.match(
    /\b(?:pr|pull\s*request|mr|merge\s*request)\b[^\d]{0,6}#?(\d{1,7})\b/i,
  );
  if (labelled) {
    return Number(labelled[1]);
  }
  const hash = value.match(/(?:^|\s)#(\d{1,7})\b/);
  if (hash) {
    return Number(hash[1]);
  }
  return null;
}

/** Leading verbs that mark an entry as actionable work to plan with an agent. */
const ACTION_VERBS = [
  'add',
  'build',
  'configure',
  'create',
  'debug',
  'design',
  'document',
  'fix',
  'implement',
  'integrate',
  'investigate',
  'migrate',
  'optimize',
  'optimise',
  'plan',
  'refactor',
  'remove',
  'setup',
  'test',
  'update',
  'upgrade',
  'write',
];

/** Whether the text opens with an imperative work verb (e.g. "Fix the…"). */
export function startsWithActionVerb(text: string): boolean {
  const first = text.trim().toLowerCase().split(/\s+/)[0];
  const word = first.replace(/[^a-z]/g, '');
  return ACTION_VERBS.includes(word);
}

/**
 * Classifies a typed entry:
 * - a strong PR signal → `review` (Review Board);
 * - otherwise an imperative work item → `agent` (New Task planner);
 * - anything else → `session` (a plain working session).
 */
export function detectIntent(text: string): DetectedIntent {
  const pullNumber = detectPullNumber(text);
  if (pullNumber !== null) {
    return { primary: 'review', pullNumber };
  }
  if (startsWithActionVerb(text)) {
    return { primary: 'agent', pullNumber: null };
  }
  return { primary: 'session', pullNumber: null };
}

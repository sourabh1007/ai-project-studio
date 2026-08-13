/**
 * Pure intent parsing for the universal Ctrl+K bar. Kept free of React and DOM
 * APIs so command entry can be classified consistently in tests, UI components,
 * and any future keyboard-driven callers.
 */

/** AI-backed actions that the Ctrl+K bar can route to instead of command search. */
export type AiIntent =
  | 'explain-file'
  | 'analyze-repo'
  | 'review-pr'
  | 'find-dependency'
  | 'show-usage'
  | 'find-tests'
  | 'investigate-issue';

/** A plain command-palette search when no AI intent trigger is recognized. */
export interface CommandInputResult {
  /** Discriminant for command/fuzzy-search handling. */
  kind: 'command';
  /** Original-cased input after trimming surrounding whitespace. */
  query: string;
}

/** An AI intent request parsed from a recognized leading trigger phrase. */
export interface AiInputResult {
  /** Discriminant for AI-intent handling. */
  kind: 'ai';
  /** The normalized AI action requested by the trigger phrase. */
  intent: AiIntent;
  /** Original-cased text after the trigger phrase, trimmed for direct use. */
  argument: string;
  /** Original-cased input after trimming surrounding whitespace. */
  query: string;
}

/** Structured parse result for raw Ctrl+K input. */
export type CommandBarInput = CommandInputResult | AiInputResult;

/** A lowercased leading phrase that maps user text to an AI intent. */
export interface AiIntentTrigger {
  /** Lowercased phrase that must appear at the start of the trimmed query. */
  phrase: string;
  /** Intent selected when the phrase matches as a complete leading token group. */
  intent: AiIntent;
}

/**
 * Trigger phrases recognized by the Ctrl+K AI-intent parser, ordered by longest
 * phrase first so specific phrases like "find dependency" win before "find".
 */
export const AI_INTENT_TRIGGERS: readonly AiIntentTrigger[] = [
  { phrase: 'find dependency', intent: 'find-dependency' },
  { phrase: 'analyze repo', intent: 'analyze-repo' },
  { phrase: 'investigate', intent: 'investigate-issue' },
  { phrase: 'show usage', intent: 'show-usage' },
  { phrase: 'find tests', intent: 'find-tests' },
  { phrase: 'show tests', intent: 'find-tests' },
  { phrase: 'review pr', intent: 'review-pr' },
  { phrase: 'find dep', intent: 'find-dependency' },
  { phrase: 'explain', intent: 'explain-file' },
  { phrase: 'find', intent: 'find-dependency' },
] as const;

/**
 * Classifies raw Ctrl+K text as either command search or an AI intent. AI
 * triggers are case-insensitive, must start the trimmed query, and must be
 * followed by whitespace or the end of the string to avoid partial-word matches.
 */
export function parseCommandInput(raw: string): CommandBarInput {
  const query = raw.trim();
  if (query.length === 0) {
    return { kind: 'command', query: '' };
  }

  const lowerQuery = query.toLowerCase();
  for (const trigger of AI_INTENT_TRIGGERS) {
    if (startsWithTrigger(lowerQuery, trigger.phrase)) {
      return {
        kind: 'ai',
        intent: trigger.intent,
        argument: query.slice(trigger.phrase.length).trim(),
        query,
      };
    }
  }

  return { kind: 'command', query };
}

/** Returns the compact display label for a parsed AI intent. */
export function aiIntentLabel(intent: AiIntent): string {
  switch (intent) {
    case 'explain-file':
      return 'Explain file';
    case 'analyze-repo':
      return 'Analyze repo';
    case 'review-pr':
      return 'Review PR';
    case 'find-dependency':
      return 'Find dependency';
    case 'show-usage':
      return 'Show usage';
    case 'find-tests':
      return 'Find tests';
    case 'investigate-issue':
      return 'Investigate issue';
  }
}

function startsWithTrigger(query: string, trigger: string): boolean {
  return (
    query === trigger ||
    (query.startsWith(trigger) && query[trigger.length] === ' ')
  );
}

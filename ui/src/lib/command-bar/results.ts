import {
  type Command,
  filterCommands,
  fuzzyScore,
} from '../command-palette.js';
import {
  aiIntentLabel,
  type AiIntent,
  parseCommandInput,
} from './intent.js';

/** AI suggestion row shown above matching command-palette actions. */
export interface AiCommandBarResult {
  /** Discriminant for AI-intent result rendering. */
  kind: 'ai';
  /** Parsed AI action selected by the user's leading trigger phrase. */
  intent: AiIntent;
  /** Compact display label for the parsed intent. */
  label: string;
  /** Original-cased text after the trigger phrase, trimmed for direct use. */
  argument: string;
  /** Original-cased input after trimming surrounding whitespace. */
  query: string;
}

/** Command-palette row ranked by the existing fuzzy matcher. */
export interface PaletteCommandBarResult<T extends Command = Command> {
  /** Discriminant for command result rendering. */
  kind: 'command';
  /** Matching command from the caller's registry. */
  command: T;
  /** Fuzzy score for the trimmed query against the command title and keywords. */
  score: number;
}

/** A unified Ctrl+K result row, blending AI suggestions with command matches. */
export type CommandBarResult<T extends Command = Command> =
  | AiCommandBarResult
  | PaletteCommandBarResult<T>;

/** Ranking options for building a unified Ctrl+K result list. */
export interface CommandBarResultsOptions {
  /** Maximum number of rows to return across AI and command results. */
  limit?: number;
}

/**
 * Builds the unified Ctrl+K result list for raw input. AI-intent suggestions
 * rank first when present, followed by fuzzy-ranked command-palette matches.
 */
export function buildCommandBarResults<T extends Command>(
  raw: string,
  commands: readonly T[],
  options: CommandBarResultsOptions = {},
): Array<CommandBarResult<T>> {
  const parsed = parseCommandInput(raw);
  if (parsed.query.length === 0) {
    return [];
  }

  const limit = options.limit;
  if (limit !== undefined && limit <= 0) {
    return [];
  }

  const commandResults = filterCommands(commands, parsed.query).map((command) => ({
    kind: 'command' as const,
    command,
    score: scoreCommand(command, parsed.query),
  }));
  const results: Array<CommandBarResult<T>> =
    parsed.kind === 'ai'
      ? [
          {
            kind: 'ai',
            intent: parsed.intent,
            label: aiIntentLabel(parsed.intent),
            argument: parsed.argument,
            query: parsed.query,
          },
        ]
      : [];
  results.push(...commandResults);
  return limit === undefined ? results : results.slice(0, limit);
}

function scoreCommand(command: Command, query: string): number {
  return fuzzyScore(
    [command.title, ...(command.keywords ?? [])].join(' ').toLowerCase(),
    query.trim().toLowerCase(),
  ) as number;
}

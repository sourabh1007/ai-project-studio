/**
 * Shared core for the "refine chat" — a conversational agent that lets the user
 * challenge and edit an already-generated artifact (the Bug Bash test scenarios
 * or the New Task implementation plan) in plain language. The user asks for a
 * change or pushes back on the generated data; the agent replies and, when the
 * user asks for an edit, returns a revised artifact that replaces the old one.
 *
 * This module is deliberately artifact-agnostic and pure: it builds the prompt
 * and parses the response into `{ reply, revised }`, leaving each agent to
 * render its own artifact into text and interpret the `revised` payload with its
 * own parser. Keeping it pure lets the 100% coverage gate exercise every branch
 * without a provider.
 */

import { z } from 'zod';

/** One message in a refine conversation. */
export interface RefineChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The parsed outcome of one refine turn. */
export interface ParsedRefine {
  /** The assistant's markdown reply to show in the chat. */
  reply: string;
  /**
   * The revised artifact the agent proposes, or null when the turn only
   * answered/discussed without changing anything. Its shape is artifact-specific
   * (a `{scenarios:[…]}` object for Bug Bash, a markdown string for New Task), so
   * the caller interprets it with its own parser.
   */
  revised: unknown;
}

/**
 * The default refine prompt. Placeholders: {{artifactLabel}}, {{featureContext}},
 * {{artifact}}, {{revisedHint}}, {{transcript}}, {{message}}.
 */
export const DEFAULT_REFINE_PROMPT_TEMPLATE = [
  'You are a collaborative assistant helping a user refine the {{artifactLabel}}',
  'below before it is used. The user may challenge it, ask questions, or request',
  'changes. You can read the ACTUAL code in the current working directory to',
  'ground your answers. Do NOT modify any files.',
  '',
  'Context for the work:',
  '{{featureContext}}',
  '',
  'The current {{artifactLabel}} (this is what your edits replace):',
  '{{artifact}}',
  '',
  'Conversation so far:',
  '{{transcript}}',
  '',
  'The user just said:',
  '{{message}}',
  '',
  'Reply helpfully and specifically. When — and only when — the user asks for a',
  'change to the {{artifactLabel}}, produce the FULL revised version (not a diff)',
  'that incorporates it. If the user is only asking a question or discussing, do',
  'not change anything.',
  '',
  '{{revisedHint}}',
  '',
  'Respond with ONLY a JSON object in a ```json code block, no prose outside it,',
  'shaped: {"reply":"your markdown reply to the user","revised":<the full revised',
  'artifact, or null when nothing changed>}.',
].join('\n');

/**
 * Substitute every `{{key}}` placeholder in a template with its value. Missing
 * placeholders are left untouched so a partially-filled template still renders.
 */
export function applyRefineTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let output = template;
  for (const [key, value] of Object.entries(vars)) {
    output = output.split(`{{${key}}}`).join(value);
  }
  return output;
}

/** Render a conversation as a readable transcript for the prompt. */
export function renderTranscript(messages: RefineChatMessage[]): string {
  if (messages.length === 0) {
    return '(no messages yet)';
  }
  return messages
    .map((message) => {
      const who = message.role === 'user' ? 'User' : 'Assistant';
      return `${who}: ${message.content.trim()}`;
    })
    .join('\n');
}

/** Build the refine prompt for one turn. */
export function buildRefinePrompt(
  template: string,
  input: {
    artifactLabel: string;
    featureContext: string;
    artifact: string;
    revisedHint: string;
    messages: RefineChatMessage[];
    message: string;
  },
): string {
  return applyRefineTemplate(template, {
    artifactLabel: input.artifactLabel,
    featureContext: input.featureContext.trim() || '(none provided)',
    artifact: input.artifact.trim() || '(empty)',
    revisedHint: input.revisedHint.trim(),
    transcript: renderTranscript(input.messages),
    message: input.message.trim(),
  });
}

/**
 * Pull the first JSON object out of a model response, tolerating a ```json
 * fence and surrounding prose. Returns null when no object-shaped span exists.
 */
export function extractRefineJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  return candidate.slice(start, end + 1);
}

const refineSchema = z.object({
  reply: z.string(),
  revised: z.unknown().optional(),
});

/**
 * Parse a refine response into a reply + optional revised artifact. When the
 * response can't be parsed as the expected JSON, the whole text is treated as
 * the reply with no revision, so a conversational answer still reaches the user.
 */
export function parseRefineResponse(text: string): ParsedRefine {
  const json = extractRefineJson(text);
  if (json) {
    try {
      const parsed = refineSchema.parse(JSON.parse(json));
      const reply = parsed.reply.trim();
      return {
        reply: reply || text.trim(),
        revised: parsed.revised ?? null,
      };
    } catch {
      // Fall through to the plain-text fallback below.
    }
  }
  return { reply: text.trim(), revised: null };
}

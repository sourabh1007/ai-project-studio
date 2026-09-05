import type { MetaRunner } from '../meta/meta-runner.js';
import type { ConfigObject } from './config-contract.js';
import type { FieldMeta } from './config-schema-describe.js';

/** A single "explain this setting" request from the Settings UI. */
export interface SettingsAssistantRequest {
  /** Namespace the question is about (e.g. `meta`). */
  namespace: string;
  /** Specific setting key, when the question targets one field. */
  key?: string;
  /** The user's free-text question. */
  question: string;
}

/** AI helper that explains configuration settings and recommends values. */
export interface SettingsAssistant {
  /**
   * Answers a question about a configuration setting using the pre-built
   * {@link buildSettingsContext} block so the model is grounded in the setting's
   * real schema and current value rather than guessing.
   */
  ask(request: SettingsAssistantRequest, context: string): Promise<string>;
}

export interface SettingsAssistantDeps {
  /** The AI primitive used to answer; only `run` is needed. */
  ai: Pick<MetaRunner, 'run'>;
  /** Optional per-request timeout override (ms) for the explanation turn. */
  timeoutMs?: number;
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return '(unset)';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value.length > 0 ? value : '(empty string)';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function detailLines(meta: FieldMeta): string[] {
  const lines: string[] = [];
  const typeBits: string[] = [meta.kind];
  if (meta.int) {
    typeBits.push('integer');
  }
  if (meta.optional) {
    typeBits.push('optional');
  }
  if (meta.nullable) {
    typeBits.push('nullable');
  }
  lines.push(`Type: ${typeBits.join(', ')}`);
  lines.push(`Description: ${meta.description ?? 'No description provided.'}`);
  if (meta.options && meta.options.length > 0) {
    lines.push(`Allowed values: ${meta.options.join(', ')}`);
  }
  if (meta.min !== undefined || meta.max !== undefined) {
    const min = meta.min ?? 'no minimum';
    const max = meta.max ?? 'no maximum';
    lines.push(`Range: ${min} to ${max}`);
  }
  if (meta.default !== undefined) {
    lines.push(`Default: ${formatValue(meta.default)}`);
  }
  return lines;
}

/**
 * Renders a compact, human-readable description of a setting (or a whole
 * namespace) from its schema metadata and current value. This is the grounding
 * the AI answers from, so it can never invent a setting or a bound that does
 * not exist.
 */
export function buildSettingsContext(
  schema: Record<string, FieldMeta>,
  current: ConfigObject,
  namespace: string,
  key?: string,
): string {
  const nsMeta = schema[namespace];
  const fields = nsMeta?.kind === 'object' ? (nsMeta.fields ?? {}) : {};
  const currentNs = (current[namespace] ?? {}) as Record<string, unknown>;

  if (key) {
    const meta = fields[key];
    if (!meta) {
      return [
        `Namespace: ${namespace}`,
        `Setting: ${namespace}.${key}`,
        '(No schema metadata is available for this setting.)',
        `Current value: ${formatValue(currentNs[key])}`,
      ].join('\n');
    }
    return [
      `Namespace: ${namespace}`,
      `Setting: ${namespace}.${key}`,
      ...detailLines(meta),
      `Current value: ${formatValue(currentNs[key])}`,
    ].join('\n');
  }

  const keys = Object.keys(fields);
  if (keys.length === 0) {
    return [
      `Namespace: ${namespace}`,
      '(No schema metadata is available for this namespace.)',
    ].join('\n');
  }
  const lines = [`Namespace: ${namespace}`, 'Settings in this namespace:'];
  for (const k of keys) {
    const meta = fields[k];
    const desc = meta.description ? ` — ${meta.description}` : '';
    lines.push(`- ${k} (${meta.kind}): current ${formatValue(currentNs[k])}${desc}`);
  }
  return lines.join('\n');
}

/**
 * Builds the grounding prompt: the assistant persona, strict instructions to
 * answer only from the supplied context, the context block, and the user's
 * question.
 */
export function buildSettingsPrompt(
  request: SettingsAssistantRequest,
  context: string,
): string {
  return [
    'You are a configuration assistant embedded in "Agency", an AI Project Studio desktop IDE.',
    'A user is on the Settings screen and needs help understanding a configuration setting and choosing a good value.',
    "Using ONLY the setting details below, answer the user's question: explain what the setting does, the trade-offs of different values, and recommend a sensible value for a typical user. If the details are insufficient to answer, say so and state what is missing. Be concise (under ~200 words), use plain language, and do not invent settings, bounds, or values that are not shown.",
    '',
    'Setting details:',
    context,
    '',
    `User question: ${request.question}`,
  ].join('\n');
}

/**
 * Creates the settings assistant: a thin wrapper over the {@link MetaRunner}
 * that runs a tool-free, internally-scoped completion so it returns quickly and
 * its usage is attributed to IDE infrastructure rather than a feature.
 */
export function createSettingsAssistant(
  deps: SettingsAssistantDeps,
): SettingsAssistant {
  return {
    async ask(request, context) {
      const target = request.key
        ? `${request.namespace}.${request.key}`
        : request.namespace;
      const answer = await deps.ai.run({
        featureId: 'settings-assistant',
        prompt: buildSettingsPrompt(request, context),
        noTools: true,
        scope: 'internal',
        purpose: 'general',
        label: `Settings assistant · ${target}`,
        timeoutMs: deps.timeoutMs,
      });
      return answer.trim();
    },
  };
}

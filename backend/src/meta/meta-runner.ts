import type { SessionLauncher } from '../session/session-launcher.js';
import type { SessionScope } from '../session/session-contract.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { MetaConfig } from './config.js';
import { extractResponseText } from './meta-response-extractor.js';
import type { Transcript } from '../session/transcript-capture.js';

const MAX_PROVIDER_FAILURE_CHARS = 500;

function safeFailureText(value: string): string {
  const normalized = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > MAX_PROVIDER_FAILURE_CHARS
    ? `${normalized.slice(0, MAX_PROVIDER_FAILURE_CHARS - 1)}…`
    : normalized;
}

function sessionError(line: string): string | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type !== 'session.error' || typeof event.data !== 'object' || !event.data) {
      return null;
    }
    const data = event.data as Record<string, unknown>;
    for (const key of ['message', 'error', 'content']) {
      if (typeof data[key] === 'string' && data[key].trim()) return data[key] as string;
    }
  } catch {
    return null;
  }
  return null;
}

function providerFailure(transcript: Transcript | null, exitCode: number | null): Error {
  const eventErrors = (transcript?.stdout ?? [])
    .flatMap((chunk) => chunk.split(/\r?\n/))
    .map(sessionError)
    .filter((message): message is string => message !== null);
  const stderr = (transcript?.stderr ?? []).filter((line) => line.trim().length > 0);
  const detail = safeFailureText(eventErrors.at(-1) ?? stderr.at(-1) ?? '');
  const code = exitCode === null ? '' : ` (exit code ${exitCode})`;
  return new Error(`Provider failed${code}${detail ? `: ${detail}` : ''}`);
}

export interface MetaRunnerDeps {
  launcher: SessionLauncher;
  transcripts: TranscriptStore;
  config: MetaConfig;
}

/** A single headless AI request: a prompt run against a feature's context. */
export interface MetaRequest {
  /**
   * Usage attribution partition. Feature work uses its feature id; internal
   * repository analysis may use a stable repository-derived id.
   */
  featureId: string;
  prompt: string;
  /** Absolute paths attached to the provider's initial prompt. */
  attachments?: readonly string[];
  /** Working directory used by the provider CLI for repository-aware work. */
  cwd?: string;
  /**
   * Internal scope keeps infrastructure runs out of feature session views
   * while their `meta` usage remains part of IDE AI accounting.
   */
  scope?: SessionScope;
}

/**
 * Reusable "AI" primitive: launches a headless `meta` CLI session for a prompt,
 * awaits completion, and returns the extracted assistant response text. Factored
 * out so every AI feature (summaries, task plans, …) shares one config-driven
 * flow instead of duplicating the launcher/extractor plumbing. Meta sessions are
 * excluded from dev-cost rollups by the aggregation module.
 */
export interface MetaRunner {
  run(request: MetaRequest): Promise<string>;
}

export function createMetaRunner(deps: MetaRunnerDeps): MetaRunner {
  return {
    async run(request) {
      const launched = await deps.launcher.start({
        featureId: request.featureId,
        providerId: deps.config.providerId,
        model: deps.config.model,
        prompt: request.prompt,
        attachments: request.attachments,
        kind: 'meta',
        cwd: request.cwd,
        scope: request.scope,
      });
      const ended = await launched.completion;
      const transcript = await deps.transcripts.load(ended.id);
      if (ended.status === 'failed' || (ended.exitCode !== null && ended.exitCode !== 0)) {
        throw providerFailure(transcript, ended.exitCode);
      }
      return extractResponseText(transcript, deps.config.responseTextKeys);
    },
  };
}

import type { CiPipelineCheckSpec } from './automation-contract.js';

/**
 * Thin IO ports the automation engine depends on. Concrete adapters (real
 * `child_process`, `fetch`, CI gateways, meta-runner) are wired in `main.ts`;
 * the engine logic depends only on these interfaces so every decision branch is
 * unit-tested with in-memory fakes.
 */

/** Runs a shell command and returns its exit code + captured streams. */
export interface ShellExecutor {
  exec(
    command: string,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Performs a single HTTP request and returns the status + body text. */
export interface HttpProbe {
  fetch(
    url: string,
    method: 'GET' | 'POST',
    signal?: AbortSignal,
  ): Promise<{ status: number; body: string }>;
}

/** Runs a headless AI turn, returning the text and the backing session id. */
export interface AiInvoker {
  run(input: {
    featureId: string;
    prompt: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; sessionId: string }>;
}

/** A single CI run's normalized state. */
export interface CiPipelineRun {
  id: string;
  status: string;
  conclusion: string | null;
}

/** Looks up the latest CI run matching a {@link CiPipelineCheckSpec}. */
export interface CiPipelineProbe {
  latestRun(spec: CiPipelineCheckSpec): Promise<CiPipelineRun | null>;
}

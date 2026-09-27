import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { McpAuthenticationJob, McpServerEntry } from './mcp-contract.js';
import { nativeAuthenticationPrompt, nativeAuthenticationRequired } from './native-mcp-auth.js';

export interface McpAuthenticationJobs {
  start(input: {
    owner: string;
    serverName: string;
    run: (signal: AbortSignal, progress: (output: readonly string[]) => void) => Promise<McpServerEntry>;
  }): McpAuthenticationJob;
  get(owner: string, id: string): McpAuthenticationJob;
  cancel(owner: string, id: string): McpAuthenticationJob;
  close(): void;
}

export function createMcpAuthenticationJobs(deps: {
  id: () => string;
  now: () => number;
  timeoutMs: number;
  maxConcurrent: number;
  maxRetained: number;
}): McpAuthenticationJobs {
  let closed = false;
  const jobs = new Map<string, {
    owner: string; value: McpAuthenticationJob; abort: AbortController; timer: ReturnType<typeof setTimeout>;
  }>();
  function get(owner: string, id: string) {
    const job = jobs.get(id);
    if (!job || job.owner !== owner) throw new NotFoundError('This native authentication job is unavailable. Start a new explicit check.');
    return job;
  }
  function finish(job: ReturnType<typeof get>, status: McpAuthenticationJob['status'], message: string): void {
    if (job.value.status !== 'pending') return;
    clearTimeout(job.timer);
    job.value = { ...job.value, status, message, authUrl: null, deviceCode: null };
    job.abort.abort();
  }
  return {
    start(input) {
      if (closed) throw new ValidationError('Native authentication is shutting down.');
      const pending = [...jobs.values()].filter((job) => job.value.status === 'pending');
      if (pending.length >= deps.maxConcurrent || pending.some((job) => job.owner === input.owner)) {
        throw new ValidationError('Native authentication is already pending or at capacity. Complete or cancel it before starting another.');
      }
      for (const [id, job] of jobs) {
        if (jobs.size < deps.maxRetained) break;
        if (job.value.status !== 'pending') jobs.delete(id);
      }
      const id = deps.id();
      const job = {
        owner: input.owner,
        abort: new AbortController(),
        value: {
          id, serverName: input.serverName, status: 'pending' as const,
          message: 'The native proxy is running for this explicit authentication and tool-discovery attempt.',
          authUrl: null, deviceCode: null,
          expiresAt: new Date(deps.now() + deps.timeoutMs).toISOString(),
        } as McpAuthenticationJob,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      job.timer = setTimeout(() => finish(job, 'failed', 'Native authentication timed out. The process was cancelled and its challenge is no longer active. No automatic retry was performed.'), deps.timeoutMs);
      job.timer.unref();
      jobs.set(id, job);
      void Promise.resolve().then(async () => {
        if (job.value.status !== 'pending') return;
        const server = await input.run(job.abort.signal, (output) => {
          if (job.value.status !== 'pending') return;
          const prompt = nativeAuthenticationPrompt(output);
          const message = prompt.authUrl
            ? 'Complete the live sign-in challenge while this native process is running.'
            : nativeAuthenticationRequired(null, output)
              ? 'The native provider requires sign-in. Complete its sign-in window if one was opened; no safe embedded challenge was reported.'
              : job.value.message;
          job.value = { ...job.value, ...prompt, message };
        });
        if (job.value.status !== 'pending') return;
        const ok = server.toolDiscovery?.status === 'ok';
        finish(job, ok ? 'completed' : 'failed', ok
          ? 'Native tool inventory completed. Authorization for individual tool calls has not been verified.'
          : 'The native proxy ended without successful tool discovery. Its challenge is no longer active; no automatic retry was performed.');
        job.value.server = server;
      }).catch(() => finish(job, 'failed', 'The native proxy could not complete authentication and tool discovery. Diagnostic output is withheld because it may contain credentials.'));
      return structuredClone(job.value);
    },
    get: (owner, id) => structuredClone(get(owner, id).value),
    cancel(owner, id) {
      const job = get(owner, id);
      finish(job, 'cancelled', 'Native authentication was cancelled. The process and its challenge are no longer active.');
      return structuredClone(job.value);
    },
    close() {
      closed = true;
      for (const job of jobs.values()) finish(job, 'cancelled', 'Application shutdown cancelled native authentication and invalidated its challenge.');
    },
  };
}

import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { McpAuthenticationJob, McpServerEntry } from './mcp-contract.js';
import { nativeAuthenticationPrompt, nativeAuthenticationRequired, NATIVE_AUTH_INTERRUPTED_MESSAGE } from './native-mcp-auth.js';

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
    running: boolean;
    stopping?: { status: 'failed' | 'cancelled'; message: string };
  }>();
  function get(owner: string, id: string) {
    const job = jobs.get(id);
    if (!job || job.owner !== owner) throw new NotFoundError('This native authentication job is unavailable. Start a new explicit check.');
    return job;
  }
  function finish(job: ReturnType<typeof get>, status: McpAuthenticationJob['status'], message: string): void {
    clearTimeout(job.timer);
    job.value = { ...job.value, status, message, authUrl: null, deviceCode: null };
    job.abort.abort();
  }
  function stop(job: ReturnType<typeof get>, status: 'failed' | 'cancelled', message: string): void {
    if (job.value.status !== 'pending' || job.stopping) return;
    clearTimeout(job.timer);
    if (!job.running) { finish(job, status, message); return; }
    job.stopping = { status, message };
    job.value = { ...job.value, authUrl: null, deviceCode: null,
      message: 'Cancellation requested. Waiting for native process cleanup acknowledgement; capacity remains reserved.' };
    job.abort.abort();
  }
  return {
    start(input) {
      if (closed) throw new ValidationError('Native authentication is shutting down.');
      const pending = [...jobs.values()].filter((job) => job.running || job.value.status === 'pending');
      if (pending.length >= deps.maxConcurrent || pending.some((job) => job.owner === input.owner)) {
        throw new ValidationError('Native authentication is already pending or at capacity. Complete or cancel it before starting another.');
      }
      for (const [id, job] of jobs) {
        if (jobs.size < deps.maxRetained) break;
        if (!job.running && job.value.status !== 'pending') jobs.delete(id);
      }
      const id = deps.id();
      const job = {
        owner: input.owner,
        running: false,
        abort: new AbortController(),
        value: {
          id, serverName: input.serverName, status: 'pending' as const,
          message: 'The native proxy is running for this explicit authentication and tool-discovery attempt.',
          authUrl: null, deviceCode: null,
          expiresAt: new Date(deps.now() + deps.timeoutMs).toISOString(),
        } as McpAuthenticationJob,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      } as ReturnType<typeof get>;
      job.timer = setTimeout(() => stop(job, 'failed', 'Native authentication timed out. Native process cleanup was acknowledged. No automatic retry was performed.'), deps.timeoutMs);
      job.timer.unref();
      jobs.set(id, job);
      void Promise.resolve().then(async () => {
        if (job.value.status !== 'pending') return;
        job.running = true;
        let challengeObserved = false;
        const server = await input.run(job.abort.signal, (output) => {
          if (job.value.status !== 'pending' || job.stopping) return;
          const prompt = nativeAuthenticationPrompt(output);
          challengeObserved ||= prompt.authUrl !== null;
          const message = prompt.authUrl
            ? 'Complete the live sign-in challenge while this native process is running.'
            : nativeAuthenticationRequired(null, output)
              ? 'The native provider requires sign-in. Complete its sign-in window if one was opened; no safe embedded challenge was reported.'
              : job.value.message;
          job.value = { ...job.value, ...prompt, message };
        });
        if (server.toolDiscovery?.cleanupUnconfirmed) {
          job.value = { ...job.value, authUrl: null, deviceCode: null,
            message: 'Native process cleanup could not be acknowledged. Capacity remains reserved; restart the application before another attempt.' };
          return;
        }
        job.running = false;
        if (job.stopping) {
          finish(job, job.stopping.status, job.stopping.message);
          return;
        }
        const interrupted = server.toolDiscovery?.authenticationInterrupted === true ||
          (challengeObserved && server.toolDiscovery?.status === 'ok');
        const ok = server.toolDiscovery?.status === 'ok' && !interrupted;
        finish(job, ok ? 'completed' : 'failed', interrupted ? NATIVE_AUTH_INTERRUPTED_MESSAGE : ok
          ? 'Native tool inventory completed. Authorization for individual tool calls has not been verified.'
          : 'The native proxy ended without successful tool discovery. Its challenge is no longer active; no automatic retry was performed.');
        job.value.server = server;
      }).catch(() => {
        finish(job, 'failed', 'The native proxy could not complete authentication and tool discovery. Cleanup was not acknowledged; capacity remains reserved until restart. Diagnostic output is withheld because it may contain credentials.');
      });
      return structuredClone(job.value);
    },
    get: (owner, id) => structuredClone(get(owner, id).value),
    cancel(owner, id) {
      const job = get(owner, id);
      stop(job, 'cancelled', 'Native authentication was cancelled. Native process cleanup was acknowledged.');
      return structuredClone(job.value);
    },
    close() {
      closed = true;
      for (const job of jobs.values()) stop(job, 'cancelled', 'Application shutdown cancelled native authentication after cleanup acknowledgement.');
    },
  };
}

import type { McpConfigFileStore, McpHealAttempt, McpServerStatus, McpToolInspector } from './mcp-contract.js';
import type { McpConfigWrites } from './mcp-config-writes.js';

const SERVER = 'ai-project-studio';
type Spec = Record<string, unknown>;
export interface StudioMcpHealthDeps {
  /** Always rebuilt from the current app lifecycle, never from an arbitrary provider entry. */
  launch: () => Spec | null;
  tools: McpToolInspector;
  files: McpConfigFileStore;
  writes: McpConfigWrites;
  registrationPaths: string[];
  timeoutMs: number;
  hostGet: (url: string, token: string, timeoutMs: number) => Promise<{ status: number; body: unknown }>;
}

export interface StudioMcpRegistrationDeps {
  files: McpConfigFileStore;
  writes: McpConfigWrites;
  registrationPaths: string[];
}

function object(value: unknown): value is Spec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envOf(spec: Spec): Spec {
  return object(spec.env) ? spec.env : {};
}

function owns(spec: unknown): spec is Spec {
  return object(spec) && typeof spec.command === 'string' &&
    Array.isArray(spec.args) && spec.args.some((arg) => typeof arg === 'string' && arg.includes('studio-mcp-server.js')) &&
    typeof envOf(spec).STUDIO_API_BASE === 'string' && typeof envOf(spec).STUDIO_CONTROL_TOKEN === 'string';
}

function sameLaunch(stored: Spec, canonical: Spec): boolean {
  return stored.command === canonical.command && JSON.stringify(stored.args) === JSON.stringify(canonical.args) &&
    Object.entries(envOf(canonical)).every(([key, value]) => envOf(stored)[key] === value);
}

function failure(message: string, attempts: McpHealAttempt[]): McpServerStatus {
  return { name: SERVER, status: 'error', toolCount: 0, authRequired: false, authUrl: null, message, healAttempts: attempts };
}

/**
 * Startup reconciliation for the app-owned Studio bridge registration. Unlike
 * the on-demand health probe below, this intentionally creates/replaces the
 * fixed `ai-project-studio` entry so each app lifecycle publishes its current
 * API port, token and launch argv before any standalone CLI reads the file.
 */
export async function reconcileStudioMcpRegistrations(
  deps: StudioMcpRegistrationDeps,
  canonical: Spec,
): Promise<McpHealAttempt[]> {
  const attempts: McpHealAttempt[] = [];
  for (const path of deps.registrationPaths) {
    await deps.writes.run(path, async () => {
      const document = (await deps.files.read(path)) ?? {};
      if (document.mcpServers !== undefined && !object(document.mcpServers)) {
        throw new Error('MCP servers map is malformed.');
      }
      const servers = object(document.mcpServers) ? document.mcpServers : {};
      const stored = servers[SERVER];
      if (JSON.stringify(stored) === JSON.stringify(canonical)) {
        return;
      }
      await deps.files.write(path, {
        ...document,
        mcpServers: {
          ...servers,
          [SERVER]: canonical,
        },
      });
      attempts.push({
        action: 'Reconciled app-owned Studio MCP launch configuration',
        outcome: 'info',
        detail: 'The global Studio bridge entry was rewritten with this app lifecycle\'s current launch command, API port and control token.',
      });
    });
  }
  return attempts;
}

/** Explicit app-owned check only: repair recognized stale registration, then bounded protocol/host verification. */
export function createStudioMcpHealth(deps: StudioMcpHealthDeps): () => Promise<McpServerStatus> {
  let active = false;
  const execute = async (signal: AbortSignal): Promise<McpServerStatus> => {
    const canonical = deps.launch();
    if (!canonical) return failure('The app bridge launch configuration is not ready.', []);
    const attempts: McpHealAttempt[] = [];
    const env = envOf(canonical);
    if (typeof env.STUDIO_API_BASE !== 'string' || !env.STUDIO_API_BASE.trim() ||
        typeof env.STUDIO_CONTROL_TOKEN !== 'string' || !env.STUDIO_CONTROL_TOKEN.trim()) {
      return failure('The app bridge is missing its current host address or control token.', attempts);
    }
    try {
      for (const path of deps.registrationPaths) {
        await deps.writes.run(path, async () => {
          signal.throwIfAborted();
          const document = await deps.files.read(path);
          signal.throwIfAborted();
          const stored = document?.mcpServers?.[SERVER];
          if (stored === undefined) return;
          if (!owns(stored)) throw new Error('The existing Studio registration is not a recognized app-owned launch. It was not overwritten.');
          if (sameLaunch(stored, canonical)) return;
          document!.mcpServers![SERVER] = { ...stored, ...canonical, env: { ...envOf(stored), ...env } };
          await deps.files.write(path, document!);
          attempts.push({
            action: 'Refreshed stale app-owned launch configuration',
            outcome: 'info',
            detail: 'Only the existing Studio bridge launch fields were refreshed from this app lifecycle. Other servers and settings were preserved.',
          });
        });
      }
    } catch {
      return failure('Studio registration could not be safely read or refreshed. No unrecognized registration was replaced; inspect the configuration file.', attempts);
    }
    let message = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        signal.throwIfAborted();
        const inspection = await deps.tools.inspect({ serverName: SERVER, spec: canonical, timeoutMs: deps.timeoutMs, signal });
        signal.throwIfAborted();
        if (inspection.status !== 'ok') {
          message = [inspection.message, ...inspection.output.slice(0, 3)].filter(Boolean).join(' ') ||
            'The Studio MCP protocol probe failed without diagnostic output.';
        } else if (!inspection.tools.some((tool) => tool.name === 'list_automations')) {
          message = 'The launched process did not advertise the expected Studio bridge tools.';
        } else {
          const response = await deps.hostGet(
            `${env.STUDIO_API_BASE.replace(/\/+$/, '')}/mcp/bridge-health`,
            env.STUDIO_CONTROL_TOKEN,
            deps.timeoutMs,
          );
          signal.throwIfAborted();
          if (response.status === 200 && object(response.body) && response.body.status === 'ok' && response.body.server === SERVER) {
            attempts.push({ action: 'Verified Studio MCP protocol and authenticated host', outcome: 'recovered', detail: null });
            return {
              name: SERVER, status: 'connected', toolCount: inspection.tools.length, authRequired: false, authUrl: null,
              message: 'Independent Studio bridge protocol and current authenticated app host verified. This does not assert the state of any running CLI session.',
              healAttempts: attempts,
            };
          }
          message = `Studio bridge host verification failed (HTTP ${response.status}). ` +
            (response.status === 404 ? 'The running backend does not expose bridge health verification; load the updated app before retrying.' :
              'Check that the app host and its current control token belong to the same app lifecycle.');
        }
      } catch {
        message = 'Studio bridge launch or authenticated host request failed or timed out.';
      }
      message = message.split(env.STUDIO_CONTROL_TOKEN).join('[redacted]').slice(0, 800);
      attempts.push({
        action: attempt === 0 ? 'Probed Studio bridge' : 'Retried Studio bridge with current app launch configuration',
        outcome: 'failed', detail: message,
      });
    }
    return failure(message, attempts);
  };
  return async () => {
    if (active) return failure('A Studio bridge verification is already in progress. No additional recovery work was queued.', []);
    active = true;
    const controller = new AbortController();
    const totalMs = Math.min(8_000, deps.timeoutMs * 4 + 1_000);
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<McpServerStatus>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(failure(`Studio bridge verification exceeded its ${totalMs}ms total deadline. No additional probes or configuration repairs will be started.`, []));
      }, totalMs);
    });
    const work = execute(controller.signal).finally(() => { active = false; });
    try { return await Promise.race([work, deadline]); }
    finally { clearTimeout(timer!); }
  };
}

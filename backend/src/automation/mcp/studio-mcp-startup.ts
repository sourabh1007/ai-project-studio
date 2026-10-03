import { STUDIO_CONTROL_TOKEN_HEADER } from './studio-mcp-tools.js';

export const STUDIO_MCP_SERVER_NAME = 'ai-project-studio';
export const STUDIO_MCP_CONFIG_HINT = '~/.copilot/mcp-config.json';

export function studioMcpMissingConfigMessage(): string {
  return 'AI Project Studio MCP is missing STUDIO_API_BASE or STUDIO_CONTROL_TOKEN. ' +
    `Start or restart AI Project Studio to enable its MCP tools, or remove the "${STUDIO_MCP_SERVER_NAME}" entry from ${STUDIO_MCP_CONFIG_HINT}.`;
}

export function studioMcpUnavailableMessage(apiBase: string): string {
  return `AI Project Studio isn't running or its saved MCP bridge endpoint is stale (${apiBase}). ` +
    `Start or restart AI Project Studio to enable its MCP tools, or remove the "${STUDIO_MCP_SERVER_NAME}" entry from ${STUDIO_MCP_CONFIG_HINT}.`;
}

export interface StudioApiAvailabilityDeps {
  apiBase: string;
  controlToken: string;
  fetch: typeof fetch;
  timeoutMs: number;
}

function healthUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/u, '')}/mcp/bridge-health`;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function checkStudioApiAvailability(
  deps: StudioApiAvailabilityDeps,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await deps.fetch(healthUrl(deps.apiBase), {
      headers: { [STUDIO_CONTROL_TOKEN_HEADER]: deps.controlToken },
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    const body = await response.json().catch(() => null) as unknown;
    if (response.status === 200 && object(body) && body.status === 'ok' && body.server === STUDIO_MCP_SERVER_NAME) {
      return { ok: true };
    }
  } catch {
    // The actionable message below intentionally avoids echoing implementation
    // details from the failed request and never includes the control token.
  }
  return { ok: false, message: studioMcpUnavailableMessage(deps.apiBase) };
}

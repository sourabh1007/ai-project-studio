import type { McpMeterSnapshot } from './mcp-proxy-meter.js';

/**
 * Shape POSTed by the proxy to the control API when a wrapped MCP server exits.
 * Every field is a real measured or configured value — the proxy never
 * estimates. Attribution (`featureId`/`sessionId`) is inherited from the CLI
 * process env, which the CLI forwards to MCP children.
 */
export interface McpUsageReport {
  provider: string;
  server: string;
  featureId: string;
  sessionId: string | null;
  calls: number;
  inputBytes: number;
  outputBytes: number;
  durationMs: number;
}

/** Endpoint suffix (appended to STUDIO_API_BASE) the proxy posts usage to. */
export const MCP_USAGE_ENDPOINT = '/mcp-usage';

type Env = Record<string, string | undefined>;

function trimmed(value: string | undefined): string | null {
  const out = value?.trim();
  return out ? out : null;
}

/**
 * Builds the usage report from the proxy's environment and measured snapshot,
 * or returns null when it cannot be truthfully attributed (no feature id) or
 * when nothing happened (no calls and no bytes). Returning null makes the proxy
 * silently skip the report rather than record mis-attributed data.
 */
export function buildMcpUsageReport(
  env: Env,
  snapshot: McpMeterSnapshot,
): McpUsageReport | null {
  const featureId = trimmed(env.STUDIO_FEATURE_ID);
  const server = trimmed(env.STUDIO_MCP_SERVER);
  const provider = trimmed(env.STUDIO_MCP_PROVIDER);
  if (!featureId || !server || !provider) {
    return null;
  }
  if (
    snapshot.calls === 0 &&
    snapshot.inputBytes === 0 &&
    snapshot.outputBytes === 0
  ) {
    return null;
  }
  return {
    provider,
    server,
    featureId,
    sessionId: trimmed(env.STUDIO_SESSION_ID),
    calls: snapshot.calls,
    inputBytes: snapshot.inputBytes,
    outputBytes: snapshot.outputBytes,
    durationMs: snapshot.durationMs,
  };
}

/**
 * Posts a measured usage report to the control API. Best-effort: any failure is
 * swallowed so a reporting problem can never affect the user's MCP server.
 */
export async function postMcpUsage(
  fetchImpl: typeof fetch,
  env: Env,
  snapshot: McpMeterSnapshot,
): Promise<boolean> {
  const report = buildMcpUsageReport(env, snapshot);
  const apiBase = trimmed(env.STUDIO_API_BASE);
  const controlToken = trimmed(env.STUDIO_CONTROL_TOKEN);
  if (!report || !apiBase || !controlToken) {
    return false;
  }
  try {
    await fetchImpl(`${apiBase}${MCP_USAGE_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-studio-control-token': controlToken,
      },
      body: JSON.stringify(report),
    });
    return true;
  } catch {
    return false;
  }
}

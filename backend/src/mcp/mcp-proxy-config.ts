/**
 * Pure helpers that wrap a configured MCP server's launch spec so it starts
 * through the measuring proxy instead of directly. The wrap is loss-less and
 * idempotent: the entire original spec is stashed (JSON) under
 * `STUDIO_MCP_ORIGINAL`, so {@link unwrapServerSpec} restores it exactly and a
 * second {@link wrapServerSpec} never double-wraps.
 *
 * Only stdio servers (those launched via a `command`) can be proxied; URL-based
 * (`http`/`sse`) servers are returned unchanged so the user's config is never
 * broken.
 */

/** Env key holding the JSON of the original, unwrapped spec. */
export const MCP_PROXY_ORIGINAL_ENV = 'STUDIO_MCP_ORIGINAL';
/** Env key the proxy reads to know which server it is fronting. */
export const MCP_PROXY_SERVER_ENV = 'STUDIO_MCP_SERVER';
/** Env key the proxy reads for the owning provider id. */
export const MCP_PROXY_PROVIDER_ENV = 'STUDIO_MCP_PROVIDER';

type Spec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Spec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function specEnv(spec: Spec): Record<string, string> {
  const env = spec.env;
  if (!isPlainObject(env)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

/** A spec can be proxied only when it launches a real command over stdio. */
export function isWrappableServer(spec: unknown): spec is Spec {
  return (
    isPlainObject(spec) &&
    typeof spec.command === 'string' &&
    spec.command.trim().length > 0
  );
}

/** True when the spec has already been wrapped by {@link wrapServerSpec}. */
export function isWrappedServer(spec: unknown): boolean {
  return isPlainObject(spec) && typeof specEnv(spec)[MCP_PROXY_ORIGINAL_ENV] === 'string';
}

/** Restores the original spec stashed at wrap time, or returns the spec as-is. */
export function unwrapServerSpec(spec: Spec): Spec {
  const original = specEnv(spec)[MCP_PROXY_ORIGINAL_ENV];
  if (typeof original !== 'string') {
    return spec;
  }
  try {
    const parsed = JSON.parse(original) as unknown;
    return isPlainObject(parsed) ? parsed : spec;
  } catch {
    // A corrupt stash must never lose the running config; keep the wrapped spec.
    return spec;
  }
}

export interface WrapContext {
  /** Node/Electron binary that will run the proxy script. */
  nodePath: string;
  /** Absolute path to the compiled proxy entry script. */
  proxyScript: string;
  /** Provider id owning this server (attribution). */
  provider: string;
  /** Server name exactly as configured under `mcpServers`. */
  serverName: string;
  /** Control API base URL the proxy posts measured usage to. */
  apiBase: string;
  /** Control token authorizing the proxy's usage POST. */
  controlToken: string;
  /** Platform to target when rendering the provider-facing command. */
  platform?: NodeJS.Platform;
  /** Windows command interpreter used when the executable path needs quoting. */
  windowsShell?: string;
}

function quoteWindowsCommandArg(arg: string): string {
  if (arg.length === 0) {
    return '""';
  }
  if (!/[\s"]/u.test(arg)) {
    return arg;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1);
      quoted += char;
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes);
    quoted += char;
    backslashes = 0;
  }
  quoted += '\\'.repeat(backslashes * 2);
  quoted += '"';
  return quoted;
}

/**
 * Some Windows MCP clients hand the configured command line to `cmd.exe`
 * without quoting the executable. If the direct command lives under
 * `C:\Program Files`, startup fails as `'C:\Program' is not recognized`.
 * Use a stable shell command only when quoting is required, keeping the
 * non-Windows and no-space cases unchanged.
 */
export function providerLaunchSpec(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  windowsShell: string = process.env.ComSpec ?? 'cmd.exe',
): { command: string; args: string[] } {
  if (platform !== 'win32' || ![command, ...args].some((arg) => /\s/u.test(arg))) {
    return { command, args };
  }
  return {
    command: windowsShell,
    args: [
      '/d',
      '/s',
      '/c',
      [command, ...args].map(quoteWindowsCommandArg).join(' '),
    ],
  };
}

/**
 * Wraps a stdio server spec so the CLI launches the proxy, which in turn spawns
 * the real command. Non-stdio specs are returned unchanged. Idempotent: a spec
 * that is already wrapped is first unwrapped, so re-wrapping with fresh
 * per-launch values (api base, token) never nests proxies.
 */
export function wrapServerSpec(spec: Spec, ctx: WrapContext): Spec {
  if (!isWrappableServer(spec)) {
    return spec;
  }
  const original = isWrappedServer(spec) ? unwrapServerSpec(spec) : spec;
  const originalArgs = Array.isArray(original.args)
    ? original.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  const launch = providerLaunchSpec(
    ctx.nodePath,
    [ctx.proxyScript, original.command as string, ...originalArgs],
    ctx.platform,
    ctx.windowsShell,
  );
  return {
    ...original,
    command: launch.command,
    args: launch.args,
    env: {
      ...specEnv(original),
      // execPath may be the Electron binary when packaged; run it as plain Node.
      ELECTRON_RUN_AS_NODE: '1',
      [MCP_PROXY_SERVER_ENV]: ctx.serverName,
      [MCP_PROXY_PROVIDER_ENV]: ctx.provider,
      STUDIO_API_BASE: ctx.apiBase,
      STUDIO_CONTROL_TOKEN: ctx.controlToken,
      [MCP_PROXY_ORIGINAL_ENV]: JSON.stringify(original),
    },
  };
}
